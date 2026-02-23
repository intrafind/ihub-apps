import { getErrorDetails, logInteraction } from '../../utils.js';
import { recordChatRequest, recordChatResponse } from '../../usageTracker.js';
import { logLLMRequest, executeLLMRequest } from './utils/llmRequestExecutor.js';
import logger from '../../utils/logger.js';

class NonStreamingHandler {
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
      logLLMRequest(request, { messageId, modelId: model.id });

      const responsePromise = executeLLMRequest({ request, model, language: clientLanguage });

      const llmResponse = await Promise.race([responsePromise, timeoutPromise]);
      clearTimeout(timeoutId);

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

      // Handle enhanced LLM API errors (thrown by executeLLMRequest)
      if (fetchError.httpStatus) {
        const errorLog = buildLogData(false, {
          responseType: 'error',
          error: {
            message: fetchError.message,
            code: fetchError.code,
            httpStatus: fetchError.httpStatus,
            details: fetchError.details,
            isContextWindowError: fetchError.isContextWindowError
          }
        });

        await logInteraction('chat_error', errorLog);

        if (fetchError.isContextWindowError) {
          logger.warn(`Context window exceeded for model ${model.id}:`, {
            modelId: model.id,
            tokenLimit: model.tokenLimit,
            httpStatus: fetchError.httpStatus,
            errorCode: fetchError.code
          });
        }

        return res.status(fetchError.httpStatus || 500).json({
          error: fetchError.message,
          code: fetchError.code,
          details: fetchError.details,
          isContextWindowError: fetchError.isContextWindowError
        });
      }

      // Handle other errors (timeouts, network errors)
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
