/**
 * iAssistant Tool Calling Converter
 *
 * Converts iAssistant responses to/from generic format
 * iAssistant uses a custom SSE streaming format and does not support tool calling
 */

import { createGenericStreamingResponse, normalizeFinishReason } from './GenericToolCalling.js';
import logger from '../../utils/logger.js';

/**
 * Convert iAssistant streaming response to generic format
 * @param {string|Object} data - iAssistant response data (JSON string or object)
 * @param {string} streamId - Stream identifier
 * @returns {import('./GenericToolCalling.js').GenericStreamingResponse}
 */
export function convertIassistantResponseToGeneric(data, _streamId) {
  // Create result with properly initialized arrays
  const result = createGenericStreamingResponse();
  result.tool_calls = []; // iAssistant doesn't support tool calling

  try {
    // Handle different input types
    if (typeof data === 'string') {
      // Handle raw SSE buffer - process it directly
      if (data.includes('event:') || data.includes('data:')) {
        // Split buffer by lines and process each SSE event
        const lines = data.split('\n');
        let currentEvent = null;
        let currentData = '';

        for (const line of lines) {
          const trimmedLine = line.trim();

          if (trimmedLine.startsWith('event:')) {
            // New event type
            if (currentEvent && currentData) {
              processSSEEvent(currentEvent, currentData, result);
            }
            currentEvent = trimmedLine.substring(6).trim();
            currentData = '';
          } else if (trimmedLine.startsWith('data:')) {
            // Event data
            const eventData = trimmedLine.substring(5).trim();
            currentData += eventData;
          } else if (trimmedLine.startsWith('id:')) {
            // Event ID (we don't need to process this for now)
            continue;
          } else if (trimmedLine === '') {
            // Empty line indicates end of event
            if (currentEvent && currentData) {
              processSSEEvent(currentEvent, currentData, result);
              currentEvent = null;
              currentData = '';
            }
          }
        }

        // Process final event if buffer doesn't end with empty line
        if (currentEvent && currentData) {
          processSSEEvent(currentEvent, currentData, result);
        } else if (!currentEvent && currentData) {
          // Handle case where we have data but no explicit event type (iAssistant format)
          // iAssistant sends data lines like: data:{"answer":"text","eventType":"answer"}
          // without preceding event: lines
          try {
            const parsed = JSON.parse(currentData);
            if (parsed.eventType) {
              // Use the eventType from the data itself
              processSSEEvent(parsed.eventType, currentData, result);
            }
          } catch (error) {
            logger.error('[IAssistant Converter] Failed to parse JSON data:', error);
          }
        }

        return result;
      }

      // Handle single SSE line formats
      if (data.startsWith('data:')) {
        const jsonData = data.substring(5).trim(); // Remove "data:" prefix
        if (jsonData) {
          try {
            const parsedData = JSON.parse(jsonData);
            // Process the parsed JSON data correctly
            return convertParsedDataToGeneric(parsedData, result);
          } catch {
            // If not JSON after removing data: prefix, ignore this chunk
            return result;
          }
        } else {
          // Empty data after "data:"
          return result;
        }
      } else if (data.startsWith('id:')) {
        // SSE ID lines, ignore
        return result;
      } else {
        // Try to parse as JSON
        try {
          const parsedData = JSON.parse(data);
          return convertParsedDataToGeneric(parsedData, result);
        } catch {
          // If not JSON, treat as plain text content
          result.content.push(data);
          return result;
        }
      }
    } else if (data && typeof data === 'object') {
      // Handle already parsed object
      return convertParsedDataToGeneric(data, result);
    }
  } catch (error) {
    // Return empty result on error
    logger.error('Error converting iAssistant response:', error);
  }

  return result;
}

/**
 * Process individual SSE event
 * @param {string} eventType - Event type
 * @param {string} data - Event data
 * @param {Object} result - Result object to modify
 */
