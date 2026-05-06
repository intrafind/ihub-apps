/**
 * AWS Bedrock Tool Calling Converter
 *
 * Handles conversion between AWS Bedrock Converse API tool format and the
 * generic tool calling format. Bedrock wraps each tool in a `toolSpec`
 * envelope and nests the JSON Schema under `inputSchema.json`.
 */

import {
  createGenericTool,
  createGenericToolCall,
  sanitizeSchemaForProvider
} from './GenericToolCalling.js';
import logger from '../../utils/logger.js';

/**
 * Convert generic tools to Bedrock Converse format.
 * Filters out provider-specific tools that don't target Bedrock.
 * @param {import('./GenericToolCalling.js').GenericTool[]} genericTools
 * @returns {Object[]} Array of `{ toolSpec: { name, description, inputSchema: { json } } }`
 */
export function convertGenericToolsToBedrock(genericTools = []) {
  const filteredTools = genericTools.filter(tool => {
    if (tool.provider === 'bedrock') return true;
    if (tool.provider) {
      logger.info('Filtering out provider-specific tool', {
        component: 'BedrockConverter',
        toolId: tool.id || tool.name,
        provider: tool.provider
      });
      return false;
    }
    if (tool.isSpecialTool) {
      logger.info('Filtering out special tool', {
        component: 'BedrockConverter',
        toolId: tool.id || tool.name
      });
      return false;
    }
    return true;
  });

  return filteredTools.map(tool => ({
    toolSpec: {
      name: tool.id || tool.name,
      description: tool.description || '',
      inputSchema: {
        json: sanitizeSchemaForProvider(
          tool.parameters || { type: 'object', properties: {} },
          'anthropic'
        )
      }
    }
  }));
}

/**
 * Convert Bedrock tools to generic format.
 * @param {Object[]} bedrockTools - Tools in `{ toolSpec: { … } }` shape
 * @returns {import('./GenericToolCalling.js').GenericTool[]} Generic tools
 */
export function convertBedrockToolsToGeneric(bedrockTools = []) {
  return bedrockTools
    .map(t => t.toolSpec || t)
    .map(spec =>
      createGenericTool(
        spec.name,
        spec.name,
        spec.description || '',
        spec.inputSchema?.json || { type: 'object', properties: {} },
        { originalFormat: 'bedrock' }
      )
    );
}

/**
 * Convert generic tool calls to Bedrock toolUse content blocks.
 * @param {import('./GenericToolCalling.js').GenericToolCall[]} genericToolCalls
 * @returns {Object[]} Array of `{ toolUse: { toolUseId, name, input } }`
 */
export function convertGenericToolCallsToBedrock(genericToolCalls = []) {
  return genericToolCalls.map(call => ({
    toolUse: {
      toolUseId: call.id,
      name: call.name,
      input: call.arguments || {}
    }
  }));
}

/**
 * Convert Bedrock toolUse content blocks to generic tool calls.
 * @param {Object[]} bedrockToolUse - Array of `{ toolUseId, name, input }` (already unwrapped)
 * @returns {import('./GenericToolCalling.js').GenericToolCall[]} Generic tool calls
 */
export function convertBedrockToolUseToGeneric(bedrockToolUse = []) {
  return bedrockToolUse.map((tu, index) =>
    createGenericToolCall(tu.toolUseId, tu.name, tu.input || {}, index, {
      originalFormat: 'bedrock',
      type: 'tool_use'
    })
  );
}

/**
 * Resolve a generic tool-choice value to the Bedrock toolChoice union shape.
 * Bedrock accepts `{ auto: {} }`, `{ any: {} }`, or `{ tool: { name } }`.
 */
export function convertBedrockToolChoice(toolChoice) {
  if (!toolChoice || toolChoice === 'auto') return { auto: {} };
  if (toolChoice === 'any' || toolChoice === 'required') return { any: {} };
  if (typeof toolChoice === 'object') {
    if (toolChoice.function?.name) return { tool: { name: toolChoice.function.name } };
    if (toolChoice.tool?.name) return { tool: { name: toolChoice.tool.name } };
    if (toolChoice.auto || toolChoice.any || toolChoice.tool) return toolChoice;
  }
  return { auto: {} };
}
