import config from './config.js';
import configCache from './configCache.js';
import { throttledFetch } from './requestThrottler.js';
import { createSourceManager } from './sources/index.js';
import logger from './utils/logger.js';

/**
 * Build JSON Schema parameters from a workflow's start node inputVariables
 * @param {Object} workflow - Workflow definition
 * @returns {Object} JSON Schema parameters object
 */
function buildWorkflowToolParams(workflow, language = 'en') {
  const properties = {
    input: {
      type: 'string',
      description: 'The user message or primary input for the workflow'
    }
  };
  const required = ['input'];

  // Extract input variables from the start node config
  const startNode = (workflow.nodes || []).find(n => n.type === 'start');
  const inputVariables = startNode?.config?.inputVariables;

  if (Array.isArray(inputVariables)) {
    for (const varDef of inputVariables) {
      if (typeof varDef === 'string') {
        if (varDef !== 'input') {
          properties[varDef] = { type: 'string', description: varDef };
        }
      } else if (varDef && varDef.name && varDef.name !== 'input') {
        // Skip file/image variables — they are injected via _fileData/inputFiles,
        // not passed as tool parameters by the LLM
        if (varDef.type === 'file' || varDef.type === 'image') {
          continue;
        }

        const VALID_JSON_SCHEMA_TYPES = new Set([
          'string',
          'number',
          'integer',
          'boolean',
          'array',
          'object'
        ]);
        const CUSTOM_TYPE_MAP = {
          file: 'string',
          select: 'string',
          multiselect: 'array',
          date: 'string',
          textarea: 'string'
        };

        const rawType = varDef.type || 'string';
        const schemaType = VALID_JSON_SCHEMA_TYPES.has(rawType)
          ? rawType
          : CUSTOM_TYPE_MAP[rawType] || 'string';

        const descriptionRaw = varDef.description || varDef.name;
        const prop = {
          type: schemaType,
          description:
            typeof descriptionRaw === 'string'
              ? descriptionRaw
              : extractLanguageValue(descriptionRaw, language)
        };

        // Enrich select types with enum values so the LLM knows valid choices
        if (varDef.type === 'select' && Array.isArray(varDef.options)) {
          prop.enum = varDef.options
            .map(o => (typeof o === 'string' ? o : o.value))
            .filter(Boolean);
        }

        properties[varDef.name] = prop;
        if (varDef.required) {
          required.push(varDef.name);
        }
      }
    }
  }

  return {
    type: 'object',
    properties,
    required
  };
}

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
    logger.warn('Tools could not be loaded');
    return [];
  }

  // Always localize tools to ensure nested multilingual fields (like descriptions in schemas)
  // are converted to strings. Use provided language or fall back to platform default.
  const platformConfig = configCache.getPlatform() || {};
  const effectiveLanguage = language || platformConfig?.defaultLanguage || 'en';
  return localizeTools(tools, effectiveLanguage);
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
      logger.error(`Failed to fetch tools from MCP server: ${response.status}`);
      return [];
    }
    return await response.json();
  } catch (error) {
    logger.error('Error fetching tools from MCP server:', error);
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
    if (
      context.enabledTools !== undefined &&
      context.enabledTools !== null &&
      Array.isArray(context.enabledTools)
    ) {
      appTools = appTools.filter(t => {
        // Check if tool ID is in enabledTools
        if (context.enabledTools.includes(t.id)) {
          return true;
        }
        // For function-based tools, check if base tool is enabled
        const baseToolId = t.id.includes('_') ? t.id.split('_')[0] : t.id;
        return context.enabledTools.includes(baseToolId);
      });
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
        if (
          context.enabledTools !== undefined &&
          context.enabledTools !== null &&
          Array.isArray(context.enabledTools)
        ) {
          sourceTools = sourceTools.filter(t => {
            // Check if tool ID is in enabledTools
            if (context.enabledTools.includes(t.id)) {
              return true;
            }
            // For function-based tools, check if base tool is enabled
            const baseToolId = t.id.includes('_') ? t.id.split('_')[0] : t.id;
            return context.enabledTools.includes(baseToolId);
          });
        }

        appTools = appTools.concat(sourceTools);
      }
    } catch (error) {
      logger.error('Error generating source tools:', error);
    }
  }

  // Add workflow tools (entries like "workflow:<id>" in app.tools)
  if (Array.isArray(app.tools)) {
    const workflowToolIds = app.tools.filter(
      t => typeof t === 'string' && t.startsWith('workflow:')
    );
    for (const ref of workflowToolIds) {
      try {
        const wfId = ref.replace('workflow:', '');
        const wf = configCache.getWorkflowById(wfId);
        if (!wf || wf.enabled === false || !wf.chatIntegration?.enabled) continue;

        let toolDescription = extractLanguageValue(
          wf.chatIntegration?.toolDescription || wf.description,
          language || 'en'
        );
        const toolName = extractLanguageValue(wf.name, language || 'en');

        // If the workflow has file/image input variables, hint that attached files
        // are passed automatically so the LLM knows to call this tool
        const startNode = (wf.nodes || []).find(n => n.type === 'start');
        const hasFileInputs = (startNode?.config?.inputVariables || []).some(
          v => v.type === 'file' || v.type === 'image'
        );
        if (hasFileInputs) {
          toolDescription +=
            ' Any files attached to the user message are passed to this tool automatically.';
        }

        appTools.push({
          id: `workflow_${wfId}`,
          name: toolName,
          description: toolDescription,
          script: 'workflowRunner.js',
          isWorkflowTool: true,
          workflowId: wfId,
          passthrough: true,
          parameters: buildWorkflowToolParams(wf, language || 'en')
        });
      } catch (error) {
        logger.error(`Error generating workflow tool for ${ref}:`, error);
      }
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
  logger.info(`Running tool: ${toolId} with params:`, JSON.stringify(params, null, 2));
  if (!/^[A-Za-z0-9_.-]+$/.test(toolId)) {
    throw new Error('Invalid tool id');
  }

  // Check if this is a workflow tool (starts with 'workflow_')
  if (toolId.startsWith('workflow_')) {
    const mod = await import('./tools/workflowRunner.js');
    return await mod.default({ ...params, workflowId: toolId.replace('workflow_', '') });
  }

  // Check if this is a source tool (starts with 'source_')
  if (toolId.startsWith('source_')) {
    const { createSourceManager } = await import('./sources/index.js');
    const sourceManager = createSourceManager();
    const sourceToolFn = sourceManager.getToolFunction(toolId);

    if (sourceToolFn) {
      logger.info(`Executing source tool: ${toolId}`);
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
    logger.info(`Special tool ${toolId} is handled by provider, skipping execution`);
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
    logger.error(`Failed to execute tool ${toolId}:`, err);
    throw err;
  }
}
