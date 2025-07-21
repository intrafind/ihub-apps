import { loadJson } from './configLoader.js';
import config from './config.js';
import configCache from './configCache.js';
import { throttledFetch } from './requestThrottler.js';

/**
 * Resolve a translation key from localization data
 * @param {string} key - Translation key like "tools.braveSearch.name"
 * @param {object} translations - Translation object
 * @returns {string} - Resolved translation or the key if not found
 */
function resolveTranslationKey(key, translations) {
  if (!key || typeof key !== 'string' || !key.startsWith('tools.')) {
    return key;
  }
  
  const keyParts = key.split('.');
  let current = translations;
  
  for (const part of keyParts) {
    if (current && typeof current === 'object' && current[part] !== undefined) {
      current = current[part];
    } else {
      return key; // Return original key if not found
    }
  }
  
  return typeof current === 'string' ? current : key;
}

/**
 * Recursively resolve translation keys in an object
 * @param {any} obj - Object to process
 * @param {object} translations - Translation data
 * @returns {any} - Object with resolved translations
 */
function resolveTranslationsInObject(obj, translations) {
  if (typeof obj === 'string') {
    return resolveTranslationKey(obj, translations);
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => resolveTranslationsInObject(item, translations));
  }
  
  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveTranslationsInObject(value, translations);
    }
    return result;
  }
  
  return obj;
}

/**
 * Localize tools based on user language
 * @param {Array} tools - Array of tool objects
 * @param {string} language - User language (e.g., 'en', 'de')
 * @returns {Array} - Localized tools
 */
function localizeTools(tools, language = 'en') {
  const translations = configCache.getLocalizations(language);
  if (!translations) {
    console.warn(`No translations found for language: ${language}`);
    // Fallback to English
    const fallbackTranslations = configCache.getLocalizations('en');
    return fallbackTranslations ? 
      tools.map(tool => resolveTranslationsInObject(tool, fallbackTranslations)) : 
      tools;
  }
  
  return tools.map(tool => resolveTranslationsInObject(tool, translations));
}

/**
 * Load tools defined locally in config/tools.json
 * @param {string} language - Optional language for localization
 */
export async function loadConfiguredTools(language = null) {
  // Try to get tools from cache first
  const { data: tools, etag: toolsEtag } = configCache.getTools();
  if (!tools) {
    console.warn('Tools could not be loaded');
    return [];
  }

  // If language is specified, localize the tools
  if (language) {
    return localizeTools(tools, language);
  }

  return tools;
}

/**
 * Discover tools from an MCP (Model Context Protocol) server if configured
 */
export async function discoverMcpTools() {
  const mcpUrl = config.MCP_SERVER_URL;
  if (!mcpUrl) return [];

  try {
    const response = await throttledFetch('mcp', `${mcpUrl.replace(/\/$/, '')}/tools`);
    if (!response.ok) {
      console.error(`Failed to fetch tools from MCP server: ${response.status}`);
      return [];
    }
    return await response.json();
  } catch (error) {
    console.error('Error fetching tools from MCP server:', error);
    return [];
  }
}

/**
 * Load tools from local configuration and MCP server
 * @param {string} language - Optional language for localization
 */
export async function loadTools(language = null) {
  const configured = await loadConfiguredTools(language);
  const discovered = await discoverMcpTools();
  const all = [...configured];
  for (const tool of discovered) {
    if (!all.find(t => t.id === tool.id)) {
      all.push(tool);
    }
  }
  return all;
}

/**
 * Get tools applicable to a specific app
 * @param {Object} app - app configuration object
 * @param {string} language - Optional language for localization
 */
export async function getToolsForApp(app, language = null) {
  const allTools = await loadTools(language);
  if (Array.isArray(app.tools) && app.tools.length > 0) {
    return allTools.filter(t => app.tools.includes(t.id));
  }
  return [];
}

/**
 * Export the localizeTools function for use by other modules
 * @param {Array} tools - Array of tool objects
 * @param {string} language - User language (e.g., 'en', 'de')
 * @returns {Array} - Localized tools
 */
export { localizeTools };

/**
 * Dynamically import and run a tool implementation securely.
 * Tool implementations live in `server/tools` and export a default async function.
 *
 * @param {string} toolId - Tool identifier
 * @param {object} params - Parameters passed to the tool
 */
export async function runTool(toolId, params = {}) {
  console.log(`Running tool: ${toolId} with params:`, JSON.stringify(params, null, 2));
  if (!/^[A-Za-z0-9_.-]+$/.test(toolId)) {
    throw new Error('Invalid tool id');
  }

  // Find tool definition to determine the script file
  const allTools = await loadTools();
  const tool = allTools.find(t => t.id === toolId);
  if (!tool) {
    throw new Error(`Tool ${toolId} not found`);
  }

  const scriptName = tool.script || `${toolId}.js`;
  if (!/^[A-Za-z0-9_-]+\.js$/.test(scriptName)) {
    throw new Error('Invalid script name');
  }

  try {
    const mod = await import(`./tools/${scriptName}`);
    const fn = tool.method ? mod[tool.method] : mod.default;
    if (typeof fn !== 'function') {
      throw new Error(`Tool ${toolId} does not export function ${tool.method || 'default'}`);
    }

    // Apply default parameter values defined in the tool schema
    if (tool.parameters && tool.parameters.properties) {
      for (const [key, prop] of Object.entries(tool.parameters.properties)) {
        if (params[key] === undefined && prop.default !== undefined) {
          params[key] = prop.default;
        }
      }
    }

    return await fn(params);
  } catch (err) {
    console.error(`Failed to execute tool ${toolId}:`, err);
    throw err;
  }
}
