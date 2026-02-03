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
import { redactUrl } from '../../utils/logRedactor.js';
import logger from '../../utils/logger.js';

class StreamingHandler {
  constructor() {
    this.errorHandler = new ErrorHandler();
  }

  /**
   * Helper to process and emit images from a result
   */
  processImages(result, chatId) {
    if (result && result.images && result.images.length > 0) {
      for (const image of result.images) {
        actionTracker.trackImage(chatId, {
          mimeType: image.mimeType,
          data: image.data,
          thoughtSignature: image.thoughtSignature
        });
      }
    }
  }

  /**
   * Helper to process and emit thinking content from a result
   */
  processThinking(result, chatId) {
    if (result && result.thinking && result.thinking.length > 0) {
      for (const thought of result.thinking) {
        actionTracker.trackThinking(chatId, { content: thought });
      }
    }
  }

  /**
   * Helper to process grounding metadata
   */
  processGroundingMetadata(result, chatId) {
    if (result && result.groundingMetadata) {
      actionTracker.trackAction(chatId, {
        event: 'grounding',
        metadata: result.groundingMetadata
      });
    }
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

    // Debug logging for LLM request
    logger.debug(`[LLM REQUEST DEBUG] Chat ID: ${chatId}, Model: ${model.id}`);
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
    logger.debug(`[LLM REQUEST DEBUG] Body:`, JSON.stringify(request.body, null, 2));

    let doneEmitted = false;
    let finishReason = null;

    try {
      const llmResponse = await throttledFetch(model.id, request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!llmResponse.ok) {
        logger.error(`StreamingHandler: HTTP error from ${model.provider}:`, {
          status: llmResponse.status,
          statusText: llmResponse.statusText,
          url: redactUrl(request.url)
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
          logger.warn(`Context window exceeded for model ${model.id} in streaming:`, {
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

      // Check if the adapter needs custom SSE processing
      // - iAssistant: Uses custom SSE format
      // - gpt-image: Returns single JSON response (not SSE format)
      const adapter = getAdapter(model.provider);
      const hasCustomBufferProcessor =
        model.provider === 'iassistant' || model.provider === 'gpt-image';

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

            // Handle generated images
            this.processImages(result, chatId);

            // Handle thinking
            this.processThinking(result, chatId);

            // Handle grounding metadata
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

          if (finishReason === 'error' || doneEmitted) {
            break;
          }
        }
      }
    } catch (error) {
      clearTimeout(timeoutId);

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
      clearTimeout(timeoutId);
      if (!doneEmitted) {
        const finalFinishReason = finishReason || 'connection_closed';
        actionTracker.trackDone(chatId, { finishReason: finalFinishReason });
      }
      if (activeRequests.get(chatId) === controller) {
        activeRequests.delete(chatId);
      }
    }
  }
}

export default StreamingHandler;
