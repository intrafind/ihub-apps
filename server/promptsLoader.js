import { createResourceLoader, createValidator } from './utils/resourceLoader.js';

/**
 * Enhanced Prompts Loader Service
 *
 * This service loads prompts from both individual files in contents/prompts/
 * and the legacy prompts.json file for backward compatibility.
 *
 * Uses the generic resource loader factory to eliminate code duplication.
 */

// Create the prompts resource loader
const promptsLoader = createResourceLoader({
  resourceName: 'Prompts',
  legacyPath: 'config/prompts.json',
  individualPath: 'prompts',
  validateItem: createValidator(['id', 'name', 'prompt'])
});

/**
 * Load prompts from individual files in contents/prompts/
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Array} Array of prompt objects
 */
export async function loadPromptsFromFiles(verbose = true) {
  return await promptsLoader.loadFromFiles(verbose);
}

/**
 * Load prompts from legacy prompts.json file
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Array} Array of prompt objects
 */
export async function loadPromptsFromLegacyFile(verbose = true) {
  return await promptsLoader.loadFromLegacy(verbose);
}

/**
 * Load all prompts from both individual files and legacy file
 * @param {boolean} includeDisabled - Include disabled prompts
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Array} Array of prompt objects
 */
export async function loadAllPrompts(includeDisabled = false, verbose = true) {
  return await promptsLoader.loadAll(includeDisabled, verbose);
}
