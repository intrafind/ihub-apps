import { createResourceLoader, createSchemaValidator } from './utils/resourceLoader.js';
import { modelConfigSchema, knownModelKeys } from './validators/modelConfigSchema.js';

/**
 * Models Loader Service
 *
 * This service loads models from both individual files in contents/models/
 * and the legacy models.json file for backward compatibility.
 *
 * Uses the generic resource loader factory to eliminate code duplication.
 */

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

// Create the models resource loader
const modelsLoader = createResourceLoader({
  resourceName: 'Models',
  legacyPath: 'config/models.json',
  individualPath: 'models',
  validateItem: createSchemaValidator(modelConfigSchema, knownModelKeys),
  postProcess: ensureOneDefaultModel
});

/**
 * Load models from individual files in contents/models/
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Array} Array of model objects
 */
export async function loadModelsFromFiles(verbose = true) {
  return await modelsLoader.loadFromFiles(verbose);
}

/**
 * Load models from legacy models.json file
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Array} Array of model objects
 */
export async function loadModelsFromLegacyFile(verbose = true) {
  return await modelsLoader.loadFromLegacy(verbose);
}

/**
 * Load all models from both sources
 * Individual files take precedence over legacy models.json
 * @param {boolean} includeDisabled - Whether to include disabled models
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Array} Array of model objects
 */
export async function loadAllModels(includeDisabled = false, verbose = true) {
  return await modelsLoader.loadAll(includeDisabled, verbose);
}
