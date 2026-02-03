/**
 * OpenAI Tool Calling Converter
 *
 * Handles bidirectional conversion between OpenAI's tool calling format
 * and the generic tool calling format.
 */

import {
  createGenericTool,
  createGenericToolCall,
  createGenericStreamingResponse,
  normalizeFinishReason,
  sanitizeSchemaForProvider
} from './GenericToolCalling.js';
import logger from '../../utils/logger.js';

/**
 * Convert generic tools to OpenAI format
 * Filters out provider-specific special tools from other providers (googleSearch, etc.)
 * @param {import('./GenericToolCalling.js').GenericTool[]} genericTools - Generic tools
 * @returns {Object[]} OpenAI formatted tools
 */
export function convertGenericToolsToOpenAI(genericTools = []) {
  // Check if webSearch (OpenAI native) is present
  const hasWebSearch = genericTools.some(t => t.id === 'webSearch');
  const webSearchToolIds = ['enhancedWebSearch', 'braveSearch', 'tavilySearch', 'googleSearch'];

  const filteredTools = genericTools.filter(tool => {
    // If tool specifies this provider (or compatible), always include it
    if (tool.provider === 'openai' || tool.provider === 'openai-responses') {
      return true;
    }
    // If tool specifies a different provider, exclude it
    if (tool.provider) {
      logger.info(
        `[OpenAI Converter] Filtering out provider-specific tool: ${tool.id || tool.name} (provider: ${tool.provider})`
      );
      return false;
    }
    // If tool is marked as special but has no matching provider, exclude it
    if (tool.isSpecialTool) {
      logger.info(`[OpenAI Converter] Filtering out special tool: ${tool.id || tool.name}`);
      return false;
    }
    // If webSearch is present, filter out other web search tools
    if (hasWebSearch && webSearchToolIds.includes(tool.id)) {
      console.log(
        `[OpenAI Converter] Filtering out web search tool ${tool.id} because webSearch (native) is available`
      );
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
      parameters: sanitizeSchemaForProvider(tool.parameters, 'openai')
    }
  }));
}

/**
 * Convert OpenAI tools to generic format
 * @param {Object[]} openaiTools - OpenAI formatted tools
 * @returns {import('./GenericToolCalling.js').GenericTool[]} Generic tools
 */
export function convertOpenAIToolsToGeneric(openaiTools = []) {
  return openaiTools.map((tool, index) => {
    // Handle both nested function format and flat format
    if (tool.type === 'function' && tool.function) {
      return createGenericTool(
        tool.function.name, // Use name as ID
        tool.function.name,
        tool.function.description || '',
        tool.function.parameters || { type: 'object', properties: {} },
        { originalFormat: 'openai', type: tool.type }
      );
    }

    // Handle flat format (legacy or simplified)
    return createGenericTool(
      tool.name || tool.id || `tool_${index}`,
      tool.name || `tool_${index}`,
      tool.description || '',
      tool.parameters || { type: 'object', properties: {} },
      { originalFormat: 'openai' }
    );
  });
}

/**
 * Convert generic tool calls to OpenAI format
 * @param {import('./GenericToolCalling.js').GenericToolCall[]} genericToolCalls - Generic tool calls
 * @returns {Object[]} OpenAI formatted tool calls
 */
export function convertGenericToolCallsToOpenAI(genericToolCalls = []) {
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
      type: 'function',
      function: {
        name: toolCall.name,
        arguments: args
      }
    };
  });
}

/**
 * Convert OpenAI tool calls to generic format
 * @param {Object[]} openaiToolCalls - OpenAI formatted tool calls
 * @returns {import('./GenericToolCalling.js').GenericToolCall[]} Generic tool calls
 */
