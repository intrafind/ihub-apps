/**
 * Anthropic Tool Calling Converter
 *
 * Handles bidirectional conversion between Anthropic's tool calling format
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
 * Convert generic tools to Anthropic format
 * Anthropic requires tool names to match pattern ^[a-zA-Z0-9_-]{1,128}$
 * @param {import('./GenericToolCalling.js').GenericTool[]} genericTools - Generic tools
 * @returns {Object[]} Anthropic formatted tools
 */
export function convertGenericToolsToAnthropic(genericTools = []) {
  return genericTools.map(tool => ({
    name: tool.id || tool.name,
    description: tool.description,
    input_schema: sanitizeSchemaForProvider(tool.parameters, 'anthropic')
  }));
}

/**
 * Convert Anthropic tools to generic format
 * @param {Object[]} anthropicTools - Anthropic formatted tools
 * @returns {import('./GenericToolCalling.js').GenericTool[]} Generic tools
 */
export function convertAnthropicToolsToGeneric(anthropicTools = []) {
  return anthropicTools.map(tool =>
    createGenericTool(
      tool.name, // Use name as ID
      tool.name,
      tool.description || '',
      tool.input_schema || { type: 'object', properties: {} },
      { originalFormat: 'anthropic' }
    )
  );
}

/**
 * Convert generic tool calls to Anthropic format (for message content)
 * @param {import('./GenericToolCalling.js').GenericToolCall[]} genericToolCalls - Generic tool calls
 * @returns {Object[]} Anthropic formatted tool use content blocks
 */
export function convertGenericToolCallsToAnthropic(genericToolCalls = []) {
  return genericToolCalls.map(toolCall => ({
    type: 'tool_use',
    id: toolCall.id,
    name: toolCall.name,
    input: toolCall.arguments
  }));
}

/**
 * Convert Anthropic tool use blocks to generic format
 * @param {Object[]} anthropicToolUse - Anthropic tool use content blocks
 * @returns {import('./GenericToolCalling.js').GenericToolCall[]} Generic tool calls
 */
export function convertAnthropicToolUseToGeneric(anthropicToolUse = []) {
  return anthropicToolUse.map((toolUse, index) =>
    createGenericToolCall(toolUse.id, toolUse.name, toolUse.input || {}, index, {
      originalFormat: 'anthropic',
      type: 'tool_use'
    })
  );
}

/**
 * Convert generic tool result to Anthropic format
 * @param {import('./GenericToolCalling.js').GenericToolResult} genericResult - Generic tool result
 * @returns {Object} Anthropic formatted tool result content block
 */
export function convertGenericToolResultToAnthropic(genericResult) {
  return {
    type: 'tool_result',
    tool_use_id: genericResult.tool_call_id,
    content:
      typeof genericResult.content === 'string'
        ? genericResult.content
        : JSON.stringify(genericResult.content),
    is_error: genericResult.is_error || false
  };
}

/**
 * Convert Anthropic tool result to generic format
 * @param {Object} anthropicResult - Anthropic tool result content block
 * @returns {import('./GenericToolCalling.js').GenericToolResult} Generic tool result
 */
export function convertAnthropicToolResultToGeneric(anthropicResult) {
  let content = anthropicResult.content;

  // Try to parse JSON content
  if (typeof content === 'string' && !anthropicResult.is_error) {
    try {
      content = JSON.parse(content);
    } catch {
      // Keep as string if not valid JSON
    }
  }

  return {
    tool_call_id: anthropicResult.tool_use_id,
    name: anthropicResult.name || 'unknown',
    content,
    is_error: anthropicResult.is_error || false,
    metadata: { originalFormat: 'anthropic' }
  };
}

/**
 * Convert Anthropic streaming response to generic format
 * @param {string} data - Raw Anthropic response data
 * @returns {import('./GenericToolCalling.js').GenericStreamingResponse} Generic streaming response
 */
// Store state across streaming chunks for proper handling
const streamingState = new Map();

