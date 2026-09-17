import { createResourceLoader, createValidator } from './utils/resourceLoader.js';

/**
 * Tools Configuration Loader
 *
 * Loads tool definitions from individual files in contents/tools/, mirroring
 * appsLoader.js, modelsLoader.js, and promptsLoader.js. There is no legacy
 * config/tools.json support — installations are migrated to individual files
 * by V068__split_tools_config_into_individual_files.js.
 */

const toolsLoader = createResourceLoader({
  resourceName: 'Tools',
  // createResourceLoader requires a legacyPath, but loadAllTools() below only
  // ever calls loadFromFiles() — this path is never read.
  legacyPath: 'config/tools.json',
  individualPath: 'tools',
  validateItem: createValidator(['id', 'name'])
});

function getNameString(tool) {
  if (typeof tool.name === 'object' && tool.name) {
    return tool.name.en || tool.name[Object.keys(tool.name)[0]] || '';
  }
  return tool.name || tool.id || '';
}

function sortTools(a, b) {
  const orderA = a.order ?? 999;
  const orderB = b.order ?? 999;
  if (orderA !== orderB) {
    return orderA - orderB;
  }
  return getNameString(a).localeCompare(getNameString(b));
}

/**
 * Load all tools from individual files in contents/tools/.
 * @param {boolean} includeDisabled - Include disabled tools
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Array} Array of tool objects
 */
export async function loadAllTools(includeDisabled = false, verbose = true) {
  const tools = await toolsLoader.loadFromFiles(verbose);
  const filtered = includeDisabled ? tools : tools.filter(tool => tool.enabled !== false);
  return filtered.sort(sortTools);
}