export function convertOpenAIToolCallsToGeneric(openaiToolCalls = []) {
  return openaiToolCalls
    .map((toolCall, index) => {
      let args = {};
      let argString = '';

      // Handle streaming tool call arguments
      if (toolCall.function?.arguments) {
        argString = toolCall.function.arguments;

        // For streaming responses, arguments may be partial JSON
        // Don't trim here as it removes important whitespace from streaming chunks
        const argsStr = argString;

        // Check if this is an initial tool call with proper ID/name vs streaming delta
        const hasIdAndName = toolCall.id && toolCall.function?.name;

        // Only trim for empty checks, but preserve original spacing in __raw_arguments
        const trimmedForCheck = argsStr.trim();

        if (!trimmedForCheck || trimmedForCheck === '{}') {
          // Empty arguments - initialize with empty string for proper accumulation
          args = { __raw_arguments: '' };
        } else if (trimmedForCheck.startsWith('{') && trimmedForCheck.endsWith('}')) {
          // Looks like complete JSON - try to parse, but keep as raw for streaming compatibility
          try {
            const parsed = JSON.parse(trimmedForCheck);
            // If this is a complete tool call with ID/name, we can use parsed args
            // If it's a streaming delta, keep as raw for accumulation (preserving original spacing)
            args =
              hasIdAndName && Object.keys(parsed).length > 0
                ? parsed
                : { __raw_arguments: argsStr };
          } catch (error) {
            // If parsing fails, keep as raw string for later accumulation (preserving original spacing)
            logger.warn(
              'Failed to parse OpenAI tool call arguments (likely streaming partial JSON):',
              error.message
            );
            args = { __raw_arguments: argsStr };
          }
        } else {
          // Partial JSON during streaming - keep as raw string for accumulation (preserving original spacing)
          args = { __raw_arguments: argsStr };
        }
      }

      // Handle streaming tool calls where name/id might be missing initially
      const toolId = toolCall.id || null;
      const toolName = toolCall.function?.name || '';
      const toolIndex = toolCall.index !== undefined ? toolCall.index : index;

      // For streaming chunks with empty names, create minimal objects to avoid overwriting
      // the tool name during merging in ToolExecutor
      if (!toolName && args.__raw_arguments !== undefined) {
        // This is a streaming chunk with arguments but no name
        // Create a minimal object that won't overwrite the existing tool name
        return {
          id: toolId || '',
          name: '', // Keep empty to avoid overwriting existing name
          arguments: args,
          index: toolIndex,
          metadata: {
            originalFormat: 'openai',
            type: toolCall.type || 'function',
            streaming_chunk: true,
            rawArguments: argString
          },
          function: {
            name: '', // Keep empty so ToolExecutor won't overwrite existing name
            arguments: argString
          }
        };
      }

      return createGenericToolCall(toolId, toolName, args, toolIndex, {
        originalFormat: 'openai',
        type: toolCall.type || 'function',
        // Keep raw arguments for streaming merging
        rawArguments: argString
      });
    })
    .filter(toolCall => {
      // Filter out tool calls that are completely empty (likely malformed streaming chunks)
      // Keep tool calls that have at least a name, ID, or meaningful content
      // Also keep streaming chunks that have arguments
      return (
        toolCall.name ||
        toolCall.id ||
        (toolCall.metadata?.rawArguments && toolCall.metadata.rawArguments.length > 0) ||
        toolCall.arguments?.__raw_arguments !== undefined
      );
    });
}

/**
 * Convert OpenAI streaming response to generic format
 * @param {string} data - Raw OpenAI response data
 * @param {string} streamId - Stream identifier for stateful processing
 * @returns {import('./GenericToolCalling.js').GenericStreamingResponse} Generic streaming response
 */
const streamingState = new Map();

