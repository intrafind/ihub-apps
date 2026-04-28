import { convertResponseToGeneric } from '../../adapters/toolCalling/index.js';
import { logInteraction } from '../../utils.js';
import { estimateTokens, recordChatRequest, recordChatResponse } from '../../usageTracker.js';
import { activeRequests } from '../../sse.js';
import { actionTracker } from '../../actionTracker.js';
import { createParser } from 'eventsource-parser';
import { throttledFetch } from '../../requestThrottler.js';
import ErrorHandler from '../../utils/ErrorHandler.js';
import { getAdapter } from '../../adapters/index.js';
import { getReadableStream } from '../../utils/streamUtils.js';
import conversationStateManager from '../integrations/ConversationStateManager.js';
import PromptService from '../PromptService.js';
import logger from '../../utils/logger.js';
import { getGenAIInstrumentation } from '../../telemetry.js';
import { recordAppUsage, recordConversation, recordError } from '../../telemetry/metrics.js';
import activityTracker from '../../telemetry/ActivityTracker.js';
import { resolveProviderName, resolveOperation } from '../../telemetry/providerMap.js';

/**
 * Merge usage data from streaming chunks, preferring non-zero values from incoming data.
 * Handles Anthropic's split delivery (prompt tokens in message_start, completion in message_delta).
 */
function mergeUsage(existing, incoming) {
  if (!incoming) return existing;
  if (!existing) return { ...incoming };
  return {
    promptTokens: incoming.promptTokens || existing.promptTokens,
    completionTokens: incoming.completionTokens || existing.completionTokens,
    totalTokens: incoming.totalTokens || existing.totalTokens
  };
}

