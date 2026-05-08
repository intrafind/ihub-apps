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
  createGenericStreamingResponse,
  sanitizeSchemaForProvider
} from './GenericToolCalling.js';
import { parseJsonAsync } from '../../utils/asyncJson.js';
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

/**
 * Map Bedrock Converse `stopReason` values to the generic finish-reason vocabulary.
 */
function mapBedrockStopReason(stopReason) {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    case 'guardrail_intervened':
    case 'content_filtered':
      return 'content_filter';
    default:
      return stopReason || 'stop';
  }
}

/**
 * Convert a non-streaming Bedrock Converse response to the generic streaming-response
 * shape. The streaming path is handled by `BedrockAdapter.parseResponseStream`; this
 * function exists for the model-test endpoint and other call sites that issue
 * `simpleCompletion` (i.e. `stream: false`) and parse the full JSON body.
 *
 * Bedrock Converse non-streaming response shape:
 * {
 *   output: { message: { role, content: [{ text }, { toolUse: { toolUseId, name, input } }] } },
 *   stopReason: 'end_turn' | 'tool_use' | ...,
 *   usage: { inputTokens, outputTokens, totalTokens }
 * }
 *
 * @param {string} data - Raw JSON body from the Converse endpoint
 * @returns {Promise<import('./GenericToolCalling.js').GenericStreamingResponse>} Generic response
 */
export async function convertBedrockResponseToGeneric(data) {
  const result = createGenericStreamingResponse();

  if (!data) return result;

  try {
    const parsed = typeof data === 'string' ? await parseJsonAsync(data) : data;

    // Surface model-side error envelopes (e.g. ValidationException).
    if (parsed?.message && !parsed?.output) {
      result.error = true;
      result.errorMessage = parsed.message;
      result.complete = true;
      result.finishReason = 'error';
      return result;
    }

    const blocks = parsed?.output?.message?.content;
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        if (typeof block.text === 'string' && block.text.length > 0) {
          result.content.push(block.text);
          continue;
        }
        if (block.toolUse) {
          const tu = block.toolUse;
          result.tool_calls.push(
            createGenericToolCall(tu.toolUseId, tu.name, tu.input || {}, result.tool_calls.length, {
              originalFormat: 'bedrock',
              type: 'tool_use'
            })
          );
          continue;
        }
        if (block.reasoningContent?.reasoningText?.text) {
          result.thinking.push(block.reasoningContent.reasoningText.text);
        }
      }
    }

    if (parsed?.usage) {
      const u = parsed.usage;
      result.metadata = result.metadata || {};
      result.metadata.usage = {
        promptTokens: u.inputTokens || 0,
        completionTokens: u.outputTokens || 0,
        totalTokens:
          typeof u.totalTokens === 'number'
            ? u.totalTokens
            : (u.inputTokens || 0) + (u.outputTokens || 0)
      };
    }

    result.complete = true;
    result.finishReason = mapBedrockStopReason(parsed?.stopReason);
  } catch (parseError) {
    logger.error('Error parsing Bedrock response', {
      component: 'BedrockConverter',
      error: parseError
    });
    result.error = true;
    result.errorMessage = `Error parsing Bedrock response: ${parseError.message}`;
  }

  return result;
}
