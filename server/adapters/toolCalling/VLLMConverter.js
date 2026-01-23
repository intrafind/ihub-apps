/**
 * vLLM Tool Calling Converter
 *
 * Handles bidirectional conversion between vLLM's tool calling format
 * and the generic tool calling format. vLLM uses OpenAI-compatible API
 * but has more restrictive JSON schema support.
 */

import {
  createGenericTool,
  createGenericToolCall,
  createGenericStreamingResponse,
  normalizeFinishReason
} from './GenericToolCalling.js';

/**
 * Sanitize JSON Schema for vLLM compatibility
 * vLLM has more restrictive JSON schema support than OpenAI
 * @param {Object} schema - JSON Schema
 * @returns {Object} Sanitized schema
 */
function sanitizeSchemaForVLLM(schema) {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }

  const sanitized = JSON.parse(JSON.stringify(schema)); // Deep clone

  function cleanObject(obj) {
    if (!obj || typeof obj !== 'object') return obj;

    // Remove vLLM-incompatible fields
    delete obj.format; // vLLM doesn't support format validation like "uri"
    delete obj.exclusiveMaximum;
    delete obj.exclusiveMinimum;
    delete obj.title; // Some vLLM versions don't support title
    // Keep minLength/maxLength as they're more widely supported

    // Recursively clean nested objects
    for (const key in obj) {
      if (obj[key] && typeof obj[key] === 'object') {
        if (Array.isArray(obj[key])) {
          obj[key] = obj[key].map(item => cleanObject(item));
        } else {
          obj[key] = cleanObject(obj[key]);
        }
      }
    }

    return obj;
  }

  return cleanObject(sanitized);
}

/**
 * Convert generic tools to vLLM format (OpenAI-compatible with restrictions)
 * Filters out provider-specific special tools (googleSearch, webSearch, etc.)
 * @param {import('./GenericToolCalling.js').GenericTool[]} genericTools - Generic tools
 * @returns {Object[]} vLLM formatted tools (OpenAI-compatible)
 */
export function convertGenericToolsToVLLM(genericTools = []) {
  const filteredTools = genericTools.filter(tool => {
    // If tool specifies this provider, always include it
    if (tool.provider === 'local') {
      return true;
    }
    // If tool specifies a different provider, exclude it
    if (tool.provider) {
      console.log(
        `[vLLM Converter] Filtering out provider-specific tool: ${tool.id || tool.name} (provider: ${tool.provider})`
      );
      return false;
    }
    // If tool is marked as special but has no matching provider, exclude it
    if (tool.isSpecialTool) {
      console.log(`[vLLM Converter] Filtering out special tool: ${tool.id || tool.name}`);
      return false;
    }
    // Universal tool - include it
    return true;
  });

  return filteredTools.map(tool => ({
    type: 'function',
    function: {
      name: tool.id,
      description: tool.description,
      parameters: sanitizeSchemaForVLLM(tool.parameters)
    }
  }));
}

/**
 * Convert vLLM tools to generic format (same as OpenAI)
 * @param {Object[]} vllmTools - vLLM formatted tools
 * @returns {import('./GenericToolCalling.js').GenericTool[]} Generic tools
 */
export function convertVLLMToolsToGeneric(vllmTools = []) {
  return vllmTools.map((tool, index) => {
    // Handle both nested function format and flat format
    if (tool.type === 'function' && tool.function) {
      return createGenericTool(
        tool.function.id,
        tool.function.name,
        tool.function.description || '',
        tool.function.parameters || { type: 'object', properties: {} },
        { originalFormat: 'vllm', type: tool.type }
      );
    }

    // Handle flat format (legacy or simplified)
    return createGenericTool(
      tool.id || tool.name || `tool_${index}`,
      tool.name || `tool_${index}`,
      tool.description || '',
      tool.parameters || { type: 'object', properties: {} },
      { originalFormat: 'vllm' }
    );
  });
}

/**
 * Convert generic tool calls to vLLM format (same as OpenAI)
 * @param {import('./GenericToolCalling.js').GenericToolCall[]} genericToolCalls - Generic tool calls
 * @returns {Object[]} vLLM formatted tool calls
 */
export function convertGenericToolCallsToVLLM(genericToolCalls = []) {
  // Convert to modern tool_calls array format
  return genericToolCalls.map(toolCall => {
    // Handle streaming chunks with __raw_arguments
    let args;
    if (toolCall.arguments && toolCall.arguments.__raw_arguments !== undefined) {
      // This is a streaming chunk - use the raw arguments directly
      args = toolCall.arguments.__raw_arguments;
    } else if (typeof toolCall.arguments === 'string') {
      args = toolCall.arguments;
    } else {
      args = JSON.stringify(toolCall.arguments);
    }

    return {
      index: toolCall.index || 0,
      id: toolCall.id,
      function: {
        name: toolCall.id,
        arguments: args
      }
    };
  });
}