function processSSEEvent(eventType, data, result) {
  try {
    if (!data) return;

    // Try to parse event data as JSON
    let parsedData;
    try {
      parsedData = JSON.parse(data);
    } catch {
      // If not JSON, treat as plain text for answer events
      if (eventType === 'answer') {
        result.content.push(data);
      }
      return;
    }

    // Process based on event type and parsed data
    switch (eventType) {
      case 'answer':
        if (parsedData.answer) {
          result.content.push(parsedData.answer);
        } else if (typeof parsedData === 'string') {
          result.content.push(parsedData);
        }
        break;

      case 'done':
      case 'end':
      case 'complete':
      case 'final':
        result.complete = true;
        result.finishReason = normalizeFinishReason('stop', 'iassistant');
        break;

      case 'related':
        if (parsedData.questions) {
          result.metadata.related_questions = parsedData.questions.related_questions || [];
        }
        break;

      case 'passages':
        if (parsedData.passages) {
          result.metadata.passages = parsedData.passages;
        }
        break;

      case 'telemetry':
        if (parsedData.telemetry) {
          result.metadata.telemetry = parsedData.telemetry;
        }
        break;
    }
  } catch (error) {
    logger.error('Error processing SSE event:', { eventType, error: error.message });
  }
}

/**
 * Convert parsed iAssistant data to generic format
 * @param {Object} parsedData - Parsed iAssistant data
 * @param {Object} result - Generic result object to populate
 * @returns {Object} Generic streaming response
 */
function convertParsedDataToGeneric(parsedData, result) {
  // Handle iAssistant JSON event format
  switch (parsedData.eventType) {
    case 'answer':
      if (parsedData.answer) {
        result.content.push(parsedData.answer);
      }
      break;

    case 'done':
    case 'end':
    case 'complete':
    case 'final':
      result.complete = true;
      result.finishReason = normalizeFinishReason('stop', 'iassistant');
      break;

    case 'related':
      // Handle related questions - store in metadata, don't send as content
      if (parsedData.questions) {
        result.metadata.related_questions = parsedData.questions.related_questions || [];
      }
      break;

    case 'passages':
      // Handle passages data - store in metadata
      if (parsedData.passages) {
        result.metadata.passages = parsedData.passages;
      }
      break;

    case 'telemetry':
      // Handle telemetry data - store in metadata
      if (parsedData.telemetry) {
        result.metadata.telemetry = parsedData.telemetry;
      }
      break;

    default:
      // Handle processed iAssistant response object (legacy format)
      if (parsedData.content && Array.isArray(parsedData.content)) {
        result.content.push(...parsedData.content);

        if (parsedData.complete) {
          result.complete = true;
          if (parsedData.finishReason) {
            result.finishReason = normalizeFinishReason(parsedData.finishReason, 'iassistant');
          }
        }

        // Preserve iAssistant-specific data in metadata
        if (parsedData.passages || parsedData.telemetry) {
          result.metadata = {
            passages: parsedData.passages || [],
            telemetry: parsedData.telemetry || null
          };
        }
      }
      break;
  }

  return result;
}

/**
 * Convert generic streaming response to iAssistant format
 * @param {import('./GenericToolCalling.js').GenericStreamingResponse} genericResponse
 * @returns {Object} iAssistant-formatted response
 */
export function convertGenericToIassistantResponse(genericResponse) {
  return {
    content: genericResponse.content,
    complete: genericResponse.complete,
    finishReason: genericResponse.finishReason,
    passages: genericResponse.metadata?.passages || [],
    telemetry: genericResponse.metadata?.telemetry || null,
    tool_calls: [] // iAssistant doesn't support tool calling
  };
}

/**
 * Get supported tool calling capabilities for iAssistant
 * @returns {Object} Capabilities object
 */
export function getIassistantCapabilities() {
  return {
    supportsToolCalling: false,
    supportsParallelCalls: false,
    supportsStreaming: true,
    toolCallFormat: null
  };
}