export function convertOpenAIResponseToGeneric(data, streamId = 'default') {
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
    return result;
  }

  try {
    const parsed = JSON.parse(data);

    // Handle error responses
    if (parsed.error) {
      result.error = true;
      result.errorMessage = parsed.error.message || 'Unknown error';
      result.complete = true;
      logger.info(`[OpenAI Converter] Detected error response: ${result.errorMessage}`);
      return result;
    }

    // Handle full response object (non-streaming)
    if (parsed.choices && parsed.choices[0]?.message) {
      if (parsed.choices[0].message.content) {
        result.content.push(parsed.choices[0].message.content);
      }
      if (parsed.choices[0].message.tool_calls) {
        result.tool_calls.push(
          ...convertOpenAIToolCallsToGeneric(parsed.choices[0].message.tool_calls)
        );
      }
      result.complete = true;
      if (parsed.choices[0].finish_reason) {
        result.finishReason = normalizeFinishReason(parsed.choices[0].finish_reason, 'openai');
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

        // Log accumulation progress for debugging
        logger.debug(
          `[OpenAI Converter] Accumulated tool calls:`,
          Array.from(state.pendingToolCalls.values())
        );
      }
    }

    // Handle finish reason
    if (parsed.choices && parsed.choices[0]?.finish_reason) {
      result.complete = true;
      state.finishReason = normalizeFinishReason(parsed.choices[0].finish_reason, 'openai');
      result.finishReason = state.finishReason;

      logger.debug(
        `[OpenAI Converter] Finish reason: ${state.finishReason}, pending tool calls: ${state.pendingToolCalls.size}`
      );

      // For OpenAI, finalize tool calls on tool_calls finish reason or if we have pending calls
      if (state.pendingToolCalls.size > 0) {
        logger.debug(
          `[OpenAI Converter] Finalizing ${state.pendingToolCalls.size} pending tool calls`
        );
        for (const [index, pending] of state.pendingToolCalls.entries()) {
          if (pending.id && pending.name) {
            let parsedArgs = {};
            try {
              if (pending.arguments.trim()) {
                parsedArgs = JSON.parse(pending.arguments);
              }
            } catch (e) {
              logger.warn('Failed to parse accumulated OpenAI tool arguments:', e);
              parsedArgs = { __raw_arguments: pending.arguments };
            }

            logger.debug(
              `[OpenAI Converter] Adding tool call: ${pending.name} with args:`,
              parsedArgs
            );
            result.tool_calls.push(
              createGenericToolCall(pending.id, pending.name, parsedArgs, index, {
                originalFormat: 'openai',
                type: 'function'
              })
            );
          }
        }
      }

      streamingState.delete(streamId);
    }
  } catch (error) {
    logger.error('Error parsing OpenAI response chunk:', error);
    result.error = true;
    result.errorMessage = `Error parsing OpenAI response: ${error.message}`;
  }

  return result;
}

/**
 * Convert generic streaming response to OpenAI format
 * @param {import('./GenericToolCalling.js').GenericStreamingResponse} genericResponse - Generic response
 * @param {string} completionId - Completion ID for OpenAI format
 * @param {string} modelId - Model ID
 * @param {boolean} isFirstChunk - Whether this is the first chunk
 * @returns {Object} OpenAI formatted response chunk
 */
export function convertGenericResponseToOpenAI(
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

  // For streaming, separate role from function calls as OpenAI clients expect
  if (isFirstChunk) {
    // First chunk should only have role, unless there's also content
    chunk.choices[0].delta.role = 'assistant';

    // Only add content in first chunk if present, but not function calls
    if (hasContent && !hasToolCalls) {
      const content = genericResponse.content.join('');
      if (content) {
        chunk.choices[0].delta.content = content;
      }
    }
  } else {
    // Non-first chunks can have content
    if (hasContent) {
      const content = genericResponse.content.join('');
      if (content) {
        chunk.choices[0].delta.content = content;
      }
    }

    // Non-first chunks can have tool calls
    if (hasToolCalls) {
      const toolCalls = convertGenericToolCallsToOpenAI(genericResponse.tool_calls);
      if (toolCalls && toolCalls.length > 0) {
        chunk.choices[0].delta.tool_calls = toolCalls;
      }
    }
  }

  // Set finish reason if complete
  if (genericResponse.complete) {
    chunk.choices[0].finish_reason = genericResponse.finishReason || 'stop';
  }

  return chunk;
}

/**
 * Convert generic streaming response to OpenAI non-streaming format
 * @param {import('./GenericToolCalling.js').GenericStreamingResponse} genericResponse - Generic response
 * @param {string} completionId - Completion ID
 * @param {string} modelId - Model ID
 * @returns {Object} OpenAI formatted complete response
 */
export function convertGenericResponseToOpenAINonStreaming(genericResponse, completionId, modelId) {
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
    ], //TODO add usage handling / conversion
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };

  // Add tool calls if present (modern OpenAI format)
  if (genericResponse.tool_calls && genericResponse.tool_calls.length > 0) {
    const toolCalls = convertGenericToolCallsToOpenAI(genericResponse.tool_calls);
    if (toolCalls && toolCalls.length > 0) {
      response.choices[0].message.tool_calls = toolCalls;
    }
  }

  return response;
}
