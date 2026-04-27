import { getErrorDetails, logInteraction } from '../../utils.js';
import { recordChatRequest, recordChatResponse } from '../../usageTracker.js';
import { throttledFetch } from '../../requestThrottler.js';
import ErrorHandler from '../../utils/ErrorHandler.js';
import logger from '../../utils/logger.js';
import { instrumentLLMCall } from '../../telemetry/llmInstrumentation.js';

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
    llmMessages,
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

    const baseLog = buildLogData(false);
    const customContext = {
      appId: baseLog.appId,
      userId: baseLog.user?.id || baseLog.userSessionId,
      chatId: baseLog.sessionId,
      messageCount: Array.isArray(llmMessages) ? llmMessages.length : undefined,
      isFollowUp: Array.isArray(llmMessages) ? llmMessages.length > 2 : undefined
    };
    const requestOptions = {
      temperature: request.body?.temperature,
      maxTokens: request.body?.max_tokens || request.body?.maxOutputTokens,
      topP: request.body?.top_p,
      stream: false
    };

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

      const wrappedResult = await instrumentLLMCall(
        { model, messages: llmMessages, options: requestOptions, customContext },
        async () => {
          const responsePromise = throttledFetch(model.id, request.url, fetchOptions);
          const response = await Promise.race([responsePromise, timeoutPromise]);
          clearTimeout(timeoutId);

          if (!response.ok) {
            return {
              ok: false,
              response,
              status: response.status,
              statusText: response.statusText
            };
          }

          const data = await response.json();
          // Build a normalized result that the instrumentation layer can read
          // so token usage / finish reasons make it onto the span.
          const promptTokens = data.usage?.prompt_tokens || data.usage?.input_tokens || 0;
          const completionTokens =
            data.usage?.completion_tokens || data.usage?.output_tokens || 0;
          return {
            ok: true,
            response,
            status: response.status,
            data,
            id: data.id,
            model: data.model,
            usage: {
              inputTokens: promptTokens,
              outputTokens: completionTokens
            },
            finishReasons: data.choices?.map(c => c.finish_reason).filter(Boolean)
          };
        }
      );

      if (!wrappedResult.ok) {
        // Use enhanced error handler for better error detection
        const errorResult = await this.errorHandler.createEnhancedLLMApiError(
          wrappedResult.response,
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
          logger.warn('Context window exceeded', {
            component: 'NonStreamingHandler',
            modelId: model.id,
            tokenLimit: model.tokenLimit,
            httpStatus: errorResult.httpStatus,
            errorCode: errorResult.code
          });
        }

        return res.status(wrappedResult.status).json({
          error: errorResult.message,
          code: errorResult.code,
          details: errorResult.details,
          isContextWindowError: errorResult.isContextWindowError
        });
      }

      const responseData = wrappedResult.data;
      responseData.messageId = messageId;

      const promptTokens = wrappedResult.usage.inputTokens;
      const completionTokens = wrappedResult.usage.outputTokens;
      const tokenSource = promptTokens > 0 || completionTokens > 0 ? 'provider' : 'estimate';

      await recordChatRequest({
        userId: baseLog.userSessionId,
        appId: baseLog.appId,
        modelId: model.id,
        tokens: promptTokens,
        tokenSource,
        user: baseLog.user
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
        tokens: completionTokens,
        tokenSource,
        user: baseLog.user
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
