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

/**
 * Convert generic tools to OpenAI format
 * @param {import('./GenericToolCalling.js').GenericTool[]} genericTools - Generic tools
 * @returns {Object[]} OpenAI formatted tools
 */
export function convertGenericToolsToOpenAI(genericTools = []) {
  return genericTools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
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
  const filteredToolCalls = genericToolCalls.filter(toolCall => {
    // Filter out streaming chunks with empty IDs/names - these are meant for server-side merging
    // and shouldn't be sent to OpenAI clients during streaming
    if (toolCall.metadata?.streaming_chunk && (!toolCall.id || toolCall.id === '' || !toolCall.name || toolCall.name === '')) {
      console.log(`[OpenAI Converter] Filtering out streaming chunk with empty ID/name:`, { id: toolCall.id, name: toolCall.name });
      return false;
    }
    return true;
  });

  // Convert to legacy function_call format (single function call)
  if (filteredToolCalls.length > 0) {
    const toolCall = filteredToolCalls[0]; // Take first tool call for legacy format
    return {
      name: toolCall.name,
      arguments: typeof toolCall.arguments === 'string'
        ? toolCall.arguments
        : JSON.stringify(toolCall.arguments)
    };
  }
  
  return null;
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
            console.warn(
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
 * @returns {import('./GenericToolCalling.js').GenericStreamingResponse} Generic streaming response
 */
export function convertOpenAIResponseToGeneric(data) {
  const result = createGenericStreamingResponse();

  if (!data) return result;
  if (data === '[DONE]') {
    result.complete = true;
    return result;
  }

  try {
    const parsed = JSON.parse(data);

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
        result.tool_calls.push(...convertOpenAIToolCallsToGeneric(delta.tool_calls));
      }
    }

    if (parsed.choices && parsed.choices[0]?.finish_reason) {
      result.complete = true;
      result.finishReason = normalizeFinishReason(parsed.choices[0].finish_reason, 'openai');
    }
  } catch (error) {
    console.error('Error parsing OpenAI response chunk:', error);
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
    
    // Non-first chunks can have function calls
    if (hasToolCalls) {
      const functionCall = convertGenericToolCallsToOpenAI(genericResponse.tool_calls);
      if (functionCall) {
        chunk.choices[0].delta.function_call = functionCall;
      }
    }
  }

  // Set finish reason if complete (map tool_calls to function_call for legacy format)
  if (genericResponse.complete) {
    let finishReason = genericResponse.finishReason || 'stop';
    if (finishReason === 'tool_calls') {
      finishReason = 'function_call';
    }
    chunk.choices[0].finish_reason = finishReason;
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
        finish_reason: genericResponse.finishReason === 'tool_calls' ? 'function_call' : (genericResponse.finishReason || 'stop')
      }
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };

  // Add function call if present (legacy OpenAI format)
  if (genericResponse.tool_calls && genericResponse.tool_calls.length > 0) {
    const functionCall = convertGenericToolCallsToOpenAI(genericResponse.tool_calls);
    if (functionCall) {
      response.choices[0].message.function_call = functionCall;
    }
  }

  return response;
}
