import { processResponseBuffer } from '../../adapters/index.js';
import { logInteraction } from '../../utils.js';
import { estimateTokens, recordChatRequest, recordChatResponse } from '../../usageTracker.js';
import { activeRequests } from '../../sse.js';
import { actionTracker } from '../../actionTracker.js';
import { createParser } from 'eventsource-parser';
import { throttledFetch } from '../../requestThrottler.js';
import ErrorHandler from '../../utils/ErrorHandler.js';

class StreamingHandler {
  constructor() {
    this.errorHandler = new ErrorHandler();
  }

  async executeStreamingResponse({
    request,
    chatId,
    clientRes,
    buildLogData,
    model,
    llmMessages,
    DEFAULT_TIMEOUT,
    getLocalizedError,
    clientLanguage
  }) {
    actionTracker.trackAction(chatId, { event: 'processing', message: 'Processing your request...' });
    const controller = new AbortController();
    
    if (activeRequests.has(chatId)) {
      const existingController = activeRequests.get(chatId);
      existingController.abort();
    }
    activeRequests.set(chatId, controller);
    
    const baseLog = buildLogData(true);
    const promptTokens = llmMessages.map(m => estimateTokens(m.content || '')).reduce((a,b) => a+b, 0);
    await recordChatRequest({ 
      userId: baseLog.userSessionId, 
      appId: baseLog.appId, 
      modelId: model.id, 
      tokens: promptTokens 
    });
    
    let timeoutId;
    const setupTimeout = () => {
      timeoutId = setTimeout(async () => {
        if (activeRequests.has(chatId)) {
          controller.abort();
          const errorMessage = await getLocalizedError('requestTimeout', { timeout: DEFAULT_TIMEOUT/1000 }, clientLanguage);
          actionTracker.trackError(chatId, { message: errorMessage });
          activeRequests.delete(chatId);
        }
      }, DEFAULT_TIMEOUT);
    };
    setupTimeout();

    console.log(`Sending request for chat ID ${chatId} ${model.id}:`, request.body);

    let doneEmitted = false;
    
    try {
      const llmResponse = await throttledFetch(model.id, request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      
      if (!llmResponse.ok) {
        const errorBody = await llmResponse.text();
        let errorMessage = await getLocalizedError('llmApiError', { status: llmResponse.status }, clientLanguage);
        
        if (llmResponse.status === 401) {
          errorMessage = await getLocalizedError('authenticationFailed', { provider: model.provider }, clientLanguage);
        } else if (llmResponse.status === 429) {
          errorMessage = await getLocalizedError('rateLimitExceeded', { provider: model.provider }, clientLanguage);
        } else if (llmResponse.status >= 500) {
          errorMessage = await getLocalizedError('serviceError', { provider: model.provider }, clientLanguage);
        }
        
        await logInteraction('chat_error', buildLogData(true, {
          responseType: 'error',
          error: { message: errorMessage, code: llmResponse.status.toString(), details: errorBody }
        }));
        
        actionTracker.trackError(chatId, { message: errorMessage, details: errorBody });
        
        if (activeRequests.get(chatId) === controller) {
          activeRequests.delete(chatId);
        }
        return;
      }

      const reader = llmResponse.body.getReader();
      const decoder = new TextDecoder();
      const events = [];
      const parser = createParser({
        onEvent: (event) => {
          if (event.type === 'event' || !event.type) {
            events.push(event);
          }
        }
      });
      
      let fullResponse = '';
      let finishReason = null;

      while (true) {
        const { done, value } = await reader.read();
        if (!activeRequests.has(chatId)) {
          reader.cancel();
          break;
        }
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        parser.feed(chunk);
        
        while (events.length > 0) {
          const evt = events.shift();
          const result = processResponseBuffer(model.provider, evt.data);
          
          if (result && result.content && result.content.length > 0) {
            for (const textContent of result.content) {
              actionTracker.trackChunk(chatId, { content: textContent });
              fullResponse += textContent;
            }
          }
          
          if (result && result.error) {
            await logInteraction('chat_error', buildLogData(true, {
              responseType: 'error',
              error: { message: result.errorMessage || 'Error processing response', code: 'PROCESSING_ERROR' },
              response: fullResponse
            }));
            actionTracker.trackError(chatId, { message: result.errorMessage || 'Error processing response' });
            finishReason = 'error';
            break;
          }
          
          if (result && result.finishReason) {
            finishReason = result.finishReason;
          }
          
          if (result && result.complete) {
            actionTracker.trackDone(chatId, { finishReason });
            doneEmitted = true;
            await logInteraction('chat_response', buildLogData(true, { responseType: 'success', response: fullResponse }));
            const completionTokens = estimateTokens(fullResponse);
            await recordChatResponse({ 
              userId: baseLog.userSessionId, 
              appId: baseLog.appId, 
              modelId: model.id, 
              tokens: completionTokens 
            });
            break;
          }
        }
        
        if (finishReason === 'error' || doneEmitted) {
          break;
        }
      }
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error.name !== 'AbortError') {
        const errorMessage = await getLocalizedError('responseStreamError', { error: error.message }, clientLanguage);
        actionTracker.trackError(chatId, { message: errorMessage });
      }
    } finally {
      clearTimeout(timeoutId);
      if (!doneEmitted) {
        actionTracker.trackDone(chatId, { finishReason: finishReason || 'connection_closed' });
      }
      if (activeRequests.get(chatId) === controller) {
        activeRequests.delete(chatId);
      }
    }
  }
}

export default StreamingHandler;