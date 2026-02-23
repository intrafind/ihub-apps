import { logInteraction } from '../../utils.js';
import { estimateTokens, recordChatRequest, recordChatResponse } from '../../usageTracker.js';
import { activeRequests } from '../../sse.js';
import { actionTracker } from '../../actionTracker.js';
import { getAdapter } from '../../adapters/index.js';
import { getReadableStream } from '../../utils/streamUtils.js';
import StreamResponseCollector from './utils/StreamResponseCollector.js';
import { logLLMRequest, executeLLMRequest } from './utils/llmRequestExecutor.js';
import RequestLifecycle from './utils/requestLifecycle.js';
import { emitImages, emitThinking, emitGroundingMetadata } from './utils/resultEmitters.js';
import logger from '../../utils/logger.js';

class StreamingHandler {
  /** @deprecated Use emitImages from utils/resultEmitters.js instead */
  processImages(result, chatId) {
    emitImages(result, chatId);
  }

  /** @deprecated Use emitThinking from utils/resultEmitters.js instead */
  processThinking(result, chatId) {
    emitThinking(result, chatId);
  }

  /** @deprecated Use emitGroundingMetadata from utils/resultEmitters.js instead */
  processGroundingMetadata(result, chatId) {
    emitGroundingMetadata(result, chatId);
  }

  /**
   * Convert response body to Web Streams ReadableStream
   * Handles compatibility between native fetch (Web Streams) and node-fetch (Node.js streams)
   * @param {Response} response - The fetch response object
   * @returns {ReadableStream} Web Streams ReadableStream
   */
  getReadableStream(response) {
    // Delegate to the shared utility
    return getReadableStream(response);
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

    const lifecycle = new RequestLifecycle(chatId, {
      timeout: DEFAULT_TIMEOUT,
      onTimeout: async () => {
        const errorMessage = await getLocalizedError(
          'requestTimeout',
          { timeout: DEFAULT_TIMEOUT / 1000 },
          clientLanguage
        );
        actionTracker.trackError(chatId, { message: errorMessage });
      }
    });

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

    logLLMRequest(request, { chatId, modelId: model.id });

    let doneEmitted = false;
    let finishReason = null;

    try {
      let llmResponse;
      try {
        llmResponse = await executeLLMRequest({
          request,
          model,
          signal: lifecycle.signal,
          language: clientLanguage
        });
      } catch (httpError) {
        lifecycle.clearTimeout();

        // Handle HTTP errors with streaming-specific error reporting
        await logInteraction(
          'chat_error',
          buildLogData(true, {
            responseType: 'error',
            error: {
              message: httpError.message,
              code: httpError.code,
              httpStatus: httpError.httpStatus,
              details: httpError.details,
              isContextWindowError: httpError.isContextWindowError
            }
          })
        );

        if (httpError.isContextWindowError) {
          logger.warn(`Context window exceeded for model ${model.id} in streaming:`, {
            modelId: model.id,
            tokenLimit: model.tokenLimit,
            httpStatus: httpError.httpStatus,
            errorCode: httpError.code
          });
        }

        actionTracker.trackError(chatId, {
          message: httpError.message,
          code: httpError.code,
          details: httpError.details,
          isContextWindowError: httpError.isContextWindowError
        });

        lifecycle.cleanup();
        return;
      }

      lifecycle.clearTimeout();

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
                logger.error(
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

              // Handle generated images
              this.processImages(result, chatId);

              // Handle thinking content
              this.processThinking(result, chatId);

              // Handle grounding metadata (for Google Search)
              this.processGroundingMetadata(result, chatId);

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

          // Handle generated images in remaining buffer
          this.processImages(result, chatId);

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
        // Uses shared StreamResponseCollector for consistent processing
        const collector = new StreamResponseCollector(model.provider);
        let streamError = false;

        const { content: collectedContent, finishReason: collectedFinishReason } =
          await collector.process(llmResponse, {
            isAborted: () => lifecycle.signal.aborted,
            onContent: text => {
              actionTracker.trackChunk(chatId, { content: text });
              fullResponse += text;
            },
            onImages: result => emitImages(result, chatId),
            onThinking: result => emitThinking(result, chatId),
            onGrounding: result => emitGroundingMetadata(result, chatId),
            onError: (_err, msg) => {
              streamError = true;
              finishReason = 'error';
              logInteraction(
                'chat_error',
                buildLogData(true, {
                  responseType: 'error',
                  error: {
                    message: msg || 'Error processing response',
                    code: 'PROCESSING_ERROR'
                  },
                  response: fullResponse
                })
              );
              actionTracker.trackError(chatId, {
                message: msg || 'Error processing response'
              });
            },
            onFinishReason: reason => {
              finishReason = reason;
            },
            onComplete: () => {
              if (!streamError) {
                actionTracker.trackDone(chatId, { finishReason });
                doneEmitted = true;
                logInteraction(
                  'chat_response',
                  buildLogData(true, { responseType: 'success', response: fullResponse })
                );

                const completionTokens = estimateTokens(fullResponse);
                recordChatResponse({
                  userId: baseLog.userSessionId,
                  appId: baseLog.appId,
                  modelId: model.id,
                  tokens: completionTokens
                });
              }
            }
          });
      }
    } catch (error) {
      lifecycle.clearTimeout();

      logger.error(
        'StreamingHandler: Caught error in executeStreamingResponse:',
        error.name,
        error.message
      );
      logger.error('StreamingHandler: Full error:', error);

      // Handle connection termination by remote server specifically for iAssistant
      if (
        error.message === 'terminated' &&
        error.cause?.code === 'UND_ERR_SOCKET' &&
        model.provider === 'iassistant'
      ) {
        logger.error('iAssistant: Connection terminated by remote server. This may indicate:');
        logger.error('- Authentication/authorization failure');
        logger.error('- Invalid request format');
        logger.error('- Server-side error');
        logger.error('- Network connectivity issue');

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
      if (!doneEmitted) {
        const finalFinishReason = finishReason || 'connection_closed';
        actionTracker.trackDone(chatId, { finishReason: finalFinishReason });
      }
      lifecycle.cleanup();
    }
  }
}

export default StreamingHandler;
