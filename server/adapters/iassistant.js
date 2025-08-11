/**
 * iAssistant API adapter for iHub Apps
 * Handles one-shot queries with Server-Sent Events (SSE) streaming
 * Uses JWT authentication for user-specific access
 */
import { BaseAdapter } from './BaseAdapter.js';
import { getIFinderAuthorizationHeader } from '../utils/iFinderJwt.js';
import iAssistantService from '../services/integrations/iAssistantService.js';

class IAssistantAdapterClass extends BaseAdapter {
  /**
   * Format messages for iAssistant API
   * iAssistant only supports one-shot queries, so we only use the last user message
   */
  formatMessages(messages) {
    // Find the last user message (iAssistant doesn't support chat history)
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
    const config = { ...modelConfig, ...appConfig };

    // Get configuration from service
    const serviceConfig = iAssistantService.getConfig();
    const actualProfileId = iAssistantService.encodeProfileId(
      config.profileId || serviceConfig.defaultProfileId
    );
    const actualFilter = config.filter || serviceConfig.defaultFilter;
    const actualSearchMode = config.searchMode || serviceConfig.defaultSearchMode;
    const actualSearchDistance = config.searchDistance || serviceConfig.defaultSearchDistance;
    const actualSearchFields = config.searchFields || serviceConfig.defaultSearchFields;

    // Construct URL
    const uuid = `ifs-ihub-chat-request-${Date.now()}`;
    const url = new URL(`${serviceConfig.baseUrl}${serviceConfig.endpoint}`);
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
      Accept: 'text/event-stream',
      'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8,de;q=0.7',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      Origin: serviceConfig.baseUrl,
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
    const userId = user?.id || user?.email;

    if (user && userId && userId !== 'anonymous') {
      try {
        // Generate JWT token for the authenticated user
        const authHeader = getIFinderAuthorizationHeader(user, {
          scope: config.scope || 'fa_index_read'
        });
        headers['Authorization'] = authHeader;
      } catch (error) {
        console.error('Failed to generate iAssistant JWT token:', error.message);
        throw new Error(`iAssistant authentication failed: ${error.message}`);
      }
    } else {
      const errorMsg = user
        ? `iAssistant requires authenticated user access - received anonymous user (ID: ${userId})`
        : 'iAssistant requires authenticated user access - no user context provided';
      console.error('iAssistant authentication error:', errorMsg);
      throw new Error(errorMsg);
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
    const result = iAssistantService.processStreamingBuffer(buffer);

    // Add tool_calls array for adapter compatibility
    result.tool_calls = [];

    return result;
  }

  /**
   * Process individual SSE event
   */
  processEvent(eventType, data, result) {
    return iAssistantService.processStreamingEvent(eventType, data, result);
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
