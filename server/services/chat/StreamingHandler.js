import { logInteraction } from '../../utils.js';
import { activeRequests } from '../../sse.js';
import { actionTracker } from '../../actionTracker.js';
import { throttledFetch } from '../../requestThrottler.js';
import ErrorHandler from '../../utils/ErrorHandler.js';
import { getAdapter } from '../../adapters/index.js';
import { isFailureFinishReason } from '../../adapters/toolCalling/index.js';
import { getReadableStream } from '../../utils/streamUtils.js';
import conversationStateManager from '../integrations/ConversationStateManager.js';
import PromptService from '../PromptService.js';
import logger from '../../utils/logger.js';
import {
  mergeUsage,
  beginLLMCallTelemetry,
  recordLLMCallCompletion,
  finalizeLLMCallTelemetry
} from './llmCallTelemetry.js';

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
   * @param {string} source - Source type ('websearch', 'sources', 'iassistant', 'grounding', 'email', 'file')
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
   * Emit the accumulated answer-source ("knowledge") event for this turn and
   * then clear the per-chat bookkeeping.
   *
   * Safe to call on EVERY terminal path: it only emits when at least one
   * source was recorded, and resetting is idempotent. Centralizing this here
   * (instead of inlining the emit at a single completion branch) prevents the
   * recurring "Based on AI knowledge" regression where a newly added
   * completion path forgot to emit the badge — and guarantees sources never
   * leak into the next turn on the same chatId.
   * @param {string} chatId - The conversation/chat ID
   */
  finalizeAnswerSource(chatId) {
    const sources = this.getKnowledgeSources(chatId);
    if (sources.length > 0) {
      actionTracker.trackAnswerSource(chatId, { sources, type: 'mixed' });
    }
    this.resetKnowledgeSources(chatId);
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
    // Detect email context and file uploads in messages and track as knowledge source
    // Email context is added by the Office add-in with markers like:
    // "--- Current email ---" or "--- Pinned emails (N) ---" or "--- Current meeting ---"
    // File uploads are detected by the presence of fileData or imageData properties
    const hasEmailContext = llmMessages.some(msg => {
      const content = msg.content || '';
      return (
        content.includes('--- Current email ---') ||
        content.includes('--- Pinned emails') ||
        content.includes('--- Current meeting ---')
      );
    });

    // Check for uploaded files/attachments in messages
    const hasFileUploads = llmMessages.some(msg => {
      return (
        (msg.fileData && (Array.isArray(msg.fileData) ? msg.fileData.length > 0 : true)) ||
        (msg.imageData && (Array.isArray(msg.imageData) ? msg.imageData.length > 0 : true))
      );
    });

    if (hasEmailContext) {
      this.addKnowledgeSource(chatId, 'email');
    }
    if (hasFileUploads) {
      this.addKnowledgeSource(chatId, 'file');
    }

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

    const telemetryCtx = await beginLLMCallTelemetry({
      request,
      chatId,
      buildLogData,
      model,
      llmMessages
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
          errorEmitted = true;
          actionTracker.trackError(chatId, { message: errorMessage });
          activeRequests.delete(chatId);
        }
      }, DEFAULT_TIMEOUT);
    };
    setupTimeout();

    let doneEmitted = false;
    let finishReason = null;
    // Set whenever an error is surfaced to the client (stream error, non-OK
    // response, exception, timeout/abort). The finally block reads it so it does
    // not stamp a "Based on uploaded file/email" answer-source badge onto an
    // error bubble — sources are still cleared on every path regardless.
    let errorEmitted = false;
    // Declared up here so the finally block can read accumulated streaming usage
    // for telemetry span/metric finalization.
    let accumulatedUsage = null;
    // Set in the catch block so the finally block's single finalizeLLMCallTelemetry
    // call can close the span/record the error metric without a second call site.
    let caughtError = null;

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
            contextWindow: model.contextWindow,
            httpStatus: errorInfo.httpStatus,
            errorCode: errorInfo.code
          });
        }

        errorEmitted = true;
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

      let fullResponse = '';
      // Tracks whether the model produced any user-facing answer output (text
      // or images) across the whole stream. Thinking/grounding are excluded —
      // they are not an answer on their own. Used to detect a degenerate
      // completion (a failure finish reason with nothing to show) so it becomes
      // a visible error instead of a silent empty bubble.
      let emittedAnswerOutput = false;
      const adapter = getAdapter(model.provider);

      // Adapters expose parseResponseStream(response, ctx) which yields normalized
      // result chunks. The default in BaseAdapter handles SSE; iAssistant uses the
      // line-delimited SSE variant; Bedrock parses binary EventStream frames.
      const stream = adapter.parseResponseStream(llmResponse, { model, chatId, request });

      for await (const result of stream) {
        if (!activeRequests.has(chatId)) {
          break;
        }
        if (!result) continue;

        // Usage may arrive either at the top level or under metadata.usage
        // depending on which converter emitted it.
        if (result.usage) {
          accumulatedUsage = mergeUsage(accumulatedUsage, result.usage);
        }
        if (result.metadata?.usage) {
          accumulatedUsage = mergeUsage(accumulatedUsage, result.metadata.usage);
        }

        if (result.content && result.content.length > 0) {
          for (const textContent of result.content) {
            actionTracker.trackChunk(chatId, { content: textContent });
            fullResponse += textContent;
            if (textContent) emittedAnswerOutput = true;
          }
        }

        if (result.images && result.images.length > 0) {
          emittedAnswerOutput = true;
        }
        this.processImages(result, chatId);
        this.processThinking(result, chatId);
        this.processGroundingMetadata(result, chatId);
        this.processConversationEvents(result, chatId, request);

        if (result.error) {
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
          errorEmitted = true;
          actionTracker.trackError(chatId, {
            message: result.errorMessage || 'Error processing response'
          });
          finishReason = 'error';
          break;
        }

        if (result.finishReason) {
          finishReason = result.finishReason;
        }

        if (result.complete) {
          // Degenerate completion: the provider signalled a failure finish
          // reason (e.g. Gemini's MALFORMED_FUNCTION_CALL) and streamed no
          // answer. Left alone this reaches the client as a clean 'done' with
          // empty content — a silent blank bubble. Surface a clear error
          // instead so the user knows to retry. Mirrors the in-stream
          // result.error path (error event + finally emits the terminal done).
          if (!emittedAnswerOutput && isFailureFinishReason(finishReason)) {
            const errorMessage = await getLocalizedError(
              'malformedModelResponse',
              {},
              clientLanguage
            );
            logger.warn('Model completed with failure finish reason and no output', {
              component: 'StreamingHandler',
              provider: model.provider,
              modelId: model.id,
              finishReason
            });
            await logInteraction(
              'chat_error',
              buildLogData(true, {
                responseType: 'error',
                error: {
                  message: errorMessage,
                  code: 'MALFORMED_RESPONSE',
                  details: { finishReason }
                },
                response: fullResponse
              })
            );
            errorEmitted = true;
            actionTracker.trackError(chatId, {
              message: errorMessage,
              code: 'MALFORMED_RESPONSE'
            });
            finishReason = 'error';
            break;
          }

          // Emit the answer-source badge before 'done' so the client attaches
          // it to the message. finalizeAnswerSource() also clears the sources.
          this.finalizeAnswerSource(chatId);

          actionTracker.trackDone(chatId, { finishReason: finishReason || 'stop' });
          doneEmitted = true;

          await logInteraction(
            'chat_response',
            buildLogData(true, { responseType: 'success', response: fullResponse })
          );

          await recordLLMCallCompletion(telemetryCtx, {
            model,
            accumulatedUsage,
            fullResponseText: fullResponse
          });
          break;
        }
      }
    } catch (error) {
      clearTimeout(timeoutId);
      // Any thrown path (stream exception, timeout/client abort, provider
      // failure) surfaces as an error/aborted turn — don't stamp an answer
      // source badge in the finally below.
      errorEmitted = true;
      caughtError = error;

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
        // The stream ended without a clean 'complete' chunk (connection closed,
        // timeout, abort, or a provider that never signalled completion). Emit
        // the answer-source badge here too so uploads/email context are still
        // attributed instead of falling back to "Based on AI knowledge" — but
        // NOT when an error was surfaced, since the assistant bubble is then an
        // error message and a "Based on uploaded file" badge there is misleading.
        if (!errorEmitted) {
          this.finalizeAnswerSource(chatId);
        }
        const finalFinishReason = finishReason || 'connection_closed';
        actionTracker.trackDone(chatId, { finishReason: finalFinishReason });
      }
      // Defensive: guarantee no source bookkeeping leaks into the next turn on
      // this chatId, regardless of which path completed the stream (idempotent).
      this.resetKnowledgeSources(chatId);
      if (activeRequests.get(chatId) === controller) {
        activeRequests.delete(chatId);
      }

      // Stream outcome metric, error metric, and telemetry span closure — all
      // handled by a single call so the two possible closing paths (error vs.
      // clean/aborted completion) can't double-record.
      finalizeLLMCallTelemetry(telemetryCtx, {
        model,
        finishReason,
        doneEmitted,
        accumulatedUsage,
        error: caughtError
      });
    }
  }
}

export default StreamingHandler;
