import { getErrorDetails, logInteraction } from '../../utils.js';
import { recordChatRequest, recordChatResponse } from '../../usageTracker.js';
import { throttledFetch } from '../../requestThrottler.js';
import ErrorHandler from '../../utils/ErrorHandler.js';

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
          console.warn(`Context window exceeded for model ${model.id}:`, {
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
}

export default NonStreamingHandler;
