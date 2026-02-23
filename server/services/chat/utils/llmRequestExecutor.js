/**
 * LLM Request Executor
 *
 * Shared utility for executing HTTP requests to LLM providers.
 * Handles the common pattern of:
 * 1. Debug logging the request (URL, headers, body)
 * 2. Executing the request via throttledFetch
 * 3. Handling HTTP errors with enhanced error detection
 *
 * Consolidates previously duplicated logic from:
 * - StreamingHandler.executeStreamingResponse
 * - ToolExecutor.processChatWithTools
 * - ToolExecutor.continueWithToolExecution
 * - NonStreamingHandler.executeNonStreamingResponse
 * - WorkflowLLMHelper.executeStreamingRequest
 *
 * @module services/chat/utils/llmRequestExecutor
 */

import { throttledFetch } from '../../../requestThrottler.js';
import ErrorHandler from '../../../utils/ErrorHandler.js';
import { redactUrl } from '../../../utils/logRedactor.js';
import logger from '../../../utils/logger.js';

const errorHandler = new ErrorHandler();

/**
 * Log debug information about an LLM request.
 *
 * @param {Object} request - The request object with url, headers, body, method
 * @param {Object} options - Additional context
 * @param {string} [options.label] - Label for the log entry (e.g., "with tools", "tool continuation")
 * @param {string} [options.chatId] - Chat/session identifier
 * @param {string} [options.modelId] - Model identifier
 * @param {string} [options.messageId] - Message identifier
 */
export function logLLMRequest(request, { label = '', chatId, modelId, messageId } = {}) {
  const idPart = chatId ? `Chat ID: ${chatId}` : messageId ? `Message ID: ${messageId}` : '';
  const modelPart = modelId ? `, Model: ${modelId}` : '';
  const labelPart = label ? ` (${label})` : '';

  logger.debug(`[LLM REQUEST DEBUG] ${idPart}${modelPart}${labelPart}`);
  logger.debug(`[LLM REQUEST DEBUG] Method: ${request.method || 'POST'}`);
  logger.debug(`[LLM REQUEST DEBUG] URL: ${redactUrl(request.url)}`);
  logger.debug(
    `[LLM REQUEST DEBUG] Headers:`,
    JSON.stringify(
      {
        ...request.headers,
        Authorization: request.headers.Authorization ? '[REDACTED]' : undefined
      },
      null,
      2
    )
  );
  if (request.body) {
    logger.debug(`[LLM REQUEST DEBUG] Body:`, JSON.stringify(request.body, null, 2));
  }
}

/**
 * Execute an HTTP request to an LLM provider.
 *
 * @param {Object} params - Request parameters
 * @param {Object} params.request - The request object with url, headers, body, method
 * @param {Object} params.model - Model configuration (id, provider)
 * @param {AbortSignal} [params.signal] - Abort signal for cancellation
 * @param {string} [params.language] - Language for error messages
 * @returns {Promise<Response>} The HTTP response
 * @throws {Error} If the response is not ok, throws with enhanced error details
 */
export async function executeLLMRequest({ request, model, signal, language }) {
  const fetchOptions = {
    method: request.method || 'POST',
    headers: request.headers
  };

  if (signal) {
    fetchOptions.signal = signal;
  }

  // Only add body for POST requests
  if (fetchOptions.method === 'POST' && request.body) {
    fetchOptions.body = JSON.stringify(request.body);
  }

  const response = await throttledFetch(model.id, request.url, fetchOptions);

  if (!response.ok) {
    const errorInfo = await errorHandler.createEnhancedLLMApiError(response, model, language);

    const error = new Error(errorInfo.message);
    error.code = errorInfo.code;
    error.httpStatus = errorInfo.httpStatus;
    error.details = errorInfo.details;
    error.isContextWindowError = errorInfo.isContextWindowError;
    throw error;
  }

  return response;
}
