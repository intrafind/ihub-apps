import { createResourceLoader, createValidator } from './utils/resourceLoader.js';

/**
 * Tools Configuration Loader
 *
 * Loads tool definitions from both individual files in contents/tools/
 * and the legacy config/tools.json file for backward compatibility.
 *
 * Uses the generic resource loader factory to eliminate code duplication
 * (mirrors appsLoader.js, modelsLoader.js, promptsLoader.js).
 */

const toolsLoader = createResourceLoader({
  resourceName: 'Tools',
  legacyPath: 'config/tools.json',
  individualPath: 'tools',
  validateItem: createValidator(['id', 'name'])
});

/**
 * Load tools from individual files in contents/tools/
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Array} Array of tool objects
 */
export async function loadToolsFromFiles(verbose = true) {
  return await toolsLoader.loadFromFiles(verbose);
}

/**
 * Load tools from legacy config/tools.json file
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Array} Array of tool objects
 */
export async function loadToolsFromLegacyFile(verbose = true) {
  return await toolsLoader.loadFromLegacy(verbose);
}

/**
 * Load all tools from both individual files and the legacy file.
 * Individual files take precedence over legacy entries with the same ID.
 * @param {boolean} includeDisabled - Include disabled tools
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Array} Array of tool objects
 */
export async function loadAllTools(includeDisabled = false, verbose = true) {
  return await toolsLoader.loadAll(includeDisabled, verbose);
}
