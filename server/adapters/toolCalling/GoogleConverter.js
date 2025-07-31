/**
 * Google Gemini Tool Calling Converter
 *
 * Handles bidirectional conversion between Google Gemini's tool calling format
 * and the generic tool calling format.
 */

import {
  createGenericTool,
  createGenericToolCall,
  createGenericStreamingResponse,
  normalizeFinishReason,
  sanitizeSchemaForProvider,
  normalizeToolName
} from './GenericToolCalling.js';

/**
 * Convert generic tools to Google format
 * @param {import('./GenericToolCalling.js').GenericTool[]} genericTools - Generic tools
 * @returns {Object[]} Google formatted tools
 */
export function convertGenericToolsToGoogle(genericTools = []) {
  return [
    {
      functionDeclarations: genericTools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: sanitizeSchemaForProvider(tool.parameters, 'google')
      }))
    }
  ];
}

/**
 * Convert Google tools to generic format
 * @param {Object[]} googleTools - Google formatted tools (tool objects)
 * @returns {import('./GenericToolCalling.js').GenericTool[]} Generic tools
 */
export function convertGoogleToolsToGeneric(googleTools = []) {
  const genericTools = [];

  for (const toolObj of googleTools) {
    if (toolObj.functionDeclarations && Array.isArray(toolObj.functionDeclarations)) {
      for (const func of toolObj.functionDeclarations) {
        genericTools.push(
          createGenericTool(
            func.name, // Use name as ID
            func.name,
            func.description || '',
            func.parameters || { type: 'object', properties: {} },
            { originalFormat: 'google' }
          )
        );
      }
    }
  }

  return genericTools;
}

/**
 * Convert generic tool calls to Google format (for message parts)
 * @param {import('./GenericToolCalling.js').GenericToolCall[]} genericToolCalls - Generic tool calls
 * @returns {Object[]} Google formatted function call parts
 */
export function convertGenericToolCallsToGoogle(genericToolCalls = []) {
  return genericToolCalls.map(toolCall => ({
    functionCall: {
      name: normalizeToolName(toolCall.name),
      args: toolCall.arguments || {}
    }
  }));
}

/**
 * Convert Google function calls to generic format
 * @param {Object[]} googleFunctionCalls - Google function call parts
 * @returns {import('./GenericToolCalling.js').GenericToolCall[]} Generic tool calls
 */
export function convertGoogleFunctionCallsToGeneric(googleFunctionCalls = []) {
  return googleFunctionCalls
    .map((part, index) => {
      if (part.functionCall) {
        return createGenericToolCall(
          `call_${index}_${Date.now()}`, // Generate ID since Google doesn't provide one
          part.functionCall.name,
          part.functionCall.args || {},
          index,
          { originalFormat: 'google' }
        );
      }
      return null;
    })
    .filter(Boolean);
}

/**
 * Convert generic tool result to Google format
 * @param {import('./GenericToolCalling.js').GenericToolResult} genericResult - Generic tool result
 * @returns {Object} Google formatted function response part
 */
export function convertGenericToolResultToGoogle(genericResult) {
  let responseObj = genericResult.content;

  // Ensure response is an object for Google
  if (typeof responseObj !== 'object' || responseObj === null) {
    responseObj = { result: responseObj };
  }

  return {
    functionResponse: {
      name: normalizeToolName(genericResult.name),
      response: responseObj
    }
  };
}

/**
 * Convert Google function response to generic format
 * @param {Object} googleResponse - Google function response part
 * @returns {import('./GenericToolCalling.js').GenericToolResult} Generic tool result
 */
export function convertGoogleFunctionResponseToGeneric(googleResponse) {
  return {
    tool_call_id: googleResponse.functionResponse.name, // Google doesn't have call IDs, use name
    name: googleResponse.functionResponse.name,
    content: googleResponse.functionResponse.response,
    is_error: false, // Google doesn't explicitly mark errors in function responses
    metadata: { originalFormat: 'google' }
  };
}

/**
 * Convert Google streaming response to generic format
 * @param {string} data - Raw Google response data
 * @returns {import('./GenericToolCalling.js').GenericStreamingResponse} Generic streaming response
 */
