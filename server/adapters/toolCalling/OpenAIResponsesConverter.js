/**
 * OpenAI Responses API Tool Calling Converter
 *
 * Handles bidirectional conversion between OpenAI Responses API's tool calling format
 * and the generic tool calling format. The Responses API uses internally-tagged format
 * (no nested function object) and is strict by default.
 */

import {
  createGenericTool,
  createGenericToolCall,
  createGenericStreamingResponse,
  normalizeFinishReason,
  sanitizeSchemaForProvider
} from './GenericToolCalling.js';

/**
 * Convert generic tools to OpenAI Responses API format
 * @param {import('./GenericToolCalling.js').GenericTool[]} genericTools - Generic tools
 * @returns {Object[]} OpenAI Responses API formatted tools
 */
export function convertGenericToolsToOpenaiResponses(genericTools = []) {
  return genericTools.map(tool => ({
    type: 'function',
    name: tool.id || tool.name,
    description: tool.description,
    parameters: sanitizeSchemaForProvider(tool.parameters, 'openai-responses')
    // Note: strict: true is the default in Responses API, no need to specify
  }));
}

/**
 * Convert OpenAI Responses API tools to generic format
 * @param {Object[]} responsesTools - OpenAI Responses API formatted tools
 * @returns {import('./GenericToolCalling.js').GenericTool[]} Generic tools
 */
export function convertOpenaiResponsesToolsToGeneric(responsesTools = []) {
  return responsesTools.map((tool, index) => {
    // Responses API uses internally-tagged format (flat structure)
    return createGenericTool(
      tool.name || `tool_${index}`,
      tool.name || `tool_${index}`,
      tool.description || '',
      tool.parameters || { type: 'object', properties: {} },
      { originalFormat: 'openai-responses', type: tool.type }
    );
  });
}

/**
 * Convert generic tool calls to OpenAI Responses API format
 * @param {import('./GenericToolCalling.js').GenericToolCall[]} genericToolCalls - Generic tool calls
 * @returns {Object[]} OpenAI Responses API formatted tool calls
 */
