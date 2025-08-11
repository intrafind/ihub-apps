import { actionTracker } from '../../actionTracker.js';
import config from '../../config.js';
import { throttledFetch } from '../../requestThrottler.js';
import { getIFinderAuthorizationHeader } from '../../utils/iFinderJwt.js';
import configCache from '../../configCache.js';
import authDebugService from '../../utils/authDebugService.js';

/**
 * iAssistant Service Class
 * Provides RAG-based question answering functionality using the iAssistant API
 * (which is built on top of iFinder infrastructure)
 */

class IAssistantService {
  constructor() {
    this.platform = null;
    this.config = null;
  }

  /**
   * Get iAssistant API configuration
   * @returns {Object} iAssistant API configuration
   */
  getConfig() {
    if (!this.config) {
      this.platform = configCache.getPlatform() || {};
      const iAssistantConfig = this.platform.iAssistant || {};

      this.config = {
        baseUrl:
          config.IASSISTANT_API_URL ||
          process.env.IASSISTANT_API_URL ||
          iAssistantConfig.baseUrl,
        endpoint: iAssistantConfig.endpoint || '/internal-api/v2/rag/ask',
        defaultProfileId:
          iAssistantConfig.defaultProfileId ||
          process.env.IASSISTANT_PROFILE_ID ||
          'c2VhcmNocHJvZmlsZS1zdGFuZGFyZA==',
        defaultFilter: iAssistantConfig.defaultFilter || [],
        defaultSearchMode: iAssistantConfig.defaultSearchMode || 'multiword',
        defaultSearchDistance: iAssistantConfig.defaultSearchDistance || '',
        defaultSearchFields: iAssistantConfig.defaultSearchFields || {},
        timeout: iAssistantConfig.timeout || config.IASSISTANT_TIMEOUT || 60000
      };
    }
    return this.config;
  }

  /**
   * Validate common parameters
   * @param {Object} user - User object
   * @param {string} chatId - Chat ID for tracking
   */
  validateCommon(user, chatId) {
    if (!user || user.id === 'anonymous') {
      throw new Error('iAssistant access requires authenticated user');
    }
    if (!chatId) {
      throw new Error('Chat ID is required for tracking');
    }
  }

  /**
   * Encode profileId to base64 if it's not already encoded
   * @param {string} profileId - Profile ID (plain text or base64)
   * @returns {string} Base64 encoded profile ID
   */
  encodeProfileId(profileId) {
    if (!profileId) {
      return profileId;
    }

    // Check if it's already base64 encoded by trying to decode it
    try {
      const decoded = Buffer.from(profileId, 'base64').toString('utf-8');
      // If decoding succeeds and the re-encoded version matches, it's already base64
      if (Buffer.from(decoded, 'utf-8').toString('base64') === profileId) {
        return profileId;
      }
    } catch {
      // Decoding failed, so it's likely plain text
    }

    // Encode plain text to base64
    const encoded = Buffer.from(profileId, 'utf-8').toString('base64');
    return encoded;
  }