export function convertGoogleResponseToGeneric(data) {
  const result = createGenericStreamingResponse();

  if (!data) return result;

  try {
    const parsed = JSON.parse(data);

    // Handle full response object (non-streaming) - detect by presence of finishReason at the top level
    if (
      parsed.candidates &&
      parsed.candidates[0]?.finishReason &&
      parsed.candidates[0]?.content?.parts?.[0]
    ) {
      // This is a complete non-streaming response
      for (const part of parsed.candidates[0].content.parts) {
        if (part.text) {
          result.content.push(part.text);
        }
        if (part.functionCall && part.functionCall.name) {
          // Only create tool call if we have a valid name
          result.tool_calls.push(
            createGenericToolCall(
              `call_${result.tool_calls.length}_${Date.now()}`,
              part.functionCall.name,
              part.functionCall.args || {},
              result.tool_calls.length,
              { originalFormat: 'google' }
            )
          );
          if (!result.finishReason) result.finishReason = 'tool_calls';
        }
      }
      result.complete = true;
      const fr = parsed.candidates[0].finishReason;
      // Only set finishReason from Google if we don't already have tool_calls
      if (result.finishReason !== 'tool_calls') {
        result.finishReason = normalizeFinishReason(fr, 'google');
      }
    }
    // Handle streaming response chunks - process content parts
    else if (parsed.candidates && parsed.candidates[0]?.content?.parts) {
      for (const part of parsed.candidates[0].content.parts) {
        if (part.text) {
          result.content.push(part.text);
        }
        if (part.functionCall && part.functionCall.name) {
          // Only create tool call if we have a valid name (non-empty)
          // This prevents creating tool calls with empty names during streaming
          result.tool_calls.push(
            createGenericToolCall(
              `call_${result.tool_calls.length}_${Date.now()}`,
              part.functionCall.name,
              part.functionCall.args || {},
              result.tool_calls.length,
              { originalFormat: 'google' }
            )
          );
          if (!result.finishReason) result.finishReason = 'tool_calls';
        }
        // Handle partial function calls during streaming - ignore incomplete ones
        else if (part.functionCall && !part.functionCall.name) {
          // Log partial function call for debugging but don't create incomplete tool calls
          console.log(
            'Google streaming: Ignoring partial function call without name:',
            part.functionCall
          );
        }
      }
    }

    if (parsed.candidates && parsed.candidates[0]?.finishReason) {
      const fr = parsed.candidates[0].finishReason;
      // Only set finishReason from Google if we don't already have tool_calls
      if (result.finishReason !== 'tool_calls') {
        result.finishReason = normalizeFinishReason(fr, 'google');
        result.complete = true;
      } else {
        // If we have tool_calls, mark as complete but preserve the tool_calls finish reason
        result.complete = true;
      }
    }
  } catch (jsonError) {
    console.error('Failed to parse Google response as JSON:', jsonError.message);
    result.error = true;
    result.errorMessage = `Error parsing Google response: ${jsonError.message}`;

    // Try regex fallback for malformed JSON
    const textMatches = data.match(/"text":\s*"([^"]*)"/g);
    if (textMatches) {
      for (const match of textMatches) {
        const textContent = match.replace(/"text":\s*"/, '').replace(/"$/, '');
        result.content.push(textContent);
      }
    }

    if (data.includes('"finishReason": "STOP"') || data.includes('"finishReason":"STOP"')) {
      result.finishReason = 'stop';
      result.complete = true;
      result.error = false; // Clear error if we could extract some content
    }
  }

  return result;
}

/**
 * Convert generic streaming response to Google format
 * Note: This is primarily for testing/debugging as we typically don't need to convert back to Google format
 * @param {import('./GenericToolCalling.js').GenericStreamingResponse} genericResponse - Generic response
 * @returns {Object} Google formatted response (simplified)
 */
export function convertGenericResponseToGoogle(genericResponse) {
  const parts = [];

  // Add text content
  if (genericResponse.content && genericResponse.content.length > 0) {
    const textContent = genericResponse.content.join('');
    if (textContent) {
      parts.push({
        text: textContent
      });
    }
  }

  // Add function calls
  if (genericResponse.tool_calls && genericResponse.tool_calls.length > 0) {
    for (const toolCall of genericResponse.tool_calls) {
      parts.push({
        functionCall: {
          name: toolCall.name,
          args: toolCall.arguments
        }
      });
    }
  }

  const response = {
    candidates: [
      {
        content: {
          parts,
          role: 'model'
        },
        finishReason:
          genericResponse.finishReason === 'tool_calls'
            ? 'FUNCTION_CALL'
            : genericResponse.finishReason === 'stop'
              ? 'STOP'
              : genericResponse.finishReason === 'length'
                ? 'MAX_TOKENS'
                : genericResponse.finishReason === 'content_filter'
                  ? 'SAFETY'
                  : 'STOP',
        index: 0,
        safetyRatings: []
      }
    ],
    promptFeedback: {
      safetyRatings: []
    }
  };

  return response;
}

/**
 * Process message content for Google format, handling tool calls and results
 * @param {Object} message - Message with potential tool calls or results
 * @returns {Object} Processed message for Google API
 */
export function processMessageForGoogle(message) {
  if (message.role === 'tool') {
    // Convert tool result to Google format
    let responseObj;
    try {
      responseObj =
        typeof message.content === 'string' ? JSON.parse(message.content) : message.content;
    } catch {
      responseObj = { result: message.content };
    }

    return {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: normalizeToolName(message.name || message.tool_call_id || 'unknown'),
            response: responseObj
          }
        }
      ]
    };
  } else if (message.role === 'assistant' && message.tool_calls) {
    // Convert assistant message with tool calls
    const parts = [];

    if (message.content) {
      parts.push({ text: message.content });
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

      parts.push({
        functionCall: {
          name: normalizeToolName(toolCall.function.name),
          args
        }
      });
    }

    return { role: 'model', parts };
  }

  // Convert role names for Google
  const googleRole = message.role === 'assistant' ? 'model' : 'user';

  if (typeof message.content === 'string') {
    return {
      role: googleRole,
      parts: [{ text: message.content }]
    };
  }

  // Return message as-is for other cases
  return { ...message, role: googleRole };
}
