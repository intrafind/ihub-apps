import { convertResponseToGeneric } from '../../adapters/toolCalling/index.js';
import { logInteraction } from '../../utils.js';
import { estimateTokens, recordChatRequest, recordChatResponse } from '../../usageTracker.js';
import { activeRequests } from '../../sse.js';
import { actionTracker } from '../../actionTracker.js';
import { createParser } from 'eventsource-parser';
import { throttledFetch } from '../../requestThrottler.js';
import ErrorHandler from '../../utils/ErrorHandler.js';
import { getAdapter } from '../../adapters/index.js';
import { Readable } from 'stream';

class StreamingHandler {
  constructor() {
    this.errorHandler = new ErrorHandler();
  }

  /**
   * Convert response body to Web Streams ReadableStream
   * Handles compatibility between native fetch (Web Streams) and node-fetch (Node.js streams)
   * @param {Response} response - The fetch response object
   * @returns {ReadableStream} Web Streams ReadableStream
   */
  getReadableStream(response) {
    // Check if body already has getReader (native fetch with Web Streams API)
    if (response.body && typeof response.body.getReader === 'function') {
      return response.body;
    }

    // node-fetch returns a Node.js stream - convert to Web Streams
    if (response.body && typeof response.body.pipe === 'function') {
      // Use Node.js Readable.toWeb() to convert Node.js stream to Web Streams ReadableStream
      return Readable.toWeb(response.body);
    }

    throw new Error(
      'Response body is not a readable stream. Expected Web Streams API or Node.js stream.'
    );
  }