class StreamingHandler {
  constructor() {
    this.errorHandler = new ErrorHandler();
    /**
     * Map to track knowledge sources per conversation
     * @type {Map<string, Set<string>>}
     */
    this.knowledgeSources = new Map();
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
        actionTracker.trackThinking(
          chatId,
          typeof thought === 'object' ? thought : { content: thought }
        );
      }
    }
  }

  /**
   * Helper to process grounding metadata
   */
  processGroundingMetadata(result, chatId) {
    if (result && result.groundingMetadata) {
      this.addKnowledgeSource(chatId, 'grounding');
      actionTracker.trackAction(chatId, {
        event: 'grounding',
        metadata: result.groundingMetadata
      });
    }
  }

  /**
   * Add a knowledge source for tracking
   * @param {string} chatId - The conversation/chat ID
   * @param {string} source - Source type ('websearch', 'sources', 'iassistant', 'grounding')
   */
  addKnowledgeSource(chatId, source) {
    if (!this.knowledgeSources.has(chatId)) {
      this.knowledgeSources.set(chatId, new Set());
    }
    this.knowledgeSources.get(chatId).add(source);
  }

  /**
   * Get knowledge sources for a conversation
   * Combines sources from both tool execution and prompt-based sources
   * @param {string} chatId - The conversation/chat ID
   * @returns {Array<string>} Array of source types
   */
  getKnowledgeSources(chatId) {
    const toolSources = this.knowledgeSources.get(chatId);
    const promptSources = PromptService.getPromptSources(chatId);

    // Combine both sources, using a Set to avoid duplicates
    const combined = new Set([...(toolSources ? Array.from(toolSources) : []), ...promptSources]);

    return Array.from(combined);
  }

  /**
   * Reset knowledge sources for a conversation
   * Resets both tool-based and prompt-based sources
   * @param {string} chatId - The conversation/chat ID
   */
  resetKnowledgeSources(chatId) {
    this.knowledgeSources.delete(chatId);
    PromptService.resetPromptSources(chatId);
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

  /**
   * Process conversation-specific events from iassistant-conversation adapter results
   */
  processConversationEvents(result, chatId, request) {
    if (!result) return;

    // Enrich citations with document access links when searchProfile is available
    if (result.citations && request?._searchProfile) {
      const searchProfile = request._searchProfile;
      const enrichItems = items =>
        items?.map(item => {
          if (item.document_id && !Array.isArray(item.links)) {
            return {
              ...item,
              links: [
                {
                  type: 'ACCESS',
                  documentId: item.document_id,
                  searchProfile
                }
              ]
            };
          }
          return item;
        });

      if (result.citations.references) {
        result.citations.references = enrichItems(result.citations.references);
      }
      if (result.citations.resultItems) {
        result.citations.resultItems = enrichItems(result.citations.resultItems);
      }
    }

    // Emit citations (references + result_items)
    if (result.citations) {
      this.addKnowledgeSource(chatId, 'iassistant');
      actionTracker.trackCitation(chatId, result.citations);
    }

    // Emit search status events
    if (result.searchStatus) {
      actionTracker.trackAction(chatId, {
        event: 'search.status',
        ...result.searchStatus
      });
    }

    // Emit conversation title
    if (result.conversationTitle) {
      actionTracker.trackAction(chatId, {
        event: 'conversation.title',
        title: result.conversationTitle
      });
    }

    // Emit conversationId so client can persist it
    const conversationId = request?._conversationId;
    if (conversationId && result.content?.length > 0) {
      // Only emit once on first content
      if (!request._conversationIdEmitted) {
        actionTracker.trackAction(chatId, {
          event: 'conversation.id',
          conversationId
        });
        request._conversationIdEmitted = true;
      }
    }

    // Update parent ID for next message in conversation and emit to client
    if (result.responseMessageId) {
      conversationStateManager.updateParentId(chatId, result.responseMessageId);
      // Emit the responseMessageId to the client so it can be used for feedback
      actionTracker.trackAction(chatId, {
        event: 'response.message.id',
        messageId: result.responseMessageId
      });
    }
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
      tokens: promptTokens,
      tokenSource: 'estimate',
      user: baseLog.user
    });

    // ---- OpenTelemetry instrumentation (streaming) ----
    activityTracker.recordActivity({
      userId: baseLog.user?.id || baseLog.userSessionId,
      chatId
    });
    if (baseLog.appId) {
      // Standard gen_ai.* keys so the metrics.js allow-list passes them
      // through as labels. Per-user / per-chat / per-message dimensions
      // are intentionally span-only.
      const sharedMetricLabels = {
        'gen_ai.provider.name': resolveProviderName(model.provider),
        'gen_ai.request.model': model.modelId
      };
      recordAppUsage(baseLog.appId, baseLog.user?.id || baseLog.userSessionId, sharedMetricLabels);
      recordConversation(chatId, llmMessages.length > 2, {
        'app.id': baseLog.appId,
        ...sharedMetricLabels
      });
    }

    const instrumentation = getGenAIInstrumentation();
    let llmSpan = null;
    const spanStart = Date.now();
    if (instrumentation && instrumentation.isEnabled()) {
      const operation = resolveOperation(model.provider);
      const providerName = resolveProviderName(model.provider);
      llmSpan = instrumentation.createLLMSpan(operation, model, providerName, {
        appId: baseLog.appId,
        userId: baseLog.user?.id || baseLog.userSessionId,
        chatId,
        messageCount: llmMessages.length,
        isFollowUp: llmMessages.length > 2
      });
      const requestOptions = {
        temperature: request.body?.temperature,
        maxTokens: request.body?.max_tokens || request.body?.maxOutputTokens,
        topP: request.body?.top_p,
        stream: true
      };
      instrumentation.recordRequest(llmSpan, model, llmMessages, requestOptions);
    }

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

    let doneEmitted = false;
    let finishReason = null;
    // Declared up here so the finally block can read accumulated streaming usage
    // for telemetry span/metric finalization.
    let accumulatedUsage = null;

    try {
      const llmResponse = await throttledFetch(model.id, request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!llmResponse.ok) {
        const errorInfo = await this.errorHandler.createEnhancedLLMApiError(
          llmResponse,
          model,
          clientLanguage
        );

        logger.error('HTTP error from LLM provider', {
          component: 'StreamingHandler',
          provider: model.provider,
          httpStatus: llmResponse.status,
          statusText: llmResponse.statusText,
          url: request.url,
          details: errorInfo.details,
          code: errorInfo.code
        });

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
          logger.warn('Context window exceeded in streaming', {
            component: 'StreamingHandler',
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

      // Check if the adapter needs custom SSE processing (iassistant-conversation uses custom format)
      const adapter = getAdapter(model.provider);
      const hasCustomBufferProcessor = model.provider === 'iassistant-conversation';

      if (hasCustomBufferProcessor) {
        // For providers like iAssistant Conversation with custom SSE format
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
                // Await the adapter's async buffer processing before using the parsed result
                result = await adapter.processResponseBuffer(completeEvents + '\n\n');
              } catch (processingError) {
                logger.error('Error processing buffer with adapter', {
                  component: 'StreamingHandler',
                  provider: model.provider,
                  error: processingError
                });
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

              // Accumulate usage data from adapter results
              if (result?.usage) {
                accumulatedUsage = mergeUsage(accumulatedUsage, result.usage);
              }

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

              // Handle conversation-specific events (iassistant-conversation)
              this.processConversationEvents(result, chatId, request);

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
                // Emit answer source information before done event
                const sources = this.getKnowledgeSources(chatId);
                if (sources.length > 0) {
                  actionTracker.trackAnswerSource(chatId, { sources, type: 'mixed' });
                }

                actionTracker.trackDone(chatId, { finishReason });
                doneEmitted = true;

                // Reset knowledge sources after emitting
                this.resetKnowledgeSources(chatId);

                await logInteraction(
                  'chat_response',
                  buildLogData(true, { responseType: 'success', response: fullResponse })
                );

                const completionTokens =
                  accumulatedUsage?.completionTokens ?? estimateTokens(fullResponse);
                const tokenSource = accumulatedUsage ? 'provider' : 'estimate';
                await recordChatResponse({
                  userId: baseLog.userSessionId,
                  appId: baseLog.appId,
                  modelId: model.id,
                  tokens: completionTokens,
                  tokenSource,
                  user: baseLog.user
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
          const result = await adapter.processResponseBuffer(buffer);

          if (result?.usage) {
            accumulatedUsage = mergeUsage(accumulatedUsage, result.usage);
          }

          if (result && result.content && result.content.length > 0) {
            for (const textContent of result.content) {
              actionTracker.trackChunk(chatId, { content: textContent });
              fullResponse += textContent;
            }
          }

          // Handle generated images in remaining buffer
          this.processImages(result, chatId);

          // Handle conversation events in remaining buffer
          this.processConversationEvents(result, chatId, request);

          if (result && result.complete) {
            // Emit answer source information before done event
            const sources = this.getKnowledgeSources(chatId);
            if (sources.length > 0) {
              actionTracker.trackAnswerSource(chatId, { sources, type: 'mixed' });
            }

            actionTracker.trackDone(chatId, { finishReason: result.finishReason || 'stop' });
            doneEmitted = true;

            // Reset knowledge sources after emitting
            this.resetKnowledgeSources(chatId);

            await logInteraction(
              'chat_response',
              buildLogData(true, { responseType: 'success', response: fullResponse })
            );

            const completionTokens =
              accumulatedUsage?.completionTokens ?? estimateTokens(fullResponse);
            const tokenSource = accumulatedUsage ? 'provider' : 'estimate';
            await recordChatResponse({
              userId: baseLog.userSessionId,
              appId: baseLog.appId,
              modelId: model.id,
              tokens: completionTokens,
              tokenSource,
              user: baseLog.user
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
            // Use await to handle async processResponseBuffer
            const result = await convertResponseToGeneric(evt.data, model.provider);

            // Accumulate usage data from converter results (via metadata.usage)
            if (result?.metadata?.usage) {
              accumulatedUsage = mergeUsage(accumulatedUsage, result.metadata.usage);
            }

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
              // Emit answer source information before done event
              const sources = this.getKnowledgeSources(chatId);
              if (sources.length > 0) {
                actionTracker.trackAnswerSource(chatId, { sources, type: 'mixed' });
              }

              actionTracker.trackDone(chatId, { finishReason });
              doneEmitted = true;

              // Reset knowledge sources after emitting
              this.resetKnowledgeSources(chatId);

              await logInteraction(
                'chat_response',
                buildLogData(true, { responseType: 'success', response: fullResponse })
              );

              const completionTokens =
                accumulatedUsage?.completionTokens ?? estimateTokens(fullResponse);
              const tokenSource = accumulatedUsage ? 'provider' : 'estimate';
              await recordChatResponse({
                userId: baseLog.userSessionId,
                appId: baseLog.appId,
                modelId: model.id,
                tokens: completionTokens,
                tokenSource,
                user: baseLog.user
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

      // End telemetry span with error
      if (instrumentation && llmSpan) {
        const duration = (Date.now() - spanStart) / 1000;
        instrumentation.endSpan(llmSpan, error, duration);
        llmSpan = null;
      }
      if (baseLog.appId) {
        recordError(error.name || 'Error', 'llm_call_streaming', {
          'app.id': baseLog.appId,
          'gen_ai.provider.name': resolveProviderName(model.provider),
          'gen_ai.request.model': model.modelId
        });
      }

      logger.error('Caught error in executeStreamingResponse', {
        component: 'StreamingHandler',
        error
      });

      // Handle connection termination by remote server specifically for iAssistant Conversation
      if (
        error.message === 'terminated' &&
        error.cause?.code === 'UND_ERR_SOCKET' &&
        model.provider === 'iassistant-conversation'
      ) {
        logger.error('iAssistant Conversation connection terminated by remote server', {
          component: 'StreamingHandler',
          hint: 'Check authentication, request format, and server-side configuration'
        });

        const errorMessage = await getLocalizedError(
          'responseStreamError',
          {
            error: 'iAssistant server closed connection. Check authentication and request format.'
          },
          clientLanguage
        );
        actionTracker.trackError(chatId, { message: errorMessage });
      } else if (error.name !== 'AbortError') {
        let errorKey = 'responseStreamError';
        let errorParams = { error: error.message };

        // Detect specific network errors for actionable messages
        if (error.message?.includes('fetch failed') || error.cause) {
          const causeCode = error.cause?.code;

          if (causeCode === 'ENOTFOUND') {
            errorKey = 'dnsResolutionFailed';
            errorParams = {
              provider: model.provider,
              model: model.id,
              hostname: error.cause?.hostname || 'unknown'
            };
          } else if (causeCode === 'ECONNREFUSED') {
            errorKey = 'connectionRefused';
            errorParams = { provider: model.provider, model: model.id };
          } else if (causeCode === 'UND_ERR_CONNECT_TIMEOUT' || causeCode === 'ETIMEDOUT') {
            errorKey = 'requestTimeout';
            errorParams = { timeout: DEFAULT_TIMEOUT / 1000 };
          } else if (causeCode) {
            errorKey = 'networkError';
            errorParams = {
              provider: model.provider,
              model: model.id,
              error: error.cause?.message || error.message
            };
          }
        }

        const errorMessage = await getLocalizedError(errorKey, errorParams, clientLanguage);
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
      // Ensure the telemetry span is always closed, even if no error path was taken
      if (instrumentation && llmSpan) {
        const duration = (Date.now() - spanStart) / 1000;
        const usage = accumulatedUsage
          ? {
              inputTokens: accumulatedUsage.promptTokens,
              outputTokens: accumulatedUsage.completionTokens
            }
          : undefined;
        instrumentation.recordResponse(
          llmSpan,
          {
            finishReasons: finishReason ? [finishReason] : undefined,
            model: model.modelId
          },
          usage
        );
        instrumentation.endSpan(llmSpan, null, duration);
      }
    }
  }
}

export default StreamingHandler;
