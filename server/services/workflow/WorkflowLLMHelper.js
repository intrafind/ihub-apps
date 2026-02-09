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
import { convertResponseToGeneric } from '../../adapters/toolCalling/index.js';
import { throttledFetch } from '../../requestThrottler.js';
import { getStreamReader } from '../../utils/streamUtils.js';
import ApiKeyVerifier from '../../utils/ApiKeyVerifier.js';
import ErrorHandler from '../../utils/ErrorHandler.js';
import logger from '../../utils/logger.js';
import { createParser } from 'eventsource-parser';

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
    this.errorHandler = options.errorHandler || new ErrorHandler();
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

    // Execute the request
    const response = await throttledFetch(model.id, request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body)
    });

    // Handle errors using centralized error handling
    if (!response.ok) {
      const errorInfo = await this.errorHandler.createEnhancedLLMApiError(
        response,
        model,
        language
      );

      logger.error({
        component: 'WorkflowLLMHelper',
        message: 'LLM request failed',
        modelId: model.id,
        status: response.status,
        errorCode: errorInfo.code,
        errorMessage: errorInfo.message,
        errorDetails: errorInfo.details
      });

      const error = new Error(errorInfo.message);
      error.code = errorInfo.code;
      error.status = errorInfo.httpStatus;
      error.details = errorInfo.details;
      throw error;
    }

    // Process the streaming response
    return await this.processStreamingResponse(response, model);
  }

  /**
   * Process a streaming response and extract content and tool calls.
   *
   * Uses getStreamReader() for node-fetch/Web Streams compatibility.
   * Uses convertResponseToGeneric() for provider-agnostic response parsing.
   *
   * @param {Response} response - Fetch response object
   * @param {Object} model - Model configuration (for provider info)
   * @returns {Promise<Object>} Collected response with { content, toolCalls }
   */
  async processStreamingResponse(response, model) {
    // Use getStreamReader for node-fetch/Web Streams compatibility
    const reader = getStreamReader(response);
    const decoder = new TextDecoder();
    const events = [];
    const parser = createParser({ onEvent: e => events.push(e) });

    let content = '';
    const toolCalls = [];
    let usage = null;
    let done = false;

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      if (readerDone) break;

      const chunk = decoder.decode(value, { stream: true });
      parser.feed(chunk);

      while (events.length > 0) {
        const evt = events.shift();
        const result = convertResponseToGeneric(evt.data, model.provider);

        if (result.error) {
          throw new Error(result.errorMessage || 'Error processing LLM response');
        }

        // Accumulate content
        if (result.content?.length > 0) {
          content += result.content.join('');
        }

        // Collect tool calls
        if (result.tool_calls?.length > 0) {
          this.mergeToolCalls(toolCalls, result.tool_calls);
        }

        // Capture usage data (usually in final chunk)
        if (result.usage) {
          usage = result.usage;
        }

        if (result.complete) {
          done = true;
          break;
        }
      }
    }

    return { content, toolCalls, usage };
  }

  /**
   * Merge streaming tool call chunks into complete tool calls.
   *
   * Streaming responses send tool calls in chunks (index, id, function name, arguments).
   * This method accumulates them into complete tool call objects.
   *
   * @param {Array} collectedCalls - Array of collected tool calls (mutated)
   * @param {Array} newCalls - New tool call chunks to merge
   */
  mergeToolCalls(collectedCalls, newCalls) {
    for (const call of newCalls) {
      let existing = collectedCalls.find(c => c.index === call.index);

      if (existing) {
        if (call.id) existing.id = call.id;
        if (call.type) existing.type = call.type;
        if (call.function) {
          if (call.function.name) existing.function.name = call.function.name;
          if (call.function.arguments) {
            existing.function.arguments += call.function.arguments;
          }
        }
      } else if (call.index !== undefined) {
        collectedCalls.push({
          index: call.index,
          id: call.id || null,
          type: call.type || 'function',
          function: {
            name: call.function?.name || '',
            arguments: call.function?.arguments || ''
          }
        });
      }
    }
  }
}

export default WorkflowLLMHelper;
