/**
 * StreamResponseCollector
 *
 * Shared utility for processing SSE streaming responses from LLM providers.
 * Handles the common pattern of:
 * 1. Reading a streaming HTTP response
 * 2. Parsing SSE events via eventsource-parser
 * 3. Converting provider-specific responses to generic format
 * 4. Accumulating content, tool calls, thinking, images, and grounding metadata
 *
 * Supports two modes:
 * - collect(): Reads entire stream and returns accumulated result
 * - process(): Processes stream with callbacks for real-time emission
 *
 * Consolidates previously duplicated logic from:
 * - StreamingHandler.executeStreamingResponse (standard eventsource-parser path)
 * - ToolExecutor.processChatWithTools
 * - ToolExecutor.continueWithToolExecution
 * - WorkflowLLMHelper.processStreamingResponse
 *
 * @module services/chat/utils/StreamResponseCollector
 */

import { convertResponseToGeneric } from '../../../adapters/toolCalling/index.js';
import { getReadableStream } from '../../../utils/streamUtils.js';
import { mergeToolCalls } from './toolCallAccumulator.js';
import { createParser } from 'eventsource-parser';

/**
 * Process an SSE streaming response and collect/emit results.
 */
class StreamResponseCollector {
  /**
   * @param {string} provider - LLM provider identifier (e.g. 'openai', 'anthropic', 'google')
   */
  constructor(provider) {
    this.provider = provider;
  }

  /**
   * Collect the entire streaming response into a single result object.
   * Used by ToolExecutor and WorkflowLLMHelper where content needs to be
   * accumulated before further processing (e.g., tool execution).
   *
   * @param {Response} httpResponse - Fetch response with streaming body
   * @param {Object} [options] - Processing options
   * @param {AbortSignal} [options.signal] - Signal to check for abort (activeRequests check)
   * @param {Function} [options.isAborted] - Function returning true if request was aborted
   * @param {Function} [options.onContent] - Optional callback for real-time content chunks
   * @param {Function} [options.onImages] - Optional callback for images
   * @param {Function} [options.onThinking] - Optional callback for thinking content
   * @param {Function} [options.onGrounding] - Optional callback for grounding metadata
   * @returns {Promise<Object>} { content, toolCalls, thoughtSignatures, finishReason, usage, error }
   */
  async collect(httpResponse, options = {}) {
    let content = '';
    const toolCalls = [];
    const thoughtSignatures = [];
    let finishReason = null;
    let usage = null;
    let error = null;
    let errorMessage = null;

    await this._processStream(httpResponse, {
      ...options,
      onContentChunk: text => {
        content += text;
        if (options.onContent) options.onContent(text);
      },
      onToolCalls: calls => {
        mergeToolCalls(toolCalls, calls);
      },
      onThoughtSignatures: sigs => {
        thoughtSignatures.push(...sigs);
      },
      onFinishReason: reason => {
        finishReason = reason;
      },
      onUsage: u => {
        usage = u;
      },
      onImages: options.onImages || null,
      onThinking: options.onThinking || null,
      onGrounding: options.onGrounding || null,
      onError: (err, msg) => {
        error = err;
        errorMessage = msg;
      }
    });

    if (error) {
      const e = new Error(errorMessage || 'Error processing LLM response');
      e.code = 'PROCESSING_ERROR';
      throw e;
    }

    return { content, toolCalls, thoughtSignatures, finishReason, usage };
  }

