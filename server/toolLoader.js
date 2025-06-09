import { loadJson } from './configLoader.js';

/**
 * Load tools defined locally in config/tools.json
 */
export async function loadConfiguredTools() {
  const tools = await loadJson('config/tools.json');
  return tools || [];
}

/**
 * Discover tools from an MCP (Model Context Protocol) server if configured
 */
export async function discoverMcpTools() {
  const mcpUrl = process.env.MCP_SERVER_URL;
  if (!mcpUrl) return [];

  try {
    const response = await fetch(`${mcpUrl.replace(/\/$/, '')}/tools`);
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
 */
export async function loadTools() {
  const configured = await loadConfiguredTools();
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
 */
export async function getToolsForApp(app) {
  const allTools = await loadTools();
  if (Array.isArray(app.tools) && app.tools.length > 0) {
    return allTools.filter(t => app.tools.includes(t.id));
  }
  return [];
}

/**
 * Dynamically import and run a tool implementation securely.
 * Tool implementations live in `server/tools` and export a default async function.
 *
 * @param {string} toolId - Tool identifier
 * @param {object} params - Parameters passed to the tool
 */
export async function runTool(toolId, params = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(toolId)) {
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
    if (typeof mod.default !== 'function') {
      throw new Error(`Tool ${toolId} does not export a default function`);
    }
    return await mod.default(params);
  } catch (err) {
    console.error(`Failed to execute tool ${toolId}:`, err);
    throw err;
  }
}