export function convertGenericToolCallsToOpenaiResponses(genericToolCalls = []) {
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
 * Convert OpenAI Responses API tool calls to generic format
 * @param {Object[]} responsesToolCalls - OpenAI Responses API formatted tool calls
 * @returns {import('./GenericToolCalling.js').GenericToolCall[]} Generic tool calls
 */
export function convertOpenaiResponsesToolCallsToGeneric(responsesToolCalls = []) {
  return responsesToolCalls
    .map((toolCall, index) => {
      let args = {};

      // Try to parse arguments if they're a string
      if (typeof toolCall.function?.arguments === 'string') {
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch (e) {
          // If parsing fails, keep as raw string in __raw_arguments for streaming
          args = { __raw_arguments: toolCall.function.arguments };
        }
      } else if (toolCall.function?.arguments) {
        args = toolCall.function.arguments;
      }

      return createGenericToolCall(
        toolCall.id || `call_${index}`,
        toolCall.function?.name || 'unknown_function',
        args,
        index,
        { originalFormat: 'openai-responses' }
      );
    })
    .filter(tc => tc !== null);
}

/**
 * Convert OpenAI Responses API streaming response to generic format
 * @param {string} data - Raw response data
 * @param {string} streamId - Stream identifier
 * @returns {import('./GenericToolCalling.js').GenericStreamingResponse} Generic streaming response
 */
export function convertOpenaiResponsesResponseToGeneric(data, streamId = 'default') {
  // Add debugging to see if function is being called and what data is received
  console.log(
    '[RESPONSES API DEBUG] convertOpenaiResponsesResponseToGeneric called with data:',
    data
  );

  if (!data || data === '[DONE]') {
    console.log('[RESPONSES API DEBUG] Data is null, empty, or [DONE]');
    return createGenericStreamingResponse([], [], [], true, false, null, 'stop');
  }

  try {
    const parsed = JSON.parse(data);
    console.log('[RESPONSES API DEBUG] Parsed chunk:', JSON.stringify(parsed, null, 2));

    const content = [];
    const thinking = [];
    const toolCalls = [];
    let complete = false;
    let finishReason = null;

    // Handle server-sent event format with type field
    if (parsed.type) {
      console.log('[RESPONSES API DEBUG] Event type:', parsed.type);

      // Skip metadata events that don't contain content
      if (parsed.type === 'response.created' || parsed.type === 'response.in_progress') {
        console.log('[RESPONSES API DEBUG] Skipping metadata event:', parsed.type);
        return createGenericStreamingResponse([], [], [], false, false, null, null);
      }

      // Handle completion events
      if (parsed.type === 'response.completed' || parsed.type === 'response.done') {
        console.log('[RESPONSES API DEBUG] Completion event received:', parsed.type);
        complete = true;
        finishReason = 'stop';

        // Don't extract content from completion event - content comes from delta events
        // Just mark the stream as complete
        return createGenericStreamingResponse(
          [],
          [],
          [],
          complete,
          false,
          null,
          normalizeFinishReason(finishReason)
        );
      }

      // Handle content delta events (streaming chunks)
      if (
        parsed.type === 'response.output_chunk.delta' ||
        parsed.type === 'response.output_text.delta'
      ) {
        console.log('[RESPONSES API DEBUG] Processing delta event, type:', parsed.type);

        // The actual chunk data is in the 'delta' field
        if (parsed.delta !== undefined && parsed.delta !== null) {
          console.log('[RESPONSES API DEBUG] Delta content:', JSON.stringify(parsed.delta));

          // Handle delta as a direct string (Azure OpenAI format)
          if (typeof parsed.delta === 'string') {
            console.log('[RESPONSES API DEBUG] Found delta as string:', parsed.delta);
            content.push(parsed.delta);
          }
          // Handle text content from delta object
          else if (parsed.delta.text) {
            console.log('[RESPONSES API DEBUG] Found delta.text:', parsed.delta.text);
            content.push(parsed.delta.text);
          }
          // Handle message type deltas with content array
          else if (parsed.delta.type === 'message' && parsed.delta.content) {
            for (const contentItem of parsed.delta.content) {
              if (contentItem.type === 'output_text' && contentItem.text) {
                content.push(contentItem.text);
              }
            }
          }
          // Handle function call deltas
          else if (parsed.delta.type === 'function_call' && parsed.delta.function) {
            toolCalls.push({
              id: parsed.delta.id,
              type: 'function',
              function: {
                name: parsed.delta.function.name,
                arguments: parsed.delta.function.arguments
              }
            });
          }
        }
      }

      // Handle reasoning delta events (thinking/reasoning output)
      if (parsed.type === 'response.output_chunk.delta' && parsed.delta?.type === 'reasoning') {
        console.log('[RESPONSES API DEBUG] Processing reasoning delta');
        if (parsed.delta.summary && Array.isArray(parsed.delta.summary)) {
          for (const summaryItem of parsed.delta.summary) {
            if (summaryItem.type === 'text' && summaryItem.text) {
              thinking.push(summaryItem.text);
            }
          }
        }
      }
    }
    // Handle full response object (non-streaming)
    else if (parsed.output && Array.isArray(parsed.output)) {
      console.log('[RESPONSES API DEBUG] Processing full output array');
      for (const item of parsed.output) {
        // Handle regular message content
        if (item.type === 'message' && item.content) {
          for (const contentItem of item.content) {
            if (contentItem.type === 'output_text' && contentItem.text) {
              content.push(contentItem.text);
            }
          }
        }
        // Handle reasoning/thinking content
        else if (item.type === 'reasoning' && item.summary) {
          for (const summaryItem of item.summary) {
            if (summaryItem.type === 'text' && summaryItem.text) {
              thinking.push(summaryItem.text);
            } else if (typeof summaryItem === 'string') {
              thinking.push(summaryItem);
            }
          }
        }
        // Handle function calls
        else if (item.type === 'function_call' && item.function) {
          toolCalls.push({
            id: item.id,
            type: 'function',
            function: {
              name: item.function.name,
              arguments: item.function.arguments
            }
          });
        }
      }
      complete = true;
      finishReason = 'stop';
    }
    // Handle legacy streaming chunks format
    else if (parsed.output_chunk) {
      console.log('[RESPONSES API DEBUG] Processing legacy output_chunk');
      const chunk = parsed.output_chunk;
      if (chunk.type === 'message' && chunk.delta?.content) {
        for (const contentItem of chunk.delta.content) {
          if (contentItem.type === 'output_text' && contentItem.text) {
            content.push(contentItem.text);
          }
        }
      } else if (chunk.type === 'function_call' && chunk.delta) {
        const normalized = {
          index: chunk.index || 0,
          id: chunk.id,
          type: 'function'
        };
        if (chunk.delta.function) {
          normalized.function = { ...chunk.delta.function };
        }
        toolCalls.push(normalized);
      }
    } else {
      console.log('[RESPONSES API DEBUG] Unknown format - no recognized event structure');
    }

    // Check for completion in legacy format
    if (parsed.status === 'completed' || parsed.output_status === 'completed') {
      complete = true;
      finishReason = 'stop';
    }

    console.log(
      '[RESPONSES API DEBUG] Extracted content:',
      content,
      'thinking:',
      thinking,
      'complete:',
      complete
    );

    // Convert tool calls to generic format
    const genericToolCalls =
      toolCalls.length > 0 ? convertOpenaiResponsesToolCallsToGeneric(toolCalls) : [];

    return createGenericStreamingResponse(
      content,
      thinking,
      genericToolCalls,
      complete,
      false,
      null,
      normalizeFinishReason(finishReason)
    );
  } catch (error) {
    console.error('[RESPONSES API DEBUG] Error parsing OpenAI Responses API response:', error);
    console.error('[RESPONSES API DEBUG] Data that caused error:', data);
    return createGenericStreamingResponse(
      [],
      [],
      [],
      false,
      true,
      `Error parsing response: ${error.message}`,
      null
    );
  }
}
