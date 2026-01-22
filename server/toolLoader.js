import config from './config.js';
import configCache from './configCache.js';
import { throttledFetch } from './requestThrottler.js';
import { createSourceManager } from './sources/index.js';

/**
 * Extract language-specific value from a multilingual object or return the value as-is
 * @param {any} value - Value that might be a multilingual object {en: "...", de: "..."}
 * @param {string} language - Target language (e.g., 'en', 'de')
 * @param {string} fallbackLanguage - Fallback language (default: 'en')
 * @returns {any} - Language-specific value or original value
 */
function extractLanguageValue(value, language = 'en', fallbackLanguage = null) {
  // Get platform default language if not provided
  if (!fallbackLanguage) {
    const platformConfig = configCache.getPlatform() || {};
    fallbackLanguage = platformConfig?.defaultLanguage || 'en';
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    // Check if this looks like a multilingual object
    if (value[language] !== undefined) {
      return value[language];
    }
    if (value[fallbackLanguage] !== undefined) {
      return value[fallbackLanguage];
    }
    // If it has language keys but not the requested one, try first available
    const availableLanguages = Object.keys(value).filter(
      key => typeof value[key] === 'string' && key.length === 2
    );
    if (availableLanguages.length > 0) {
      return value[availableLanguages[0]];
    }
  }

  return value;
}

/**
 * Recursively extract language-specific values from multilingual objects
 * @param {any} obj - Object to process
 * @param {string} language - Target language
 * @param {string} fallbackLanguage - Fallback language
 * @returns {any} - Object with language-specific values
 */
function extractLanguageFromObject(obj, language = 'en', fallbackLanguage = null) {
  // Get platform default language if not provided
  if (!fallbackLanguage) {
    const platformConfig = configCache.getPlatform() || {};
    fallbackLanguage = platformConfig?.defaultLanguage || 'en';
  }
  if (Array.isArray(obj)) {
    return obj.map(item => extractLanguageFromObject(item, language, fallbackLanguage));
  }

  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      // Skip processing for certain fields that should remain unchanged
      if (key === 'id' || key === 'script' || key === 'enabled') {
        result[key] = value;
      } else if (
        (key === 'description' || key === 'title' || key === 'name') &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).some(k => k.length === 2 && typeof value[k] === 'string')
      ) {
        // This is a multilingual field - an object with language codes as keys
        result[key] = extractLanguageValue(value, language, fallbackLanguage);
      } else {
        result[key] = extractLanguageFromObject(value, language, fallbackLanguage);
      }
    }
    return result;
  }

  return obj;
}

/**
 * Localize tools based on user language by extracting language-specific values from multilingual objects
 * @param {Array} tools - Array of tool objects
 * @param {string} language - User language (e.g., 'en', 'de')
 * @returns {Array} - Localized tools
 */
function localizeTools(tools, language = 'en') {
  const platformConfig = configCache.getPlatform() || {};
  const fallbackLanguage = platformConfig?.defaultLanguage || 'en';
  return tools.map(tool => extractLanguageFromObject(tool, language, fallbackLanguage));
}

/**
 * Load tools defined locally in config/tools.json
 * @param {string} language - Optional language for localization
 */
export async function loadConfiguredTools(language = null) {
  // Try to get tools from cache first
  const { data: tools } = configCache.getTools();
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
 * @param {Object} context - Context object (user, chatId, etc.) for source tool generation
 */
export async function getToolsForApp(app, language = null, context = {}) {
  // Get static tools from tool definitions
  const allTools = await loadTools(language);
  let appTools = [];

  if (Array.isArray(app.tools) && app.tools.length > 0) {
    appTools = allTools.filter(t => {
      // Check if tool ID matches directly
      if (app.tools.includes(t.id)) {
        return true;
      }
      // For function-based tools (e.g., jira_searchTickets), check if base tool (e.g., jira) is requested
      const baseToolId = t.id.includes('_') ? t.id.split('_')[0] : t.id;
      return app.tools.includes(baseToolId);
    });

    // Filter by enabledTools if provided in context
    if (context.enabledTools !== undefined && context.enabledTools !== null && Array.isArray(context.enabledTools)) {
      console.log(`[toolLoader] Filtering tools by enabledTools:`, context.enabledTools);
      console.log(`[toolLoader] Tools before filtering:`, appTools.map(t => t.id));
      appTools = appTools.filter(t => {
        // Check if tool ID is in enabledTools
        if (context.enabledTools.includes(t.id)) {
          return true;
        }
        // For function-based tools, check if base tool is enabled
        const baseToolId = t.id.includes('_') ? t.id.split('_')[0] : t.id;
        return context.enabledTools.includes(baseToolId);
      });
      console.log(`[toolLoader] Tools after filtering:`, appTools.map(t => t.id));
    }
  }

  // Add source-generated tools
  if (Array.isArray(app.sources) && app.sources.length > 0) {
    try {
      const sourceManager = createSourceManager();
      const { data: sourcesConfig } = configCache.getSources();
      if (sourcesConfig && Array.isArray(sourcesConfig)) {
        const appSources = sourcesConfig.filter(
          source => app.sources.includes(source.id) && source.enabled
        );
        let sourceTools = sourceManager.generateTools(appSources, context);
        
        // Filter source tools by enabledTools if provided in context
        if (context.enabledTools !== undefined && context.enabledTools !== null && Array.isArray(context.enabledTools)) {
          console.log(`[toolLoader] Filtering source tools by enabledTools:`, context.enabledTools);
          console.log(`[toolLoader] Source tools before filtering:`, sourceTools.map(t => t.function?.name || t.id));
          sourceTools = sourceTools.filter(t => {
            // Check if tool ID is in enabledTools
            if (context.enabledTools.includes(t.id)) {
              return true;
            }
            // For function-based tools, check if base tool is enabled
            const baseToolId = t.id.includes('_') ? t.id.split('_')[0] : t.id;
            return context.enabledTools.includes(baseToolId);
          });
          console.log(`[toolLoader] Source tools after filtering:`, sourceTools.map(t => t.function?.name || t.id));
        }
        
        appTools = appTools.concat(sourceTools);
      }
    } catch (error) {
      console.error('Error generating source tools:', error);
    }
  }

  return appTools;
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

  // Check if this is a source tool (starts with 'source_')
  if (toolId.startsWith('source_')) {
    const { createSourceManager } = await import('./sources/index.js');
    const sourceManager = createSourceManager();
    const sourceToolFn = sourceManager.getToolFunction(toolId);

    if (sourceToolFn) {
      console.log(`Executing source tool: ${toolId}`);
      return await sourceToolFn(params);
    } else {
      throw new Error(`Source tool ${toolId} not found in registry`);
    }
  }

  // Find tool definition to determine the script file
  const allTools = await loadTools();
  const tool = allTools.find(t => t.id === toolId);
  if (!tool) {
    throw new Error(`Tool ${toolId} not found`);
  }

  // Check if this is a special tool (like Google Search) that doesn't have a script
  if (tool.isSpecialTool) {
    // Special tools are handled by the model provider directly, not executed here
    console.log(`Special tool ${toolId} is handled by provider, skipping execution`);
    return { handled_by_provider: true };
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