  /**
   * Ask a question using iAssistant RAG
   * @param {Object} params - Question parameters
   * @returns {Object} Streaming response or complete answer
   */
  async ask({
    question,
    chatId,
    user,
    profileId,
    filter,
    searchMode,
    searchDistance,
    searchFields,
    scope,
    streaming = false
  }) {
    if (!question) {
      throw new Error('Question parameter is required');
    }
    this.validateCommon(user, chatId);

    const config = this.getConfig();
    const rawProfileId = profileId || config.defaultProfileId;
    const actualProfileId = this.encodeProfileId(rawProfileId);
    const actualFilter = filter || config.defaultFilter;
    const actualSearchMode = searchMode || config.defaultSearchMode;
    const actualSearchDistance = searchDistance || config.defaultSearchDistance;
    const actualSearchFields = searchFields || config.defaultSearchFields;


    // Track the action
    actionTracker.trackAction(chatId, {
      action: 'iassistant_ask',
      question: question,
      profileId: actualProfileId,
      user: user.email
    });

    try {
      // Generate JWT token for the user
      const authHeader = getIFinderAuthorizationHeader(user, {
        scope: scope || 'fa_index_read'
      });

      // Log authentication header with proper masking
      authDebugService.log('iAssistant', 'info', 'JWT token generated for RAG request', {
        userId: user.id,
        userName: user.name,
        userGroups: user.groups,
        authHeader: authHeader,
        profileId: actualProfileId
      });

      // Construct URL
      const uuid = `ifs-ihub-chat-request-${Date.now()}`;
      const url = new URL(`${config.baseUrl}${config.endpoint}`);
      url.searchParams.set('uuid', uuid);
      url.searchParams.set('searchFields', JSON.stringify(actualSearchFields));
      url.searchParams.set('sSearchMode', actualSearchMode);
      url.searchParams.set('sSearchDistance', actualSearchDistance);

      const requestBody = {
        question,
        filter: actualFilter,
        profileId: actualProfileId,
        metaData: true,
        telemetry: true
      };

      const headers = {
        Accept: 'text/event-stream', // iAssistant always uses SSE streaming
        'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8,de;q=0.7',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        Origin: config.baseUrl,
        Pragma: 'no-cache',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent': 'Mozilla/5.0 (compatible; iHub-Apps/1.0)',
        'content-type': 'application/json',
        'sec-ch-ua': '"iHub-Apps";v="1.0"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Server"',
        Authorization: authHeader
      };

      // Make API request
      const response = await throttledFetch('iAssistantAsk', url.toString(), {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        timeout: config.timeout
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(
          `iAssistant Ask: Error for question "${question}" with profile "${actualProfileId}":`,
          errorText
        );
        throw new Error(`iAssistant ask failed with status ${response.status}: ${errorText}`);
      }

      if (streaming) {
        // Return the response object for streaming handling (adapter use)
        return response;
      } else {
        // Process streaming response for tool use - collect all chunks
        return await this.collectStreamingResponse(response);
      }
    } catch (error) {
      console.error('iAssistant ask error:', error);
      this._handleError(error);
    }
  }

  /**
   * Process a complete (non-streaming) response
   * @param {Object} data - Response data
   * @returns {Object} Processed response
   */
  processCompleteResponse(data) {
    return {
      answer: data.answer || '',
      passages: data.passages || [],
      telemetry: data.telemetry || null,
      metadata: data.metadata || {},
      complete: true
    };
  }

  /**
   * Collect streaming response for tool use
   * @param {Response} response - Fetch response object
   * @returns {Object} Complete collected response
   */
  async collectStreamingResponse(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const result = {
      answer: '',
      passages: [],
      telemetry: null,
      metadata: {},
      complete: false
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;

        // Process complete SSE events
        if (buffer.includes('\n\n')) {
          const parts = buffer.split('\n\n');
          const completeEvents = parts.slice(0, -1).join('\n\n');
          const remainingData = parts[parts.length - 1];

          if (completeEvents) {
            const streamingResult = this.processStreamingBuffer(completeEvents + '\n\n');

            // Accumulate content
            if (streamingResult.content && streamingResult.content.length > 0) {
              result.answer += streamingResult.content.join('');
            }

            // Store other data
            if (streamingResult.passages && streamingResult.passages.length > 0) {
              result.passages = streamingResult.passages;
            }

            if (streamingResult.telemetry) {
              result.telemetry = streamingResult.telemetry;
            }

            // Check if complete
            if (streamingResult.complete) {
              result.complete = true;
              break;
            }
          }

          buffer = remainingData;
        }
      }

      // Process any remaining data
      if (buffer.trim() && !result.complete) {
        const streamingResult = this.processStreamingBuffer(buffer);

        if (streamingResult.content && streamingResult.content.length > 0) {
          result.answer += streamingResult.content.join('');
        }

        if (streamingResult.passages && streamingResult.passages.length > 0) {
          result.passages = streamingResult.passages;
        }

        if (streamingResult.telemetry) {
          result.telemetry = streamingResult.telemetry;
        }

        result.complete = true;
      }

      return result;
    } catch (error) {
      console.error('iAssistant: Error collecting streaming response:', error);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Process Server-Sent Events streaming data
   * @param {string} buffer - SSE buffer content
   * @returns {Object} Processed streaming result
   */
  processStreamingBuffer(buffer) {
    const result = {
      content: [],
      complete: false,
      finishReason: null,
      passages: [],
      telemetry: null
    };

    // Split buffer by lines and process each SSE event
    const lines = buffer.split('\n');
    let currentEvent = null;
    let currentData = '';

    for (const line of lines) {
      const trimmedLine = line.trim();

      if (trimmedLine.startsWith('event:')) {
        // New event type
        if (currentEvent && currentData) {
          this.processStreamingEvent(currentEvent, currentData, result);
        }
        currentEvent = trimmedLine.substring(6).trim();
        currentData = '';
      } else if (trimmedLine.startsWith('data:')) {
        // Event data
        const data = trimmedLine.substring(5).trim();
        currentData += data;
      } else if (trimmedLine.startsWith('id:')) {
        // Event ID (we don't need to process this for now)
        continue;
      } else if (trimmedLine === '') {
        // Empty line indicates end of event
        if (currentEvent && currentData) {
          this.processStreamingEvent(currentEvent, currentData, result);
          currentEvent = null;
          currentData = '';
        }
      }
    }

    // Process final event if buffer doesn't end with empty line
    if (currentEvent && currentData) {
      this.processStreamingEvent(currentEvent, currentData, result);
    }

    return result;
  }

  /**
   * Process individual SSE event
   * @param {string} eventType - Event type
   * @param {string} data - Event data
   * @param {Object} result - Result object to modify
   */
  processStreamingEvent(eventType, data, result) {
    try {
      switch (eventType) {
        case 'telemetry':
          const telemetryData = JSON.parse(data);
          result.telemetry = telemetryData.telemetry
            ? JSON.parse(telemetryData.telemetry)
            : telemetryData;
          break;

        case 'passages':
          const passagesData = JSON.parse(data);
          if (passagesData.passages && Array.isArray(passagesData.passages)) {
            result.passages = passagesData.passages;
          }
          break;

        case 'answer':
          const answerData = JSON.parse(data);
          if (answerData.answer) {
            result.content.push(answerData.answer);
          }
          break;

        case 'done':
        case 'end':
        case 'complete':
          result.complete = true;
          result.finishReason = 'stop';
          break;

        default:
          // Check if the data itself contains completion info
          try {
            const parsed = JSON.parse(data);
            if (
              parsed.eventType === 'complete' ||
              parsed.eventType === 'done' ||
              parsed.eventType === 'end'
            ) {
              result.complete = true;
              result.finishReason = 'stop';
            }
          } catch (parseError) {
            // Ignore parsing errors for unknown event types
          }
          break;
      }
    } catch (error) {
      console.error(`Error processing iAssistant event ${eventType}:`, error.message);
    }
  }

  /**
   * Handle errors consistently across all methods
   * @param {Error} error - The error to handle
   */
  _handleError(error) {
    if (error.message.includes('JWT') || error.message.includes('authentication')) {
      throw new Error('iAssistant authentication failed. Please check JWT configuration.');
    }

    if (error.message.includes('timeout')) {
      throw new Error('iAssistant request timed out. Please try again.');
    }

    throw new Error(`iAssistant operation failed: ${error.message}`);
  }
}

// Export singleton instance
export default new IAssistantService();