/**
 * Convert vLLM tool calls to generic format (same as OpenAI)
 * @param {Object[]} vllmToolCalls - vLLM formatted tool calls
 * @returns {import('./GenericToolCalling.js').GenericToolCall[]} Generic tool calls
 */
export function convertVLLMToolCallsToGeneric(vllmToolCalls = []) {
  return vllmToolCalls
    .map((toolCall, index) => {
      let args = {};
      let argString = '';

      // Handle streaming tool call arguments
      if (toolCall.function?.arguments) {
        argString = toolCall.function.arguments;

        // For streaming responses, arguments may be partial JSON
        const argsStr = argString;
        const hasIdAndName = toolCall.id && toolCall.function?.name;
        const trimmedForCheck = argsStr.trim();

        if (!trimmedForCheck || trimmedForCheck === '{}') {
          args = { __raw_arguments: '' };
        } else if (trimmedForCheck.startsWith('{') && trimmedForCheck.endsWith('}')) {
          try {
            const parsed = JSON.parse(trimmedForCheck);
            args =
              hasIdAndName && Object.keys(parsed).length > 0
                ? parsed
                : { __raw_arguments: argsStr };
          } catch (error) {
            console.warn('Failed to parse vLLM tool call arguments:', error.message);
            args = { __raw_arguments: argsStr };
          }
        } else {
          args = { __raw_arguments: argsStr };
        }
      }

      const toolId = toolCall.id || null;
      const toolName = toolCall.function?.name || '';
      const toolIndex = toolCall.index !== undefined ? toolCall.index : index;

      if (!toolName && args.__raw_arguments !== undefined) {
        return {
          id: toolId || '',
          name: '',
          arguments: args,
          index: toolIndex,
          metadata: {
            originalFormat: 'vllm',
            type: toolCall.type || 'function',
            streaming_chunk: true,
            rawArguments: argString
          },
          function: {
            name: '',
            arguments: argString
          }
        };
      }

      return createGenericToolCall(toolId, toolName, args, toolIndex, {
        originalFormat: 'vllm',
        type: toolCall.type || 'function',
        rawArguments: argString
      });
    })
    .filter(toolCall => {
      return (
        toolCall.id ||
        toolCall.name ||
        (toolCall.metadata?.rawArguments && toolCall.metadata.rawArguments.length > 0) ||
        toolCall.arguments?.__raw_arguments !== undefined
      );
    });
}

/**
 * Convert vLLM streaming response to generic format (same as OpenAI with error handling)
 * @param {string} data - Raw vLLM response data
 * @param {string} streamId - Stream identifier for stateful processing
 * @returns {import('./GenericToolCalling.js').GenericStreamingResponse} Generic streaming response
 */
const streamingState = new Map();

