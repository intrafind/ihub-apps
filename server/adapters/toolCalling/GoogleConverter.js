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
  const tools = [];

  // Separate Google Search tool from regular function-based tools
  const googleSearchTool = genericTools.find(tool => tool.id === 'googleSearch');
  const functionTools = genericTools.filter(tool => tool.id !== 'googleSearch');

  // Add Google Search grounding if present
  if (googleSearchTool) {
    tools.push({ google_search: {} });

    // Google API limitation: google_search cannot be combined with functionDeclarations
    // If both are present, prioritize google_search and warn about skipped function tools
    if (functionTools.length > 0) {
      console.warn(
        `Google API limitation: Cannot combine google_search with function calling. ` +
          `Skipping ${functionTools.length} function tool(s): ${functionTools.map(t => t.name).join(', ')}`
      );
    }
  }
  // Only add regular function declarations if google_search is NOT present
  else if (functionTools.length > 0) {
    tools.push({
      functionDeclarations: functionTools.map(tool => ({
        name: normalizeToolName(tool.id),
        description: tool.description,
        parameters: sanitizeSchemaForProvider(tool.parameters, 'google')
      }))
    });
  }

  return tools;
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
 * @param {string} streamId - Stream identifier for stateful processing (unused for Google)
 * @returns {import('./GenericToolCalling.js').GenericStreamingResponse} Generic streaming response
 */
export function convertGoogleResponseToGeneric(data, streamId = 'default') {
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
          // Check if this is thinking content
          if (part.thought === true) {
            // This is thinking content, add to thinking array
            if (!result.thinking) result.thinking = [];
            result.thinking.push(part.text);
          } else {
            // Regular content
            result.content.push(part.text);
          }
        }
        if (part.inlineData && part.inlineData.mimeType?.startsWith('image/')) {
          // Handle generated images
          // Skip interim "thought images" - only show the final image
          // According to Gemini docs, thought images are used for reasoning but not shown
          if (part.thought === true) {
            // This is an interim thought image, skip it
            continue;
          }
          if (!result.images) result.images = [];
          result.images.push({
            mimeType: part.inlineData.mimeType,
            data: part.inlineData.data,
            thoughtSignature: part.thoughtSignature || null
          });
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
        // Collect thought signatures for multi-turn conversations
        if (part.thoughtSignature) {
          if (!result.thoughtSignatures) result.thoughtSignatures = [];
          result.thoughtSignatures.push(part.thoughtSignature);
        }
      }
      // For non-streaming responses, decide if we should mark as complete
      // For thinking models: Only mark complete if we have actual content
      // If we only have thinking content, the model is still working on the response
      const fr = parsed.candidates[0].finishReason;
      if (
        fr === 'MAX_TOKENS' &&
        result.content.length === 0 &&
        result.thinking &&
        result.thinking.length > 0
      ) {
        // Model is still thinking, hasn't produced actual content yet
        result.complete = false;
      } else {
        result.complete = true;
      }
      // Only set finishReason from Google if we don't already have tool_calls
      // Check both the finishReason flag AND the actual tool_calls array
      // This is needed because Gemini 3.0 returns "STOP" even when making function calls
      if (result.finishReason !== 'tool_calls' && result.tool_calls.length === 0) {
        result.finishReason = normalizeFinishReason(fr, 'google');
      }
    }
    // Handle streaming response chunks - process content parts
    else if (parsed.candidates && parsed.candidates[0]?.content?.parts) {
      for (const part of parsed.candidates[0].content.parts) {
        if (part.text) {
          // Check if this is thinking content
          if (part.thought === true) {
            // This is thinking content, add to thinking array
            if (!result.thinking) result.thinking = [];
            result.thinking.push(part.text);
          } else {
            // Regular content
            result.content.push(part.text);
          }
        }
        if (part.inlineData && part.inlineData.mimeType?.startsWith('image/')) {
          // Handle generated images in streaming response
          // Skip interim "thought images" - only show the final image
          // According to Gemini docs, thought images are used for reasoning but not shown
          if (part.thought === true) {
            // This is an interim thought image, skip it
            continue;
          }
          if (!result.images) result.images = [];
          result.images.push({
            mimeType: part.inlineData.mimeType,
            data: part.inlineData.data,
            thoughtSignature: part.thoughtSignature || null
          });
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
        // Collect thought signatures for multi-turn conversations
        if (part.thoughtSignature) {
          if (!result.thoughtSignatures) result.thoughtSignatures = [];
          result.thoughtSignatures.push(part.thoughtSignature);
        }
      }
    }

    // Extract grounding metadata if present (for Google Search grounding)
    if (parsed.groundingMetadata) {
      result.groundingMetadata = parsed.groundingMetadata;
    }

    if (parsed.candidates && parsed.candidates[0]?.finishReason) {
      const fr = parsed.candidates[0].finishReason;
      // Only set finishReason from Google if we don't already have tool_calls
      // Check both the finishReason flag AND the actual tool_calls array
      // This is needed because Gemini 3.0 returns "STOP" even when making function calls
      if (result.finishReason !== 'tool_calls' && result.tool_calls.length === 0) {
        result.finishReason = normalizeFinishReason(fr, 'google');
        // For thinking models: Only mark complete if we have actual content
        // If we only have thinking content, the model is still working on the response
        if (
          fr !== 'MAX_TOKENS' ||
          result.content.length > 0 ||
          (result.thinking && result.thinking.length === 0)
        ) {
          result.complete = true;
        }
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
