/**
 * iAssistant API adapter for iHub Apps
 * Handles one-shot queries with Server-Sent Events (SSE) streaming
 * Uses JWT authentication for user-specific access
 */
import { BaseAdapter } from './BaseAdapter.js';
import { getIFinderAuthorizationHeader } from '../utils/iFinderJwt.js';

class IAssistantAdapterClass extends BaseAdapter {
  /**
   * Format messages for iAssistant API
   * iAssistant only supports one-shot queries, so we only use the last user message
   */
  formatMessages(messages) {
    // Find the last user message (iFinder doesn't support chat history)
    const lastUserMessage = [...messages].reverse().find(msg => msg.role === 'user');

    if (!lastUserMessage) {
      throw new Error('No user message found for iAssistant query');
    }

    // Return just the text content of the last message
    return lastUserMessage.content;
  }

  /**
   * Create a completion request for iAssistant
   * @param {Object} model - The model configuration
   * @param {Array} messages - The messages to send
   * @param {string} apiKey - Not used for iAssistant (JWT generated from user)
   * @param {Object} options - Additional options including user context and app config
   */
  createCompletionRequest(model, messages, apiKey, options = {}) {
    const question = this.formatMessages(messages);

    // Extract iAssistant-specific configuration from app config first, then fall back to model config
    const appConfig = options.appConfig?.iassistant || {};
    const modelConfig = model.config || {};

    const {
      baseUrl = 'https://dama.dev.intrafind.io',
      uuid = `ifs-ihub-chat-request-${Date.now()}`,
      searchFields = {},
      searchMode = 'multiword',
      searchDistance = '',
      profileId = 'c2VhcmNocHJvZmlsZS1zdGFuZGFyZA==',
      filter = [{ key: 'application.keyword', values: ['PDF'], isNegated: false }]
    } = { ...modelConfig, ...appConfig };

    const url = new URL(`${baseUrl}/internal-api/v2/rag/ask`);
    url.searchParams.set('uuid', uuid);
    url.searchParams.set('searchFields', JSON.stringify(searchFields));
    url.searchParams.set('sSearchMode', searchMode);
    url.searchParams.set('sSearchDistance', searchDistance);

    const requestBody = {
      question,
      filter,
      profileId,
      metaData: true,
      telemetry: true
    };

    const headers = {
      Accept: 'text/event-stream',
      'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8,de;q=0.7',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      Origin: baseUrl,
      Pragma: 'no-cache',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'User-Agent': 'Mozilla/5.0 (compatible; iHub-Apps/1.0)',
      'content-type': 'application/json',
      'sec-ch-ua': '"iHub-Apps";v="1.0"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Server"'
    };

    // Add JWT authentication based on user context
    const { user } = options;
    if (user && user.id !== 'anonymous') {
      try {
        // Generate JWT token for the authenticated user
        const authHeader = getIFinderAuthorizationHeader(user, {
          scope: appConfig.scope || modelConfig.scope || 'fa_index_read'
        });
        headers['Authorization'] = authHeader;
      } catch (error) {
        console.error('Failed to generate iAssistant JWT token:', error.message);
        throw new Error(`iAssistant authentication failed: ${error.message}`);
      }
    } else {
      throw new Error(
        'iAssistant requires authenticated user access - anonymous access not supported'
      );
    }

    return {
      url: url.toString(),
      method: 'POST',
      headers,
      body: requestBody // Return raw object - StreamingHandler will JSON.stringify it
    };
  }

  /**
   * Process iAssistant SSE streaming response
   * iAssistant uses custom SSE format that needs special handling
   */
  processResponseBuffer(buffer) {
    const result = {
      content: [],
      complete: false,
      finishReason: null,
      tool_calls: [],
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
          this.processEvent(currentEvent, currentData, result);
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
          this.processEvent(currentEvent, currentData, result);
          currentEvent = null;
          currentData = '';
        }
      }
    }

    // Process final event if buffer doesn't end with empty line
    if (currentEvent && currentData) {
      this.processEvent(currentEvent, currentData, result);
    }

    return result;
  }

  /**
   * Process individual SSE event
   */
  processEvent(eventType, data, result) {
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
   * Get model information for iAssistant
   */
  getModelInfo() {
    return {
      provider: 'iassistant',
      supportsStreaming: true,
      supportsImages: false,
      supportsTools: false,
      maxTokens: null, // iAssistant doesn't have token limits in the traditional sense
      contextWindow: null
    };
  }
}

// Export singleton instance
const IAssistantAdapter = new IAssistantAdapterClass();
export default IAssistantAdapter;
