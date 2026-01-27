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
import logger from '../../utils/logger.js';

/**
 * Add strict mode requirements to a schema for OpenAI Responses API
 * This adds additionalProperties: false to all object schemas recursively
 * and ensures all properties are listed in the required array (strict mode requirement)
 * @param {Object} schema - JSON schema object
 * @returns {Object} Schema with strict mode requirements
 */
function addStrictModeToSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  const strictSchema = JSON.parse(JSON.stringify(schema)); // Deep clone

  function enforceStrictMode(obj) {
    if (!obj || typeof obj !== 'object') return obj;

    // Add additionalProperties: false to all object types
    if (obj.type === 'object') {
      obj.additionalProperties = false;

      // In strict mode, ALL properties must be in the required array
      // This is an OpenAI Responses API requirement, not standard JSON Schema
      if (obj.properties && Object.keys(obj.properties).length > 0) {
        // Get existing required array or create empty one
        const existingRequired = Array.isArray(obj.required) ? obj.required : [];
        const allPropertyKeys = Object.keys(obj.properties);

        // Ensure all property keys are in the required array
        const requiredSet = new Set(existingRequired);
        allPropertyKeys.forEach(key => requiredSet.add(key));

        obj.required = Array.from(requiredSet);
      }
    }

    // Recursively process nested schemas
    if (obj.properties) {
      for (const key in obj.properties) {
        enforceStrictMode(obj.properties[key]);
      }
    }

    // Process array items
    if (obj.items) {
      if (Array.isArray(obj.items)) {
        obj.items.forEach(item => enforceStrictMode(item));
      } else {
        enforceStrictMode(obj.items);
      }
    }

    // Process anyOf, allOf, oneOf
    ['anyOf', 'allOf', 'oneOf'].forEach(key => {
      if (Array.isArray(obj[key])) {
        obj[key].forEach(item => enforceStrictMode(item));
      }
    });

    return obj;
  }

  return enforceStrictMode(strictSchema);
}

/**
 * Convert generic tools to OpenAI Responses API format
 * Filters out provider-specific special tools from other providers (googleSearch, etc.)
 * @param {import('./GenericToolCalling.js').GenericTool[]} genericTools - Generic tools
 * @returns {Object[]} OpenAI Responses API formatted tools
 */
