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
  convertGenericToolsToOpenAI,
  convertOpenAIToolsToGeneric,
  convertGenericToolCallsToOpenAI,
  convertOpenAIToolCallsToGeneric
} from './OpenAIConverter.js';

import { createGenericStreamingResponse, normalizeFinishReason } from './GenericToolCalling.js';

// Mistral uses OpenAI format for tools, so we can reuse most OpenAI functions
export const convertGenericToolsToMistral = convertGenericToolsToOpenAI;
export const convertMistralToolsToGeneric = convertOpenAIToolsToGeneric;
export const convertGenericToolCallsToMistral = convertGenericToolCallsToOpenAI;
export const convertMistralToolCallsToGeneric = convertOpenAIToolCallsToGeneric;

/**
 * Convert Mistral streaming response to generic format
 * @param {string} data - Raw Mistral response data
 * @param {string} streamId - Stream identifier for stateful processing (unused for Mistral)
 * @returns {import('./GenericToolCalling.js').GenericStreamingResponse} Generic streaming response
 */
export function convertMistralResponseToGeneric(data, streamId = 'default') {
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
    console.error('Error parsing Mistral response chunk:', error);
    result.error = true;
    result.errorMessage = `Error parsing Mistral response: ${error.message}`;
  }

  return result;
}

/**
 * Convert generic streaming response to Mistral format
 * Note: Mistral uses OpenAI format, so this is similar to OpenAI conversion
 * @param {import('./GenericToolCalling.js').GenericStreamingResponse} genericResponse - Generic response
 * @param {string} completionId - Completion ID
 * @param {string} modelId - Model ID
 * @param {boolean} isFirstChunk - Whether this is the first chunk
 * @returns {Object} Mistral formatted response chunk
 */
export function convertGenericResponseToMistral(
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
        delta: isFirstChunk ? { role: 'assistant' } : {},
        finish_reason: null
      }
    ]
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
    chunk.choices[0].delta.tool_calls = convertGenericToolCallsToMistral(
      genericResponse.tool_calls
    );
  }

  // Set finish reason if complete
  if (genericResponse.complete) {
    chunk.choices[0].finish_reason = genericResponse.finishReason || 'stop';
  }

  return chunk;
}

/**
 * Convert generic streaming response to Mistral non-streaming format
 * @param {import('./GenericToolCalling.js').GenericStreamingResponse} genericResponse - Generic response
 * @param {string} completionId - Completion ID
 * @param {string} modelId - Model ID
 * @returns {Object} Mistral formatted complete response
 */
export function convertGenericResponseToMistralNonStreaming(
  genericResponse,
  completionId,
  modelId
) {
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

  // Add tool calls if present
  if (genericResponse.tool_calls && genericResponse.tool_calls.length > 0) {
    response.choices[0].message.tool_calls = convertGenericToolCallsToMistral(
      genericResponse.tool_calls
    );
  }

  return response;
}

/**
 * Process message content for Mistral format, handling tool calls and results
 * Note: Mistral uses OpenAI-compatible message format
 * @param {Object} message - Message with potential tool calls or results
 * @returns {Object} Processed message for Mistral API
 */
export function processMessageForMistral(message) {
  // Mistral uses the same message format as OpenAI, so we can return as-is
  // with some basic validation
  const processedMessage = { ...message };

  // Ensure tool call arguments are strings for Mistral
  if (processedMessage.tool_calls) {
    processedMessage.tool_calls = processedMessage.tool_calls.map(toolCall => ({
      ...toolCall,
      function: {
        ...toolCall.function,
        arguments:
          typeof toolCall.function.arguments === 'string'
            ? toolCall.function.arguments
            : JSON.stringify(toolCall.function.arguments)
      }
    }));
  }

  return processedMessage;
}
