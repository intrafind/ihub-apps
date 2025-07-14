import { readFileSync, existsSync, readdirSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from './pathUtils.js';
import { modelConfigSchema, knownModelKeys } from './validators/modelConfigSchema.js';

function validateModelConfig(model, source) {
    const { success, error } = modelConfigSchema.safeParse(model);
    if (!success && error) {
        const messages = error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
        console.warn(`⚠️  Validation issues in ${source}: ${messages}`);
    }

    const unknown = Object.keys(model).filter(key => !knownModelKeys.includes(key));
    if (unknown.length > 0) {
        console.warn(`⚠️  Unknown keys in ${source}: ${unknown.join(', ')}`);
    }
}

/**
 * Models Loader Service
 * 
 * This service loads models from both individual files in contents/models/ 
 * and the legacy models.json file for backward compatibility.
 * 
 * Features:
 * - Loads individual model files from contents/models/
 * - Backward compatible with contents/config/models.json
 * - Filters out disabled models
 * - Handles missing enabled field (defaults to true)
 * - Ensures exactly one default model
 */

/**
 * Load models from individual files in contents/models/
 * @returns {Array} Array of model objects
 */
export async function loadModelsFromFiles() {
    const rootDir = getRootDir();
    const modelsDir = join(rootDir, 'contents', 'models');
    
    if (!existsSync(modelsDir)) {
        console.log('📁 Models directory not found, skipping individual model files');
        return [];
    }
    
    const models = [];
    const dirContents = await fs.readdir(modelsDir);
    const files = dirContents.filter(file => file.endsWith('.json'));
    
    console.log(`🤖 Loading ${files.length} individual model files...`);
    
    for (const file of files) {
        try {
            const filePath = join(modelsDir, file);
            const fileContent = await fs.readFile(filePath, 'utf8');
            const model = JSON.parse(fileContent);

            // Add enabled field if it doesn't exist (defaults to true)
            if (model.enabled === undefined) {
                model.enabled = true;
            }

            validateModelConfig(model, filePath);
            models.push(model);
            console.log(`✅ Loaded ${model.id} (${model.enabled ? 'enabled' : 'disabled'})`);
        } catch (error) {
            console.error(`❌ Error loading model from ${file}:`, error.message);
        }
    }
    
    return models;
}

/**
 * Load models from legacy models.json file
 * @returns {Array} Array of model objects
 */
export async function loadModelsFromLegacyFile() {
    const rootDir = getRootDir();
    const legacyModelsPath = join(rootDir, 'contents', 'config', 'models.json');
    
    if (!existsSync(legacyModelsPath)) {
        console.log('📄 Legacy models.json not found, skipping');
        return [];
    }
    
    try {
        const fileContent = await fs.readFile(legacyModelsPath, 'utf8');
        const models = JSON.parse(fileContent);
        
        console.log(`📄 Loading ${models.length} models from legacy models.json...`);
        
        // Add enabled field if it doesn't exist (defaults to true)
        models.forEach((model, idx) => {
            if (model.enabled === undefined) {
                model.enabled = true;
            }
            validateModelConfig(model, `${legacyModelsPath}[${idx}]`);
        });

        return models;
    } catch (error) {
        console.error('❌ Error loading legacy models.json:', error.message);
        return [];
    }
}

/**
 * Ensure exactly one default model
 * @param {Array} models - Array of model objects
 * @returns {Array} Array of models with exactly one default
 */
function ensureOneDefaultModel(models) {
    const defaultModels = models.filter(model => model.default === true);
    
    if (defaultModels.length === 0) {
        // No default model found, set the first enabled model as default
        const enabledModels = models.filter(model => model.enabled === true);
        if (enabledModels.length > 0) {
            enabledModels[0].default = true;
            console.log(`🎯 Set ${enabledModels[0].id} as default model (no default was configured)`);
        }
    } else if (defaultModels.length > 1) {
        // Multiple default models found, keep only the first one
        console.warn(`⚠️ Multiple default models found, keeping only ${defaultModels[0].id}`);
        for (let i = 1; i < defaultModels.length; i++) {
            defaultModels[i].default = false;
        }
    }
    
    return models;
}

/**
 * Load all models from both sources
 * Individual files take precedence over legacy models.json
 * @param {boolean} includeDisabled - Whether to include disabled models
 * @returns {Array} Array of model objects
 */
export async function loadAllModels(includeDisabled = false) {
    const individualModels = await loadModelsFromFiles();
    const legacyModels = await loadModelsFromLegacyFile();
    
    // Create a map to track models by ID
    const modelsMap = new Map();
    
    // Add legacy models first
    legacyModels.forEach(model => {
        modelsMap.set(model.id, model);
    });
    
    // Individual files override legacy models
    individualModels.forEach(model => {
        modelsMap.set(model.id, model);
    });
    
    // Convert map to array and filter models
    const allModels = Array.from(modelsMap.values());
    const filteredModels = allModels.filter(model => model.enabled === true || includeDisabled);
    
    // Ensure exactly one default model
    const processedModels = ensureOneDefaultModel(filteredModels);
    
    console.log(`🤖 Total models loaded: ${allModels.length}, Enabled: ${processedModels.filter(m => m.enabled).length}, Disabled: ${allModels.length - processedModels.filter(m => m.enabled).length}, Include Disabled: ${includeDisabled}`);
    
    return processedModels;
}