export function convertGenericToolsToOpenaiResponses(genericTools = []) {
  const tools = [];
  const functionTools = [];
  let webSearchTool = null;

  // Single pass to separate web search from regular tools
  for (const tool of genericTools) {
    // Handle webSearch specially
    if (tool.id === 'webSearch') {
      webSearchTool = tool;
      continue;
    }
    // If tool specifies this provider (or compatible), always include it
    if (tool.provider === 'openai-responses' || tool.provider === 'openai') {
      functionTools.push(tool);
      continue;
    }
    // If tool specifies a different provider, exclude it
    if (tool.provider) {
      logger.info(
        `[OpenAI Responses Converter] Filtering out provider-specific tool: ${tool.id || tool.name} (provider: ${tool.provider})`
      );
      continue;
    }
    // If tool is marked as special but has no matching provider, exclude it
    if (tool.isSpecialTool) {
      logger.info(
        `[OpenAI Responses Converter] Filtering out special tool: ${tool.id || tool.name}`
      );
      continue;
    }
    // Universal tool - include it
    functionTools.push(tool);
  }

  // Add web search if present
  if (webSearchTool) {
    const webSearchConfig = { type: 'web_search' };

    // Add optional parameters if provided in tool metadata
    // Note: These are typically set at the app level, not per-invocation
    if (webSearchTool.filters?.allowed_domains) {
      webSearchConfig.filters = {
        allowed_domains: webSearchTool.filters.allowed_domains
      };
    }

    if (webSearchTool.user_location) {
      webSearchConfig.user_location = webSearchTool.user_location;
    }

    if (webSearchTool.external_web_access !== undefined) {
      webSearchConfig.external_web_access = webSearchTool.external_web_access;
    }

    tools.push(webSearchConfig);
  }

  // Add regular function tools
  const regularTools = functionTools.map(tool => {
    const sanitizedParams = sanitizeSchemaForProvider(tool.parameters, 'openai-responses');
    const strictParams = addStrictModeToSchema(sanitizedParams);

    return {
      type: 'function',
      name: tool.id || tool.name,
      description: tool.description,
      parameters: strictParams,
      strict: true // Explicitly enable strict mode for tool calling
    };
  });

  tools.push(...regularTools);

  return tools;
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
 * Helper function to add web search metadata
 * @param {Array} webSearchMetadata - Array to store web search metadata
 * @param {Object} item - Web search call item
 */
function addWebSearchMetadata(webSearchMetadata, item) {
  webSearchMetadata.push({
    id: item.id,
    status: item.status,
    action: item.action
  });
}

/**
 * Helper function to process annotations from content items
 * @param {Object} contentItem - Content item with potential annotations
 * @param {Array} annotations - Array to store annotations
 */
function processAnnotations(contentItem, annotations) {
  if (contentItem.annotations && Array.isArray(contentItem.annotations)) {
    annotations.push(...contentItem.annotations);
  }
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
  if (!data || data === '[DONE]') {
    return createGenericStreamingResponse([], [], [], true, false, null, 'stop');
  }

  try {
    const parsed = JSON.parse(data);

    const content = [];
    const thinking = [];
    const toolCalls = [];
    const webSearchMetadata = [];
    const annotations = [];
    let complete = false;
    let finishReason = null;

    // Handle server-sent event format with type field
    if (parsed.type) {
      // Skip metadata events that don't contain content
      if (parsed.type === 'response.created' || parsed.type === 'response.in_progress') {
        return createGenericStreamingResponse([], [], [], false, false, null, null);
      }

      // Handle completion events
      if (parsed.type === 'response.completed' || parsed.type === 'response.done') {
        complete = true;

        // Check if the completion event contains output with function calls
        // The Responses API doesn't have finish_reason, so we need to check the output
        let hasToolCalls = false;
        if (parsed.response?.output && Array.isArray(parsed.response.output)) {
          hasToolCalls = parsed.response.output.some(item => item.type === 'function_call');
        }

        finishReason = hasToolCalls ? 'tool_calls' : 'stop';

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
        // The actual chunk data is in the 'delta' field
        if (parsed.delta !== undefined && parsed.delta !== null) {
          // Handle delta as a direct string (Azure OpenAI format)
          if (typeof parsed.delta === 'string') {
            content.push(parsed.delta);
          }
          // Handle text content from delta object
          else if (parsed.delta.text) {
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
        if (parsed.delta.summary && Array.isArray(parsed.delta.summary)) {
          for (const summaryItem of parsed.delta.summary) {
            if (summaryItem.type === 'text' && summaryItem.text) {
              thinking.push(summaryItem.text);
            }
          }
        }
      }

      // Handle function call streaming events (new format)
      // Event: response.output_item.added - when a new function call starts
      if (parsed.type === 'response.output_item.added' && parsed.item?.type === 'function_call') {
        // Initialize a new function call with the metadata
        toolCalls.push({
          id: parsed.item.call_id || parsed.item.id,
          type: 'function',
          index: parsed.output_index || 0,
          function: {
            name: parsed.item.name || '',
            arguments: parsed.item.arguments || ''
          }
        });
      }

      // Event: response.function_call_arguments.delta - streaming function arguments
      if (parsed.type === 'response.function_call_arguments.delta') {
        // Accumulate function call arguments as they stream in
        toolCalls.push({
          id: parsed.item_id,
          type: 'function',
          index: parsed.output_index || 0,
          function: {
            name: '', // Name already set in output_item.added
            arguments: parsed.delta || ''
          }
        });
      }

      // Event: response.function_call_arguments.done - function arguments complete
      if (parsed.type === 'response.function_call_arguments.done') {
        // Final complete arguments are available
        toolCalls.push({
          id: parsed.item_id,
          type: 'function',
          index: parsed.output_index || 0,
          function: {
            name: '', // Name already set
            arguments: parsed.arguments || ''
          },
          complete: true // Mark as complete
        });
      }

      // Event: response.output_item.done - function call completely finished
      // This provides the final complete function call with both name and arguments
      if (parsed.type === 'response.output_item.done' && parsed.item?.type === 'function_call') {
        toolCalls.push({
          id: parsed.item.call_id || parsed.item.id,
          type: 'function',
          index: parsed.output_index || 0,
          function: {
            name: parsed.item.name || '',
            arguments: parsed.item.arguments || ''
          },
          complete: true // Mark as complete
        });
      }

      // Event: response.output_item.done - web search call finished
      // Handle web search completion events
      if (parsed.type === 'response.output_item.done' && parsed.item?.type === 'web_search_call') {
        // Store web search metadata for tracking
        addWebSearchMetadata(webSearchMetadata, parsed.item);
      }
    }
    // Handle full response object (non-streaming)
    else if (parsed.output && Array.isArray(parsed.output)) {
      for (const item of parsed.output) {
        // Handle regular message content
        if (item.type === 'message' && item.content) {
          for (const contentItem of item.content) {
            if (contentItem.type === 'output_text' && contentItem.text) {
              content.push(contentItem.text);

              // Handle annotations (citations) from web search results
              processAnnotations(contentItem, annotations);
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
        // Handle web search calls
        else if (item.type === 'web_search_call') {
          // Store web search metadata for tracking
          addWebSearchMetadata(webSearchMetadata, item);
        }
      }
      complete = true;
      // Set finish reason based on whether tool calls are present
      finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
    }
    // Handle legacy streaming chunks format
    else if (parsed.output_chunk) {
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
    }

    // Check for completion in legacy format
    if (parsed.status === 'completed' || parsed.output_status === 'completed') {
      complete = true;
      // Set finish reason based on whether tool calls are present
      finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
    }

    // Convert tool calls to generic format
    const genericToolCalls =
      toolCalls.length > 0 ? convertOpenaiResponsesToolCallsToGeneric(toolCalls) : [];

    // Build metadata object with web search data if available
    const metadata = {};
    if (webSearchMetadata.length > 0) {
      metadata.webSearchMetadata = webSearchMetadata;
    }
    if (annotations.length > 0) {
      metadata.annotations = annotations;
    }

    return createGenericStreamingResponse(
      content,
      thinking,
      genericToolCalls,
      complete,
      false,
      null,
      normalizeFinishReason(finishReason),
      metadata
    );
  } catch (error) {
    logger.error('Error parsing OpenAI Responses API response:', error);
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
