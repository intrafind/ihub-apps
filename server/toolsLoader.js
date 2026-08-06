import fs from 'fs';
import path from 'path';
import { createResourceLoader, createValidator } from './utils/resourceLoader.js';
import { getRootDir } from './pathUtils.js';
import logger from './utils/logger.js';

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
 * Warn (without throwing) about tools whose configured `script` file doesn't
 * exist under server/tools/. Catches typos or hand-edited contents/tools/*.json
 * entries at load time instead of failing silently with ERR_MODULE_NOT_FOUND
 * the first time the tool is invoked.
 * @param {Array} tools - Loaded tool definitions
 */
export function warnAboutMissingToolScripts(tools) {
  const scriptsDir = path.join(getRootDir(), 'server', 'tools');
  for (const tool of tools) {
    if (!tool.script) continue;
    const scriptPath = path.join(scriptsDir, tool.script);
    if (!fs.existsSync(scriptPath)) {
      logger.warn('Tool references a script file that does not exist', {
        component: 'ToolsLoader',
        toolId: tool.id,
        script: tool.script
      });
    }
  }
}

/**
 * Load all tools from individual files in contents/tools/.
 * @param {boolean} includeDisabled - Include disabled tools
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Array} Array of tool objects
 */
export async function loadAllTools(includeDisabled = false, verbose = true) {
  const tools = await toolsLoader.loadFromFiles(verbose);
  warnAboutMissingToolScripts(tools);
  const filtered = includeDisabled ? tools : tools.filter(tool => tool.enabled !== false);
  return filtered.sort(sortTools);
}