  async executeStreamingResponse({
    request,
    chatId,
    buildLogData,
    model,
    llmMessages,
    DEFAULT_TIMEOUT,
    getLocalizedError,
    clientLanguage
  }) {
    actionTracker.trackAction(chatId, {
      event: 'processing',
      message: 'Processing your request...'
    });
    const controller = new AbortController();

    if (activeRequests.has(chatId)) {
      const existingController = activeRequests.get(chatId);
      existingController.abort();
    }
    activeRequests.set(chatId, controller);

    const baseLog = buildLogData(true);
    const promptTokens = llmMessages
      .map(m => estimateTokens(m.content || ''))
      .reduce((a, b) => a + b, 0);
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
          const errorMessage = await getLocalizedError(
            'requestTimeout',
            { timeout: DEFAULT_TIMEOUT / 1000 },
            clientLanguage
          );
          actionTracker.trackError(chatId, { message: errorMessage });
          activeRequests.delete(chatId);
        }
      }, DEFAULT_TIMEOUT);
    };
    setupTimeout();

    console.log(`Sending request for chat ID ${chatId} ${model.id}:`, request.body);

    // DEBUG: Log request details
    console.debug('🔍 [STREAMING DEBUG] Starting stream for chat ID:', chatId);
    console.debug('🔍 [STREAMING DEBUG] Model:', model.id);
    console.debug('🔍 [STREAMING DEBUG] Provider:', model.provider);
    console.debug('🔍 [STREAMING DEBUG] Request URL:', request.url);

    let doneEmitted = false;
    let finishReason = null;

    try {
      console.debug('🔍 [STREAMING DEBUG] Making fetch request to LLM...');
      const llmResponse = await throttledFetch(model.id, request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal
      });

      console.debug('🔍 [STREAMING DEBUG] Received response from LLM:', {
        ok: llmResponse.ok,
        status: llmResponse.status,
        statusText: llmResponse.statusText,
        headers: Object.fromEntries(llmResponse.headers.entries())
      });

      clearTimeout(timeoutId);

      if (!llmResponse.ok) {
        console.error(`StreamingHandler: HTTP error from ${model.provider}:`, {
          status: llmResponse.status,
          statusText: llmResponse.statusText,
          url: request.url
        });

        const errorInfo = await this.errorHandler.createEnhancedLLMApiError(
          llmResponse,
          model,
          clientLanguage
        );

        await logInteraction(
          'chat_error',
          buildLogData(true, {
            responseType: 'error',
            error: {
              message: errorInfo.message,
              code: errorInfo.code,
              httpStatus: errorInfo.httpStatus,
              details: errorInfo.details,
              isContextWindowError: errorInfo.isContextWindowError
            }
          })
        );

        // Log additional info for context window errors
        if (errorInfo.isContextWindowError) {
          console.warn(`Context window exceeded for model ${model.id} in streaming:`, {
            modelId: model.id,
            tokenLimit: model.tokenLimit,
            httpStatus: errorInfo.httpStatus,
            errorCode: errorInfo.code
          });
        }

        actionTracker.trackError(chatId, {
          message: errorInfo.message,
          code: errorInfo.code,
          details: errorInfo.details,
          isContextWindowError: errorInfo.isContextWindowError
        });

        if (activeRequests.get(chatId) === controller) {
          activeRequests.delete(chatId);
        }
        return;
      }

      const readableStream = this.getReadableStream(llmResponse);
      const reader = readableStream.getReader();
      const decoder = new TextDecoder();
      let fullResponse = '';

      // Check if the adapter needs custom SSE processing (only iAssistant for now)
      const adapter = getAdapter(model.provider);
      const hasCustomBufferProcessor = model.provider === 'iassistant';

      if (hasCustomBufferProcessor) {
        // For providers like iAssistant with custom SSE format
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();

          if (!activeRequests.has(chatId)) {
            reader.cancel();
            break;
          }
          if (done) {
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;

          // Process complete SSE events only
          if (buffer.includes('\n\n')) {
            // Find the position of the last complete event
            const parts = buffer.split('\n\n');
            const completeEvents = parts.slice(0, -1).join('\n\n');
            const remainingData = parts[parts.length - 1];

            let result = null;
            if (completeEvents) {
              // Add back the delimiter for processing
              try {
                result = adapter.processResponseBuffer(completeEvents + '\n\n');
              } catch (processingError) {
                console.error(
                  `StreamingHandler: Error processing buffer with ${model.provider} adapter:`,
                  processingError.message
                );
                result = {
                  content: [],
                  complete: false,
                  finishReason: 'error',
                  error: true,
                  errorMessage: `Processing error: ${processingError.message}`
                };
              }

              // Keep the remaining incomplete data in buffer
              buffer = remainingData;

              if (result && result.content && result.content.length > 0) {
                for (const textContent of result.content) {
                  actionTracker.trackChunk(chatId, { content: textContent });
                  fullResponse += textContent;
                }
              }

              if (result && result.error) {
                await logInteraction(
                  'chat_error',
                  buildLogData(true, {
                    responseType: 'error',
                    error: {
                      message: result.errorMessage || 'Error processing response',
                      code: 'PROCESSING_ERROR'
                    },
                    response: fullResponse
                  })
                );
                actionTracker.trackError(chatId, {
                  message: result.errorMessage || 'Error processing response'
                });
                finishReason = 'error';
                break;
              }

              if (result && result.finishReason) {
                finishReason = result.finishReason;
              }

              if (result && result.complete) {
                actionTracker.trackDone(chatId, { finishReason });
                doneEmitted = true;
                await logInteraction(
                  'chat_response',
                  buildLogData(true, { responseType: 'success', response: fullResponse })
                );

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
          }

          if (finishReason === 'error' || doneEmitted) {
            break;
          }
        }

        // Process any remaining data in buffer after stream ends
        if (buffer.trim() && !doneEmitted && finishReason !== 'error') {
          const result = adapter.processResponseBuffer(buffer);

          if (result && result.content && result.content.length > 0) {
            for (const textContent of result.content) {
              actionTracker.trackChunk(chatId, { content: textContent });
              fullResponse += textContent;
            }
          }

          if (result && result.complete) {
            actionTracker.trackDone(chatId, { finishReason: result.finishReason || 'stop' });
            doneEmitted = true;
            await logInteraction(
              'chat_response',
              buildLogData(true, { responseType: 'success', response: fullResponse })
            );

            const completionTokens = estimateTokens(fullResponse);
            await recordChatResponse({
              userId: baseLog.userSessionId,
              appId: baseLog.appId,
              modelId: model.id,
              tokens: completionTokens
            });
          }
        }
      } else {
        // Standard eventsource-parser approach for OpenAI-style providers
        const events = [];
        const parser = createParser({
          onEvent: event => {
            if (event.type === 'event' || !event.type) {
              events.push(event);
            }
          }
        });

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
            const result = convertResponseToGeneric(evt.data, model.provider);

            if (result && result.content && result.content.length > 0) {
              for (const textContent of result.content) {
                actionTracker.trackChunk(chatId, { content: textContent });
                fullResponse += textContent;
              }
            }

            if (result && result.thinking && result.thinking.length > 0) {
              for (const thinkingContent of result.thinking) {
                actionTracker.trackThinking(chatId, { content: thinkingContent });
              }
            }

            if (result && result.error) {
              await logInteraction(
                'chat_error',
                buildLogData(true, {
                  responseType: 'error',
                  error: {
                    message: result.errorMessage || 'Error processing response',
                    code: 'PROCESSING_ERROR'
                  },
                  response: fullResponse
                })
              );
              actionTracker.trackError(chatId, {
                message: result.errorMessage || 'Error processing response'
              });
              finishReason = 'error';
              break;
            }

            if (result && result.finishReason) {
              finishReason = result.finishReason;
            }

            if (result && result.complete) {
              actionTracker.trackDone(chatId, { finishReason });
              doneEmitted = true;
              await logInteraction(
                'chat_response',
                buildLogData(true, { responseType: 'success', response: fullResponse })
              );

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
      }
    } catch (error) {
      clearTimeout(timeoutId);

      console.error(
        'StreamingHandler: Caught error in executeStreamingResponse:',
        error.name,
        error.message
      );
      console.error('StreamingHandler: Full error:', error);

      // Handle connection termination by remote server specifically for iAssistant
      if (
        error.message === 'terminated' &&
        error.cause?.code === 'UND_ERR_SOCKET' &&
        model.provider === 'iassistant'
      ) {
        console.error('iAssistant: Connection terminated by remote server. This may indicate:');
        console.error('- Authentication/authorization failure');
        console.error('- Invalid request format');
        console.error('- Server-side error');
        console.error('- Network connectivity issue');

        const errorMessage = await getLocalizedError(
          'responseStreamError',
          {
            error: 'iAssistant server closed connection. Check authentication and request format.'
          },
          clientLanguage
        );
        actionTracker.trackError(chatId, { message: errorMessage });
      } else if (error.name !== 'AbortError') {
        const errorMessage = await getLocalizedError(
          'responseStreamError',
          { error: error.message },
          clientLanguage
        );
        actionTracker.trackError(chatId, { message: errorMessage });
      }
    } finally {
      clearTimeout(timeoutId);
      if (!doneEmitted) {
        const finalFinishReason = finishReason || 'connection_closed';
        console.debug('🔍 [STREAMING DEBUG] Stream ended without done event:', {
          chatId,
          finishReason: finalFinishReason,
          doneEmitted
        });
        actionTracker.trackDone(chatId, { finishReason: finalFinishReason });
      } else {
        console.debug('🔍 [STREAMING DEBUG] Stream completed normally:', {
          chatId,
          finishReason,
          doneEmitted
        });
      }
      if (activeRequests.get(chatId) === controller) {
        activeRequests.delete(chatId);
      }
    }
  }
}

export default StreamingHandler;
