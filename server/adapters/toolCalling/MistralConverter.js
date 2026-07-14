/**
 * Mistral Tool Calling Converter
 *
 * Handles bidirectional conversion between Mistral's tool calling format
 * and the generic tool calling format.
 *
 * NOTE: Mistral uses the same tool format as OpenAI, so we largely delegate
 * to the OpenAI converter with some Mistral-specific adjustments.
 */

import {
  convertOpenAIToolsToGeneric,
  convertGenericToolCallsToOpenAI,
  convertOpenAIToolCallsToGeneric
} from './OpenAIConverter.js';

import {
  createGenericStreamingResponse,
  normalizeFinishReason,
  sanitizeSchemaForProvider
} from './GenericToolCalling.js';
import logger from '../../utils/logger.js';
import { parseJsonAsync } from '../../utils/asyncJson.js';

/**
 * Convert generic tools to Mistral format
 * Mistral uses OpenAI-compatible format but needs its own provider filtering
 * Filters out provider-specific special tools (googleSearch, webSearch, etc.)
 * @param {import('./GenericToolCalling.js').GenericTool[]} genericTools - Generic tools
 * @returns {Object[]} Mistral formatted tools
 */
export function convertGenericToolsToMistral(genericTools = []) {
  const filteredTools = genericTools.filter(tool => {
    // If tool specifies this provider, always include it
    if (tool.provider === 'mistral') {
      return true;
    }
    // If tool specifies a different provider, exclude it
    if (tool.provider) {
      logger.info('Filtering out provider-specific tool', {
        component: 'MistralConverter',
        toolId: tool.id || tool.name,
        provider: tool.provider
      });
      return false;
    }
    // If tool is marked as special but has no matching provider, exclude it
    if (tool.isSpecialTool) {
      logger.info('Filtering out special tool', {
        component: 'MistralConverter',
        toolId: tool.id || tool.name
      });
      return false;
    }
    // Universal tool - include it
    return true;
  });

  return filteredTools.map(tool => ({
    type: 'function',
    function: {
      name: tool.id || tool.name,
      description: tool.description,
      parameters: sanitizeSchemaForProvider(tool.parameters, 'mistral')
    }
  }));
}

// Mistral uses OpenAI format for other conversions
export const convertMistralToolsToGeneric = convertOpenAIToolsToGeneric;
export const convertGenericToolCallsToMistral = convertGenericToolCallsToOpenAI;
export const convertMistralToolCallsToGeneric = convertOpenAIToolCallsToGeneric;

/**
 * Convert Mistral streaming response to generic format
 * @param {string} data - Raw Mistral response data
 * @param {string} streamId - Stream identifier for stateful processing (unused for Mistral)
 * @returns {import('./GenericToolCalling.js').GenericStreamingResponse} Generic streaming response
 */
export async function convertMistralResponseToGeneric(data, _streamId = 'default') {
  const result = createGenericStreamingResponse();

  if (!data) return result;
  if (data === '[DONE]') {
    result.complete = true;
    return result;
  }

  try {
    const parsed = await parseJsonAsync(data);

    // Extract usage data from streaming chunks (requires stream_options.include_usage)
    if (parsed.usage) {
      result.metadata.usage = {
        promptTokens: parsed.usage.prompt_tokens || 0,
        completionTokens: parsed.usage.completion_tokens || 0,
        totalTokens: parsed.usage.total_tokens || 0
      };
    }

    // Handle full response object (non-streaming)
    if (parsed.choices && parsed.choices[0]?.message) {
      const messageContent = parsed.choices[0].message.content;

      // Handle different content formats that Mistral might return
      if (messageContent) {
        if (Array.isArray(messageContent)) {
          for (const part of messageContent) {
            if (typeof part === 'string') {
              result.content.push(part);
            } else if (part && part.type === 'text' && part.text) {
              result.content.push(part.text);
            }
          }
        } else if (typeof messageContent === 'object' && messageContent !== null) {
          if (messageContent.type === 'text' && messageContent.text) {
            result.content.push(messageContent.text);
          }
        } else {
          result.content.push(messageContent);
        }
      }

      if (parsed.choices[0].message.tool_calls) {
        result.tool_calls.push(
          ...convertMistralToolCallsToGeneric(parsed.choices[0].message.tool_calls)
        );
      }
      result.complete = true;
      if (parsed.choices[0].finish_reason) {
        result.finishReason = normalizeFinishReason(parsed.choices[0].finish_reason, 'mistral');
      }
    }
    // Handle streaming response chunks
    else if (parsed.choices && parsed.choices[0]?.delta) {
      const delta = parsed.choices[0].delta;

      if (delta.content) {
        const deltaContent = delta.content;

        // Handle different content formats in streaming
        if (Array.isArray(deltaContent)) {
          for (const part of deltaContent) {
            if (typeof part === 'string') {
              result.content.push(part);
            } else if (part && part.type === 'text' && part.text) {
              result.content.push(part.text);
            }
          }
        } else if (typeof deltaContent === 'object' && deltaContent !== null) {
          if (deltaContent.type === 'text' && deltaContent.text) {
            result.content.push(deltaContent.text);
          }
        } else {
          result.content.push(deltaContent);
        }
      }

      if (delta.tool_calls) {
        result.tool_calls.push(...convertMistralToolCallsToGeneric(delta.tool_calls));
      }
    }

    if (parsed.choices && parsed.choices[0]?.finish_reason) {
      result.complete = true;
      result.finishReason = normalizeFinishReason(parsed.choices[0].finish_reason, 'mistral');
    }
  } catch (error) {
    logger.error('Error parsing Mistral response chunk', {
      component: 'MistralConverter',
      error
    });
    result.error = true;
    result.errorMessage = `Error parsing Mistral response: ${error.message}`;
  }

  return result;
}
