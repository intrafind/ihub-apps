import { getErrorDetails, logInteraction } from '../../utils.js';
import { recordChatRequest, recordChatResponse } from '../../usageTracker.js';
import { throttledFetch } from '../../requestThrottler.js';
import ErrorHandler from '../../utils/ErrorHandler.js';
import { redactUrl } from '../../utils/logRedactor.js';
import { getAdapter } from '../../adapters/index.js';
import logger from '../../utils/logger.js';

class NonStreamingHandler {
  constructor() {
    this.errorHandler = new ErrorHandler();
  }

  async executeNonStreamingResponse({
    request,
    res,
    buildLogData,
    messageId,
    model,
    DEFAULT_TIMEOUT,
    getLocalizedError,
    clientLanguage
  }) {
    // Special handling for BFL models - use async polling
    if (model.provider === 'bfl') {
      return this.executeBFLGeneration({
        request,
        res,
        buildLogData,
        messageId,
        model,
        DEFAULT_TIMEOUT,
        clientLanguage
      });
    }

    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Request timed out after ${DEFAULT_TIMEOUT / 1000} seconds`));
      }, DEFAULT_TIMEOUT);
    });

    try {
      // Determine HTTP method and body based on adapter requirements
      const fetchOptions = {
        method: request.method || 'POST',
        headers: request.headers
      };

      // Only add body for POST requests
      if (fetchOptions.method === 'POST' && request.body) {
        fetchOptions.body = JSON.stringify(request.body);
      }

      // Debug logging for LLM request
      logger.debug(`[LLM REQUEST DEBUG] Message ID: ${messageId}, Model: ${model.id}`);
      logger.debug(`[LLM REQUEST DEBUG] Method: ${fetchOptions.method}`);
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

      const responsePromise = throttledFetch(model.id, request.url, fetchOptions);

      const llmResponse = await Promise.race([responsePromise, timeoutPromise]);
      clearTimeout(timeoutId);

      if (!llmResponse.ok) {
        // Use enhanced error handler for better error detection
        const errorResult = await this.errorHandler.createEnhancedLLMApiError(
          llmResponse,
          model,
          clientLanguage
        );

        const errorLog = buildLogData(false, {
          responseType: 'error',
          error: {
            message: errorResult.message,
            code: errorResult.code,
            httpStatus: errorResult.httpStatus,
            details: errorResult.details,
            isContextWindowError: errorResult.isContextWindowError
          }
        });

        await logInteraction('chat_error', errorLog);

        // Log additional info for context window errors
        if (errorResult.isContextWindowError) {
          logger.warn(`Context window exceeded for model ${model.id}:`, {
            modelId: model.id,
            tokenLimit: model.tokenLimit,
            httpStatus: errorResult.httpStatus,
            errorCode: errorResult.code
          });
        }

        return res.status(llmResponse.status).json({
          error: errorResult.message,
          code: errorResult.code,
          details: errorResult.details,
          isContextWindowError: errorResult.isContextWindowError
        });
      }

      const responseData = await llmResponse.json();
      responseData.messageId = messageId;

      const promptTokens = responseData.usage?.prompt_tokens || 0;
      const completionTokens = responseData.usage?.completion_tokens || 0;
      const baseLog = buildLogData(false);

      await recordChatRequest({
        userId: baseLog.userSessionId,
        appId: baseLog.appId,
        modelId: model.id,
        tokens: promptTokens
      });

      let aiResponse = '';
      if (responseData.choices && responseData.choices.length > 0) {
        aiResponse = responseData.choices[0].message?.content || '';
      }

      const responseLog = buildLogData(false, {
        responseType: 'success',
        response: aiResponse.substring(0, 1000)
      });

      await logInteraction('chat_response', responseLog);
      await recordChatResponse({
        userId: baseLog.userSessionId,
        appId: baseLog.appId,
        modelId: model.id,
        tokens: completionTokens
      });

      return res.json(responseData);
    } catch (fetchError) {
      clearTimeout(timeoutId);
      const errorDetails = getErrorDetails(fetchError, model);

      await logInteraction(
        'chat_error',
        buildLogData(false, {
          responseType: 'error',
          error: { message: errorDetails.message, code: errorDetails.code }
        })
      );

      return res.status(500).json({
        error: errorDetails.message,
        code: errorDetails.code,
        modelId: model.id,
        provider: model.provider,
        recommendation: errorDetails.recommendation,
        details: fetchError.message
      });
    }
  }

  /**
   * Execute BFL image generation with async polling
   * @param {Object} params - Execution parameters
   */
  async executeBFLGeneration({
    request,
    res,
    buildLogData,
    messageId,
    model,
    DEFAULT_TIMEOUT,
    clientLanguage
  }) {
    try {
      const adapter = getAdapter('bfl');
      const baseLog = buildLogData(false);

      // Log the request
      await recordChatRequest({
        userId: baseLog.userSessionId,
        appId: baseLog.appId,
        modelId: model.id,
        tokens: 0 // BFL doesn't use tokens
      });

      // Execute the full generation flow (submit + poll + download)
      logger.info(`[BFL] Starting image generation for model: ${model.id}`);
      const result = await adapter.executeGeneration(request);

      if (result.error) {
        const errorLog = buildLogData(false, {
          responseType: 'error',
          error: {
            message: result.errorMessage,
            code: 'generation_error'
          }
        });

        await logInteraction('chat_error', errorLog);

        return res.status(500).json({
          error: result.errorMessage,
          code: 'generation_error',
          modelId: model.id,
          provider: model.provider
        });
      }

      // Format response to match expected structure
      const responseData = {
        messageId,
        choices: [
          {
            message: {
              role: 'assistant',
              content: result.content.join('\n'),
              images: result.images
            },
            finish_reason: result.finishReason
          }
        ],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };

      const responseLog = buildLogData(false, {
        responseType: 'success',
        response: `Image generated: ${result.images.length} image(s)`
      });

      await logInteraction('chat_response', responseLog);
      await recordChatResponse({
        userId: baseLog.userSessionId,
        appId: baseLog.appId,
        modelId: model.id,
        tokens: 0 // BFL doesn't use tokens
      });

      return res.json(responseData);
    } catch (error) {
      logger.error('[BFL] Generation error:', error);

      await logInteraction(
        'chat_error',
        buildLogData(false, {
          responseType: 'error',
          error: { message: error.message, code: 'bfl_error' }
        })
      );

      return res.status(500).json({
        error: error.message,
        code: 'bfl_error',
        modelId: model.id,
        provider: model.provider,
        details: error.message
      });
    }
  }
}

export default NonStreamingHandler;
