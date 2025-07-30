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
  return genericToolCalls.map(toolCall => ({
    id: toolCall.id,
    type: 'function',
    function: {
      name: toolCall.name,
      arguments: typeof toolCall.arguments === 'string' 
        ? toolCall.arguments 
        : JSON.stringify(toolCall.arguments)
    }
  }));
}

/**
 * Convert OpenAI tool calls to generic format
 * @param {Object[]} openaiToolCalls - OpenAI formatted tool calls
 * @returns {import('./GenericToolCalling.js').GenericToolCall[]} Generic tool calls
 */
export function convertOpenAIToolCallsToGeneric(openaiToolCalls = []) {
  return openaiToolCalls.map((toolCall, index) => {
    let args = {};
    try {
      args = typeof toolCall.function.arguments === 'string'
        ? JSON.parse(toolCall.function.arguments)
        : toolCall.function.arguments;
    } catch (error) {
      console.warn('Failed to parse OpenAI tool call arguments:', error);
      args = {};
    }
    
    return createGenericToolCall(
      toolCall.id,
      toolCall.function.name,
      args,
      index,
      { originalFormat: 'openai', type: toolCall.type || 'function' }
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
        result.tool_calls.push(...convertOpenAIToolCallsToGeneric(parsed.choices[0].message.tool_calls));
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
export function convertGenericResponseToOpenAI(genericResponse, completionId, modelId, isFirstChunk = false) {
  const chunk = {
    id: completionId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{
      index: 0,
      delta: isFirstChunk ? { role: 'assistant' } : {},
      finish_reason: null
    }]
  };
  
  // Add content if present
  if (genericResponse.content && genericResponse.content.length > 0) {
    const content = genericResponse.content.join('');
    if (content) {
      chunk.choices[0].delta.content = content;
    }
  }
  
  // Add tool calls if present
  if (genericResponse.tool_calls && genericResponse.tool_calls.length > 0) {
    chunk.choices[0].delta.tool_calls = convertGenericToolCallsToOpenAI(genericResponse.tool_calls);
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
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: genericResponse.content.join('') || null
      },
      finish_reason: genericResponse.finishReason || 'stop'
    }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };
  
  // Add tool calls if present
  if (genericResponse.tool_calls && genericResponse.tool_calls.length > 0) {
    response.choices[0].message.tool_calls = convertGenericToolCallsToOpenAI(genericResponse.tool_calls);
  }
  
  return response;
}