export function convertAnthropicResponseToGeneric(data, streamId = 'default') {
  const result = createGenericStreamingResponse();

  // Get or create state for this stream
  if (!streamingState.has(streamId)) {
    streamingState.set(streamId, {
      finishReason: null,
      pendingToolCall: null,
      toolCallIndex: 0
    });
  }
  const state = streamingState.get(streamId);

  if (!data) return result;

  try {
    const parsed = JSON.parse(data);

    // Handle full response object (non-streaming)
    if (parsed.content && Array.isArray(parsed.content)) {
      for (const contentBlock of parsed.content) {
        if (contentBlock.type === 'text' && contentBlock.text) {
          result.content.push(contentBlock.text);
        } else if (contentBlock.type === 'tool_use') {
          result.tool_calls.push(
            createGenericToolCall(
              contentBlock.id,
              contentBlock.name,
              contentBlock.input || {},
              result.tool_calls.length,
              { originalFormat: 'anthropic', type: 'tool_use' }
            )
          );
        }
      }
      result.complete = true;
      if (parsed.stop_reason) {
        result.finishReason = normalizeFinishReason(parsed.stop_reason, 'anthropic');
      }
    }
    // Handle streaming content deltas
    else if (parsed.type === 'content_block_delta' && parsed.delta && parsed.delta.text) {
      result.content.push(parsed.delta.text);
    } else if (parsed.type === 'message_delta' && parsed.delta) {
      if (parsed.delta.content) {
        result.content.push(parsed.delta.content);
      }
      if (parsed.delta.stop_reason) {
        // Store the finish reason in state so we can use it when message_stop arrives
        state.finishReason = normalizeFinishReason(parsed.delta.stop_reason, 'anthropic');
        result.finishReason = state.finishReason;
      }
    }

    // Tool streaming events
    if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
      // Store the tool call info in state for later when we have complete arguments
      state.pendingToolCall = {
        id: parsed.content_block.id,
        name: parsed.content_block.name,
        index: parsed.index,
        arguments: ''
      };
      // Track if this is the first tool call
      if (!state.toolCallIndex) {
        state.toolCallIndex = 0;
      }
    } else if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'input_json_delta') {
      // Accumulate arguments in state
      if (state.pendingToolCall && parsed.delta.partial_json) {
        state.pendingToolCall.arguments += parsed.delta.partial_json;
      }
    } else if (parsed.type === 'content_block_stop' && state.pendingToolCall) {
      // Now we have the complete tool call with all arguments
      const toolCall = state.pendingToolCall;
      let parsedArgs = {};
      try {
        parsedArgs = JSON.parse(toolCall.arguments);
      } catch (e) {
        console.warn('Failed to parse tool arguments:', e);
        parsedArgs = { __raw_arguments: toolCall.arguments };
      }

      result.tool_calls.push(
        createGenericToolCall(
          toolCall.id,
          toolCall.name,
          parsedArgs,
          state.toolCallIndex++, // Use our own index counter starting at 0
          {
            originalFormat: 'anthropic',
            type: 'tool_use'
          }
        )
      );

      // Clear the pending tool call from state
      state.pendingToolCall = null;
    }

    if (parsed.type === 'message_stop') {
      result.complete = true;
      // Use the finish reason from state (set by message_delta)
      result.finishReason = state.finishReason || 'stop';

      // Clean up the state for this stream
      streamingState.delete(streamId);
    }
  } catch (parseError) {
    console.error('Error parsing Anthropic response chunk:', parseError);
    result.error = true;
    result.errorMessage = `Error parsing Anthropic response: ${parseError.message}`;
  }

  return result;
}

/**
 * Convert generic streaming response to Anthropic format
 * Note: This is primarily for testing/debugging as we typically don't need to convert back to Anthropic format
 * @param {import('./GenericToolCalling.js').GenericStreamingResponse} genericResponse - Generic response
 * @returns {Object} Anthropic formatted response (simplified)
 */
export function convertGenericResponseToAnthropic(genericResponse) {
  const content = [];

  // Add text content
  if (genericResponse.content && genericResponse.content.length > 0) {
    const textContent = genericResponse.content.join('');
    if (textContent) {
      content.push({
        type: 'text',
        text: textContent
      });
    }
  }

  // Add tool use blocks
  if (genericResponse.tool_calls && genericResponse.tool_calls.length > 0) {
    for (const toolCall of genericResponse.tool_calls) {
      content.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.arguments
      });
    }
  }

  const response = {
    id: `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: 'claude',
    stop_reason:
      genericResponse.finishReason === 'tool_calls'
        ? 'tool_use'
        : genericResponse.finishReason === 'stop'
          ? 'end_turn'
          : genericResponse.finishReason,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0
    }
  };

  return response;
}

/**
 * Process message content for Anthropic format, handling tool calls and results
 * @param {Object} message - Message with potential tool calls or results
 * @returns {Object} Processed message for Anthropic API
 */
export function processMessageForAnthropic(message) {
  if (message.role === 'tool') {
    // Convert tool result to Anthropic format
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: message.tool_call_id,
          content:
            typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
          is_error: message.is_error || false
        }
      ]
    };
  } else if (message.role === 'assistant' && message.tool_calls) {
    // Convert assistant message with tool calls
    const content = [];

    if (message.content) {
      content.push({ type: 'text', text: message.content });
    }

    for (const toolCall of message.tool_calls) {
      let args = {};
      try {
        args =
          typeof toolCall.function.arguments === 'string'
            ? JSON.parse(toolCall.function.arguments)
            : toolCall.function.arguments;
      } catch (error) {
        console.warn('Failed to parse tool call arguments:', error);
        args = {};
      }

      content.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.function.name,
        input: args
      });
    }

    return { role: 'assistant', content };
  }

  // Return message as-is for other cases
  return message;
}
