/**
 * iAssistant API adapter for iHub Apps
 * Handles one-shot queries with Server-Sent Events (SSE) streaming
 * Uses JWT authentication for user-specific access
 */
import { BaseAdapter } from './BaseAdapter.js';
import { getIFinderAuthorizationHeader } from '../utils/iFinderJwt.js';
import iAssistantService from '../services/integrations/iAssistantService.js';
import logger from '../utils/logger.js';

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

    // Construct URL - use baseUrl from config (model or app) or fall back to service default
    const uuid = `ifs-ihub-chat-request-${Date.now()}`;
    const baseUrl = config.baseUrl || serviceConfig.baseUrl;
    const url = new URL(`${baseUrl}${serviceConfig.endpoint}`);
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
      Accept: 'text/event-stream', // Keep SSE for streaming
      'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8,de;q=0.7', //replace with selected language
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      Origin: baseUrl,
      Pragma: 'no-cache',
      'User-Agent': 'ihub/4.0.0', //replace with real version
      'content-type': 'application/json'
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
        logger.error('iAssistant: JWT generation failed:', error.message);
        throw new Error(`iAssistant authentication failed: ${error.message}`);
      }
    } else {
      const errorMsg = user
        ? `iAssistant requires authenticated user access - received anonymous user (ID: ${userId})`
        : 'iAssistant requires authenticated user access - no user context provided';
      logger.error('iAssistant authentication error:', errorMsg);
      throw new Error(errorMsg);
    }

    const request = {
      url: url.toString(),
      method: 'POST',
      headers,
      body: requestBody // Return raw object - StreamingHandler will JSON.stringify it
    };

    return request;
  }

  /**
   * Process iAssistant SSE streaming response
   * iAssistant uses custom SSE format that needs special handling
   */
  processResponseBuffer(buffer) {
    try {
      const result = iAssistantService.processStreamingBuffer(buffer);

      // Ensure we have a valid result object
      if (!result || typeof result !== 'object') {
        logger.error('iAssistant: Invalid result from processStreamingBuffer:', result);
        return {
          content: [],
          complete: false,
          finishReason: null,
          passages: [],
          telemetry: null,
          tool_calls: []
        };
      }

      // Add tool_calls array for adapter compatibility
      result.tool_calls = [];

      return result;
    } catch (error) {
      logger.error('iAssistant: Error processing response buffer:', error.message);
      logger.error('iAssistant: Buffer content:', buffer.substring(0, 200) + '...');
      return {
        content: [],
        complete: false,
        finishReason: 'error',
        passages: [],
        telemetry: null,
        tool_calls: [],
        error: true,
        errorMessage: `Processing error: ${error.message}`
      };
    }
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
