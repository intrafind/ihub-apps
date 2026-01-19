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
  console.log('[RESPONSES API DEBUG] convertOpenaiResponsesResponseToGeneric called with data:', data);
  
  if (!data || data === '[DONE]') {
    console.log('[RESPONSES API DEBUG] Data is null, empty, or [DONE]');
    return createGenericStreamingResponse([], [], true, null, 'stop');
  }

  try {
    const parsed = JSON.parse(data);
    console.log('[RESPONSES API DEBUG] Parsed chunk:', JSON.stringify(parsed, null, 2));
    
    const content = [];
    const toolCalls = [];
    let complete = false;
    let finishReason = null;

    // Handle full response object (non-streaming)
    if (parsed.output && Array.isArray(parsed.output)) {
      console.log('[RESPONSES API DEBUG] Processing full output array');
      for (const item of parsed.output) {
        if (item.type === 'message' && item.content) {
          for (const contentItem of item.content) {
            if (contentItem.type === 'output_text' && contentItem.text) {
              content.push(contentItem.text);
            }
          }
        } else if (item.type === 'function_call' && item.function) {
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
    // Handle streaming chunks
    else if (parsed.output_chunk) {
      console.log('[RESPONSES API DEBUG] Processing output_chunk');
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
      console.log('[RESPONSES API DEBUG] Unknown format - no output or output_chunk found');
    }

    // Check for completion
    if (parsed.status === 'completed' || parsed.output_status === 'completed') {
      complete = true;
      finishReason = 'stop';
    }

    console.log('[RESPONSES API DEBUG] Extracted content:', content, 'complete:', complete);

    // Convert tool calls to generic format
    const genericToolCalls =
      toolCalls.length > 0 ? convertOpenaiResponsesToolCallsToGeneric(toolCalls) : [];

    return createGenericStreamingResponse(
      content,
      genericToolCalls,
      complete,
      null,
      normalizeFinishReason(finishReason)
    );
  } catch (error) {
    console.error('[RESPONSES API DEBUG] Error parsing OpenAI Responses API response:', error);
    console.error('[RESPONSES API DEBUG] Data that caused error:', data);
    return createGenericStreamingResponse(
      [],
      [],
      false,
      `Error parsing response: ${error.message}`,
      null
    );
  }
}
