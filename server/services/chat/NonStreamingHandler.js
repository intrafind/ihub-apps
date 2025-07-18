import { getErrorDetails, logInteraction } from '../../utils.js';
import { recordChatRequest, recordChatResponse } from '../../usageTracker.js';
import { recordResponseMeta } from '../../feedbackStorage.js';
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
    llmMessages,
    DEFAULT_TIMEOUT
  }) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Request timed out after ${DEFAULT_TIMEOUT / 1000} seconds`));
      }, DEFAULT_TIMEOUT);
    });

    try {
      const responsePromise = throttledFetch(model.id, request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body)
      });

      const llmResponse = await Promise.race([responsePromise, timeoutPromise]);
      clearTimeout(timeoutId);

      if (!llmResponse.ok) {
        const errorBody = await llmResponse.text();
        const errorLog = buildLogData(false, {
          responseType: 'error',
          error: {
            message: `LLM API request failed with status ${llmResponse.status}`,
            code: llmResponse.status.toString()
          }
        });

        await logInteraction('chat_error', errorLog);

        return res.status(llmResponse.status).json({
          error: `LLM API request failed with status ${llmResponse.status}`,
          details: errorBody
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

      const userPrompt = [...llmMessages].reverse().find(m => m.role === 'user')?.content || '';

      recordResponseMeta({
        messageId,
        appId: baseLog.appId,
        modelId: model.id,
        settings: baseLog.options,
        prompt: userPrompt,
        answer: aiResponse
      });

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