  /**
   * Process a streaming response with callbacks for each event type.
   * Used by StreamingHandler where chunks need to be emitted in real-time.
   *
   * @param {Response} httpResponse - Fetch response with streaming body
   * @param {Object} callbacks - Event callbacks
   * @param {Function} callbacks.onContent - Called with each content text chunk
   * @param {Function} [callbacks.onImages] - Called with images array from a result
   * @param {Function} [callbacks.onThinking] - Called with thinking array from a result
   * @param {Function} [callbacks.onGrounding] - Called with grounding metadata from a result
   * @param {Function} [callbacks.onFinishReason] - Called when finish reason is received
   * @param {Function} [callbacks.onComplete] - Called when stream is complete, with finishReason
   * @param {Function} [callbacks.onError] - Called on processing error, with (error, message)
   * @param {Function} [callbacks.isAborted] - Function returning true if request was aborted
   * @returns {Promise<{content: string, finishReason: string}>} Summary of processed stream
   */
  async process(httpResponse, callbacks = {}) {
    let fullContent = '';
    let finishReason = null;

    await this._processStream(httpResponse, {
      ...callbacks,
      onContentChunk: text => {
        fullContent += text;
        if (callbacks.onContent) callbacks.onContent(text);
      },
      onToolCalls: callbacks.onToolCalls || null,
      onThoughtSignatures: callbacks.onThoughtSignatures || null,
      onFinishReason: reason => {
        finishReason = reason;
        if (callbacks.onFinishReason) callbacks.onFinishReason(reason);
      },
      onUsage: callbacks.onUsage || null,
      onComplete: () => {
        if (callbacks.onComplete) callbacks.onComplete(finishReason);
      }
    });

    return { content: fullContent, finishReason };
  }

  /**
   * Core streaming processing loop shared by collect() and process().
   * Reads SSE events, parses them, converts to generic format, and dispatches to callbacks.
   *
   * @private
   */
  async _processStream(httpResponse, handlers) {
    const readableStream = getReadableStream(httpResponse);
    const reader = readableStream.getReader();
    const decoder = new TextDecoder();
    const events = [];
    const parser = createParser({
      onEvent: event => {
        if (event.type === 'event' || !event.type) {
          events.push(event);
        }
      }
    });

    try {
      let done = false;

      while (!done) {
        const { value, done: readerDone } = await reader.read();

        // Check if the request was aborted
        if (handlers.isAborted && handlers.isAborted()) {
          reader.cancel();
          break;
        }

        if (readerDone) break;

        const chunk = decoder.decode(value, { stream: true });
        parser.feed(chunk);

        while (events.length > 0) {
          const evt = events.shift();
          const result = convertResponseToGeneric(evt.data, this.provider);

          // Handle error responses
          if (result.error) {
            if (handlers.onError) {
              handlers.onError(true, result.errorMessage || 'Error processing response');
            }
            done = true;
            break;
          }

          // Emit content chunks
          if (result.content?.length > 0) {
            for (const text of result.content) {
              if (handlers.onContentChunk) handlers.onContentChunk(text);
            }
          }

          // Emit tool calls
          if (result.tool_calls?.length > 0) {
            if (handlers.onToolCalls) handlers.onToolCalls(result.tool_calls);
          }

          // Emit images
          if (result.images?.length > 0) {
            if (handlers.onImages) handlers.onImages(result);
          }

          // Emit thinking content
          if (result.thinking?.length > 0) {
            if (handlers.onThinking) handlers.onThinking(result);
          }

          // Emit grounding metadata
          if (result.groundingMetadata) {
            if (handlers.onGrounding) handlers.onGrounding(result);
          }

          // Collect thoughtSignatures (for Gemini 3 thinking models)
          if (result.thoughtSignatures?.length > 0) {
            if (handlers.onThoughtSignatures)
              handlers.onThoughtSignatures(result.thoughtSignatures);
          }

          // Capture usage data (usually in final chunk)
          if (result.usage) {
            if (handlers.onUsage) handlers.onUsage(result.usage);
          }

          // Track finish reason
          if (result.finishReason) {
            if (handlers.onFinishReason) handlers.onFinishReason(result.finishReason);
          }

          // Stream complete
          if (result.complete) {
            if (handlers.onComplete) handlers.onComplete();
            done = true;
            break;
          }
        }
      }
    } finally {
      // Ensure reader is released
      try {
        reader.releaseLock();
      } catch {
        // Ignore release errors (reader may already be released)
      }
    }
  }
}

export default StreamResponseCollector;