export function convertVLLMResponseToGeneric(data, streamId = 'default') {
  const result = createGenericStreamingResponse();

  if (!streamingState.has(streamId)) {
    streamingState.set(streamId, {
      finishReason: null,
      pendingToolCalls: new Map(),
      toolCallIndex: 0
    });
  }
  const state = streamingState.get(streamId);

  if (!data) return result;
  if (data === '[DONE]') {
    result.complete = true;

    // Finalize any pending tool calls when stream ends without explicit finish reason
    if (state.pendingToolCalls.size > 0) {
      for (const [index, pending] of state.pendingToolCalls.entries()) {
        if (pending.id && pending.name) {
          let parsedArgs = {};
          try {
            if (pending.arguments.trim()) {
              parsedArgs = JSON.parse(pending.arguments);
            }
          } catch (e) {
            console.warn('Failed to parse accumulated vLLM tool arguments on [DONE]:', e);
            parsedArgs = { __raw_arguments: pending.arguments };
          }

          result.tool_calls.push(
            createGenericToolCall(pending.id, pending.name, parsedArgs, index, {
              originalFormat: 'vllm',
              type: 'function'
            })
          );

          // Set finish reason to tool_calls if we have tool calls
          result.finishReason = 'tool_calls';
        }
      }
    }

    streamingState.delete(streamId);
    return result;
  }

  try {
    const parsed = JSON.parse(data);

    // Handle error responses (vLLM specific)
    if (parsed.error) {
      result.error = true;
      result.errorMessage = parsed.error.message || 'Unknown error';
      result.complete = true;
      return result;
    }

    // Handle full response object (non-streaming)
    if (parsed.choices && parsed.choices[0]?.message) {
      if (parsed.choices[0].message.content) {
        result.content.push(parsed.choices[0].message.content);
      }
      if (parsed.choices[0].message.tool_calls) {
        result.tool_calls.push(
          ...convertVLLMToolCallsToGeneric(parsed.choices[0].message.tool_calls)
        );
      }
      result.complete = true;
      if (parsed.choices[0].finish_reason) {
        result.finishReason = normalizeFinishReason(parsed.choices[0].finish_reason, 'vllm');
      }
    }
    // Handle streaming response chunks
    else if (parsed.choices && parsed.choices[0]?.delta) {
      const delta = parsed.choices[0].delta;
      if (delta.content) {
        result.content.push(delta.content);
      }
      if (delta.tool_calls) {
        // Process each tool call delta - accumulate in state
        for (const toolCall of delta.tool_calls) {
          const index = toolCall.index || 0;

          if (!state.pendingToolCalls.has(index)) {
            state.pendingToolCalls.set(index, {
              id: '',
              name: '',
              arguments: '',
              index: index
            });
          }

          const pending = state.pendingToolCalls.get(index);

          if (toolCall.id) {
            pending.id = toolCall.id;
          }
          if (toolCall.function?.name) {
            pending.name = toolCall.function.name;
          }
          if (toolCall.function?.arguments) {
            pending.arguments += toolCall.function.arguments;
          }
        }
      }
    }

    // Handle finish reason
    if (parsed.choices && parsed.choices[0]?.finish_reason) {
      result.complete = true;
      state.finishReason = normalizeFinishReason(parsed.choices[0].finish_reason, 'vllm');
      result.finishReason = state.finishReason;

      // For vLLM, we need to finalize tool calls on any finish reason if we have pending calls
      // vLLM might use "stop" instead of "tool_calls" as finish reason
      if (state.pendingToolCalls.size > 0) {
        for (const [index, pending] of state.pendingToolCalls.entries()) {
          if (pending.id && pending.name) {
            let parsedArgs = {};
            try {
              if (pending.arguments.trim()) {
                parsedArgs = JSON.parse(pending.arguments);
              }
            } catch (e) {
              console.warn('Failed to parse accumulated vLLM tool arguments:', e);
              parsedArgs = { __raw_arguments: pending.arguments };
            }

            result.tool_calls.push(
              createGenericToolCall(pending.id, pending.name, parsedArgs, index, {
                originalFormat: 'vllm',
                type: 'function'
              })
            );

            // Update finish reason to tool_calls if we have tool calls
            result.finishReason = 'tool_calls';
          }
        }
      }

      streamingState.delete(streamId);
    }
  } catch (error) {
    console.error('Error parsing vLLM response chunk:', error);
    result.error = true;
    result.errorMessage = `Error parsing vLLM response: ${error.message}`;
  }

  return result;
}

/**
 * Convert generic streaming response to vLLM format (same as OpenAI)
 * @param {import('./GenericToolCalling.js').GenericStreamingResponse} genericResponse - Generic response
 * @param {string} completionId - Completion ID for vLLM format
 * @param {string} modelId - Model ID
 * @param {boolean} isFirstChunk - Whether this is the first chunk
 * @returns {Object} vLLM formatted response chunk
 */
export function convertGenericResponseToVLLM(
  genericResponse,
  completionId,
  modelId,
  isFirstChunk = false
) {
  const chunk = {
    id: completionId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: null
      }
    ]
  };

  const hasToolCalls = genericResponse.tool_calls && genericResponse.tool_calls.length > 0;
  const hasContent = genericResponse.content && genericResponse.content.length > 0;

  if (isFirstChunk) {
    chunk.choices[0].delta.role = 'assistant';
  }

  if (hasContent) {
    const content = genericResponse.content.join('');
    if (content) {
      chunk.choices[0].delta.content = content;
    }
  }

  if (hasToolCalls) {
    const toolCalls = convertGenericToolCallsToVLLM(genericResponse.tool_calls);
    if (toolCalls && toolCalls.length > 0) {
      chunk.choices[0].delta.tool_calls = toolCalls;
    }
  }

  if (genericResponse.complete) {
    chunk.choices[0].finish_reason = genericResponse.finishReason || 'stop';
  }

  return chunk;
}

/**
 * Convert generic streaming response to vLLM non-streaming format
 * @param {import('./GenericToolCalling.js').GenericStreamingResponse} genericResponse - Generic response
 * @param {string} completionId - Completion ID
 * @param {string} modelId - Model ID
 * @returns {Object} vLLM formatted complete response
 */
export function convertGenericResponseToVLLMNonStreaming(genericResponse, completionId, modelId) {
  const response = {
    id: completionId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: genericResponse.content.join('') || null
        },
        finish_reason: genericResponse.finishReason || 'stop'
      }
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };

  if (genericResponse.tool_calls && genericResponse.tool_calls.length > 0) {
    const toolCalls = convertGenericToolCallsToVLLM(genericResponse.tool_calls);
    if (toolCalls && toolCalls.length > 0) {
      response.choices[0].message.tool_calls = toolCalls;
    }
  }

  return response;
}
