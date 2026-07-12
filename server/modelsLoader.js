import { createResourceLoader, createSchemaValidator } from './utils/resourceLoader.js';
import { modelConfigSchema, knownModelKeys } from './validators/modelConfigSchema.js';
import logger from './utils/logger.js';

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
export function ensureOneDefaultModel(models) {
  const defaultModels = models.filter(model => model.default === true);

  if (defaultModels.length === 0) {
    // No default model found, set the first enabled model as default
    const enabledModels = models.filter(model => model.enabled === true);
    if (enabledModels.length > 0) {
      enabledModels[0].default = true;
      logger.info(`🎯 Set ${enabledModels[0].id} as default model (no default was configured)`, {
        component: 'ModelsLoader'
      });
    }
  } else if (defaultModels.length > 1) {
    // Multiple default models found, keep only the first one
    logger.warn(`⚠️ Multiple default models found, keeping only ${defaultModels[0].id}`, {
      component: 'ModelsLoader'
    });
    for (let i = 1; i < defaultModels.length; i++) {
      defaultModels[i].default = false;
    }
  }

  return models;
}

/**
 * Clear `default` on every model other than `keepModelId`.
 * Used by admin write handlers when a model is explicitly set as the new default.
 * @param {Array} models - Array of model objects (mutated in place)
 * @param {string} keepModelId - The model id that should remain/become the default
 * @returns {Array} The models whose `default` flag was cleared (need persisting)
 */
export function clearOtherDefaults(models, keepModelId) {
  const changed = [];
  for (const model of models) {
    if (model.id !== keepModelId && model.default === true) {
      model.default = false;
      changed.push(model);
    }
  }
  return changed;
}

/**
 * Promote the first other enabled model to default. Used by admin write
 * handlers when the current default model is disabled or deleted.
 * @param {Array} models - Array of model objects (mutated in place)
 * @param {string} excludeModelId - The model id being disabled/deleted
 * @returns {object|null} The promoted model, or null if none available
 */
export function promoteNewDefault(models, excludeModelId) {
  const candidate = models.find(model => model.id !== excludeModelId && model.enabled === true);
  if (candidate) {
    candidate.default = true;
  }
  return candidate || null;
}

/**
 * After a batch enable/disable, ensure at least one enabled model is default.
 * Used by admin batch-toggle handlers.
 * @param {Array} models - Array of model objects (mutated in place)
 * @returns {object|null} The promoted model, or null if none needed/available
 */
export function ensureDefaultAmongEnabled(models) {
  const enabledModels = models.filter(model => model.enabled);
  if (enabledModels.length > 0 && !enabledModels.some(model => model.default)) {
    enabledModels[0].default = true;
    return enabledModels[0];
  }
  return null;
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
