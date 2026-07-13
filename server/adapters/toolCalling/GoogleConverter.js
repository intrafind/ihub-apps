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
  cloneAndWalkSchema,
  normalizeToolName
} from './GenericToolCalling.js';
import { isPlausibleToolName, describeInvalidToolName } from './toolNameValidator.js';
import logger from '../../utils/logger.js';
import { parseJsonAsync } from '../../utils/asyncJson.js';

const HALLUCINATION_NOTICE_PREFIX = '[provider:google dropped malformed function call]';

function truncateForLog(value, max = 200) {
  if (typeof value !== 'string') return value;
  return value.length > max ? `${value.slice(0, max)}…(${value.length})` : value;
}

/**
 * Sanitize a JSON Schema for Google's restricted OpenAPI-subset tool schema
 * support: normalize non-standard `type` values, flatten multilingual
 * `description` objects to a plain string, and strip keywords Gemini's API
 * rejects with HTTP 400 ("Unknown name ...").
 * @param {Object} schema - JSON Schema
 * @returns {Object} Sanitized schema
 */
export function sanitizeSchema(schema) {
  return cloneAndWalkSchema(schema, obj => {
    // Normalize non-standard type values to valid JSON Schema types
    if (
      obj.type &&
      !['string', 'number', 'integer', 'boolean', 'array', 'object'].includes(obj.type)
    ) {
      obj.type = 'string';
    }
    // Ensure description is a plain string (not a multilingual object)
    if (obj.description && typeof obj.description === 'object') {
      obj.description = obj.description.en || Object.values(obj.description)[0] || '';
    }
    delete obj.exclusiveMaximum;
    delete obj.exclusiveMinimum;
    delete obj.title;
    delete obj.format; // Google has limited format support
    delete obj.minLength; // Use 'minimum' instead for strings
    delete obj.maxLength; // Use 'maximum' instead for strings
    // JSON Schema meta keywords that Google's restricted OpenAPI subset
    // rejects with HTTP 400 ("Unknown name ..."). MCP tools routinely emit
    // these ($schema + additionalProperties: false from their JSON Schema
    // draft), so strip them or every MCP tool call to Gemini fails.
    delete obj.$schema;
    delete obj.$id;
    delete obj.additionalProperties;
    delete obj.patternProperties;
  });
}

/**
 * Convert generic tools to Google format
 * Filters out provider-specific special tools from other providers (webSearch, etc.) —
 * Google's own native Search grounding is injected directly by the adapter (see
 * google.js), not routed through this generic tool-calling pipeline.
 * @param {import('./GenericToolCalling.js').GenericTool[]} genericTools - Generic tools
 * @returns {Object[]} Google formatted tools
 */
