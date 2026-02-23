/**
 * WorkflowLLMHelper
 *
 * Provides a clean interface for workflow LLM operations with proper option filtering.
 * This helper ensures that only valid adapter parameters are passed to LLM requests,
 * preventing provider-specific errors from invalid options.
 *
 * The root cause being fixed: AgentNodeExecutor was passing `user` and `chatId` options
 * directly to createCompletionRequest, but BaseAdapter.extractRequestOptions() only
 * accepts: temperature, stream, maxTokens, tools, toolChoice, responseFormat, responseSchema.
 * The extra options were corrupting request bodies for vLLM, Google, and other providers.
 *
 * @module services/workflow/WorkflowLLMHelper
 */

import { createCompletionRequest } from '../../adapters/index.js';
import StreamResponseCollector from '../chat/utils/StreamResponseCollector.js';
import { logLLMRequest, executeLLMRequest } from '../chat/utils/llmRequestExecutor.js';
import ApiKeyVerifier from '../../utils/ApiKeyVerifier.js';
import logger from '../../utils/logger.js';

/**
 * Valid adapter options as defined in BaseAdapter.extractRequestOptions()
 * @type {string[]}
 */
const VALID_ADAPTER_OPTIONS = [
  'temperature',
  'stream',
  'maxTokens',
  'tools',
  'toolChoice',
  'responseFormat',
  'responseSchema'
];

/**
 * Helper class for workflow LLM operations.
 *
 * Provides centralized handling of:
 * - Option filtering to prevent invalid parameters
 * - API key verification using existing infrastructure
 * - Streaming request execution with proper error handling
 * - Response processing with node-fetch/Web Streams compatibility
 */
export class WorkflowLLMHelper {
  /**
   * Create a new WorkflowLLMHelper
   * @param {Object} options - Helper options
   * @param {ApiKeyVerifier} [options.apiKeyVerifier] - API key verifier instance
   * @param {ErrorHandler} [options.errorHandler] - Error handler instance
   */
  constructor(options = {}) {
    this.apiKeyVerifier = options.apiKeyVerifier || new ApiKeyVerifier();
  }

  /**
   * Filter options to only include valid adapter parameters.
   *
   * This is critical for provider compatibility. BaseAdapter.extractRequestOptions()
   * only accepts specific keys. Any extra keys (like user, chatId) pass through
   * unfiltered and corrupt the request body for many providers.
   *
   * @param {Object} options - Request options
   * @returns {Object} Filtered options with only valid adapter parameters
   */
  filterAdapterOptions(options = {}) {
    const filtered = {};

    for (const key of VALID_ADAPTER_OPTIONS) {
      if (options[key] !== undefined) {
        filtered[key] = options[key];
      }
    }

    return filtered;
  }

  /**
   * Verify API key for a model using centralized ApiKeyVerifier.
   *
   * @param {Object} model - Model configuration
   * @param {string} [language='en'] - Language for error messages
   * @returns {Promise<Object>} Result with { success, apiKey } or { success: false, error }
   */
  async verifyApiKey(model, language = 'en') {
    return await this.apiKeyVerifier.verifyApiKey(model, null, null, language);
  }

  /**
   * Execute a streaming LLM request with proper option filtering and error handling.
   *
   * @param {Object} params - Request parameters
   * @param {Object} params.model - Model configuration
   * @param {Array} params.messages - Messages to send
   * @param {string} params.apiKey - API key
   * @param {Object} params.options - Request options (will be filtered)
   * @param {string} [params.language='en'] - Language for error messages
   * @returns {Promise<Object>} Response with { content, toolCalls }
   * @throws {Error} If request fails or API returns error
   */
  async executeStreamingRequest({ model, messages, apiKey, options = {}, language = 'en' }) {
    // Filter options to only valid adapter parameters (critical for provider compatibility)
    const filteredOptions = this.filterAdapterOptions({
      ...options,
      stream: true // Always stream for workflow agent operations
    });

    // Create the request using centralized adapter infrastructure
    const request = createCompletionRequest(model, messages, apiKey, filteredOptions);

    logger.debug({
      component: 'WorkflowLLMHelper',
      message: 'Executing streaming request',
      modelId: model.id,
      provider: model.provider,
      messageCount: messages.length,
      hasTools: !!filteredOptions.tools
    });

    logLLMRequest(request, { modelId: model.id, label: 'workflow' });

    // Execute the request (throws on HTTP error with enhanced error details)
    const response = await executeLLMRequest({ request, model, language });

    // Process the streaming response
    return await this.processStreamingResponse(response, model);
  }

  /**
   * Process a streaming response and extract content and tool calls.
   * Delegates to shared StreamResponseCollector for consistent parsing.
   *
   * @param {Response} response - Fetch response object
   * @param {Object} model - Model configuration (for provider info)
   * @returns {Promise<Object>} Collected response with { content, toolCalls, thoughtSignatures, usage }
   */
  async processStreamingResponse(response, model) {
    const collector = new StreamResponseCollector(model.provider);
    return await collector.collect(response);
  }
}

export default WorkflowLLMHelper;