export function convertGenericToolsToGoogle(genericTools = []) {
  const functionTools = genericTools.filter(tool => {
    // If tool specifies this provider, always include it
    if (tool.provider === 'google') {
      return true;
    }
    // If tool specifies a different provider, exclude it
    if (tool.provider) {
      logger.info('Filtering out provider-specific tool', {
        component: 'GoogleConverter',
        toolId: tool.id || tool.name,
        provider: tool.provider
      });
      return false;
    }
    // If tool is marked as special but has no matching provider, exclude it
    if (tool.isSpecialTool) {
      logger.info('Filtering out special tool', {
        component: 'GoogleConverter',
        toolId: tool.id || tool.name
      });
      return false;
    }
    // Universal tool - include it
    return true;
  });

  if (functionTools.length === 0) return [];

  return [
    {
      functionDeclarations: functionTools.map(tool => ({
        name: normalizeToolName(tool.id),
        description: tool.description,
        parameters: sanitizeSchema(tool.parameters)
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
      if (!part.functionCall) return null;
      if (!isPlausibleToolName(part.functionCall.name)) {
        logger.warn('Dropping Google function call with malformed name', {
          component: 'GoogleConverter',
          reason: describeInvalidToolName(part.functionCall.name),
          name: truncateForLog(part.functionCall.name)
        });
        return null;
      }
      return createGenericToolCall(
        `call_${index}_${Date.now()}`, // Generate ID since Google doesn't provide one
        part.functionCall.name,
        part.functionCall.args || {},
        index,
        { originalFormat: 'google' }
      );
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
 * @returns {Promise<import('./GenericToolCalling.js').GenericStreamingResponse>} Generic streaming response
 */
export async function convertGoogleResponseToGeneric(data, _streamId = 'default') {
  const result = createGenericStreamingResponse();

  if (!data) return result;

  try {
    // Use async JSON parsing to avoid blocking the event loop
    const parsed = await parseJsonAsync(data);

    // Extract usage metadata from Google Gemini responses
    if (parsed.usageMetadata) {
      result.metadata.usage = {
        promptTokens: parsed.usageMetadata.promptTokenCount || 0,
        completionTokens: parsed.usageMetadata.candidatesTokenCount || 0,
        totalTokens: parsed.usageMetadata.totalTokenCount || 0
      };
    }

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
          if (!isPlausibleToolName(part.functionCall.name)) {
            const reason = describeInvalidToolName(part.functionCall.name);
            logger.warn('Google emitted malformed function call name; dropping', {
              component: 'GoogleConverter',
              reason,
              name: truncateForLog(part.functionCall.name)
            });
            result.content.push(
              `${HALLUCINATION_NOTICE_PREFIX} ${reason}: ${truncateForLog(part.functionCall.name, 80)}`
            );
          } else {
            // Include thoughtSignature in metadata for multi-turn conversations with thinking enabled
            const metadata = { originalFormat: 'google' };
            if (part.thoughtSignature) {
              metadata.thoughtSignature = part.thoughtSignature;
            }
            result.tool_calls.push(
              createGenericToolCall(
                `call_${result.tool_calls.length}_${Date.now()}`,
                part.functionCall.name,
                part.functionCall.args || {},
                result.tool_calls.length,
                metadata
              )
            );
            if (!result.finishReason) result.finishReason = 'tool_calls';
          }
        }
        // Collect thought signatures for multi-turn conversations (for backward compatibility)
        if (part.thoughtSignature) {
          if (!result.thoughtSignatures) result.thoughtSignatures = [];
          result.thoughtSignatures.push(part.thoughtSignature);
        }
      }
      result.complete = true;
      const fr = parsed.candidates[0].finishReason;
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
          if (!isPlausibleToolName(part.functionCall.name)) {
            const reason = describeInvalidToolName(part.functionCall.name);
            logger.warn('Google streaming emitted malformed function call name; dropping', {
              component: 'GoogleConverter',
              reason,
              name: truncateForLog(part.functionCall.name)
            });
            result.content.push(
              `${HALLUCINATION_NOTICE_PREFIX} ${reason}: ${truncateForLog(part.functionCall.name, 80)}`
            );
          } else {
            // Include thoughtSignature in metadata for multi-turn conversations with thinking enabled
            const metadata = { originalFormat: 'google' };
            if (part.thoughtSignature) {
              metadata.thoughtSignature = part.thoughtSignature;
            }
            result.tool_calls.push(
              createGenericToolCall(
                `call_${result.tool_calls.length}_${Date.now()}`,
                part.functionCall.name,
                part.functionCall.args || {},
                result.tool_calls.length,
                metadata
              )
            );
            if (!result.finishReason) result.finishReason = 'tool_calls';
          }
        }
        // Handle partial function calls during streaming - ignore incomplete ones
        else if (part.functionCall && !part.functionCall.name) {
          // Log partial function call for debugging but don't create incomplete tool calls
          logger.info('Google streaming: ignoring partial function call without name', {
            component: 'GoogleConverter',
            functionCall: part.functionCall
          });
        }
        // Collect thought signatures for multi-turn conversations (for backward compatibility)
        if (part.thoughtSignature) {
          if (!result.thoughtSignatures) result.thoughtSignatures = [];
          result.thoughtSignatures.push(part.thoughtSignature);
        }
      }
    }

    // Extract grounding metadata if present (for Google Search grounding).
    // Gemini puts this at `candidates[0].groundingMetadata` in real responses;
    // the top-level `parsed.groundingMetadata` lookup we used before only
    // matched a hypothetical shape and silently dropped every real grounding
    // payload — which is why agent runs with webSearch (auto-swapped to
    // googleSearch on Google models) never produced citations. Check the
    // candidates[0] location first and fall back to top-level for forward
    // compatibility.
    const candidateGrounding = parsed.candidates?.[0]?.groundingMetadata;
    if (candidateGrounding) {
      result.groundingMetadata = candidateGrounding;
    } else if (parsed.groundingMetadata) {
      result.groundingMetadata = parsed.groundingMetadata;
    }

    if (parsed.candidates && parsed.candidates[0]?.finishReason) {
      const fr = parsed.candidates[0].finishReason;
      // Only set finishReason from Google if we don't already have tool_calls
      // Check both the finishReason flag AND the actual tool_calls array
      // This is needed because Gemini 3.0 returns "STOP" even when making function calls
      if (result.finishReason !== 'tool_calls' && result.tool_calls.length === 0) {
        result.finishReason = normalizeFinishReason(fr, 'google');
        result.complete = true;
      } else {
        // If we have tool_calls, mark as complete but preserve the tool_calls finish reason
        result.complete = true;
      }
    }
  } catch (jsonError) {
    logger.error('Failed to parse Google response as JSON', {
      component: 'GoogleConverter',
      error: jsonError
    });
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
        logger.warn('Failed to parse tool call arguments', {
          component: 'GoogleConverter',
          error
        });
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
