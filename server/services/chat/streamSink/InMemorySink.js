/**
 * InMemorySink
 *
 * Captures the output of a ChatService call without writing to an Express
 * response. Used by `ChatService.invokeAppInternal` when an agent calls an
 * App via the App-as-tool gateway.
 *
 * Two collection modes:
 *
 *  1. **`res` interception** — exposes `.status(code).json(body)` like an
 *     Express response. NonStreamingHandler writes its final response through
 *     here.
 *  2. **actionTracker subscription** — listens for `fire-sse` events scoped
 *     to a specific `chatId` and assembles the streamed assistant message,
 *     tool calls, citations, and usage info from those events.
 *
 * Resolve the `done` promise via `getResult({ timeoutMs })`.
 */

import { actionTracker } from '../../../actionTracker.js';
import { UnifiedEvents } from '../../../../shared/unifiedEventSchema.js';

const DEFAULT_TIMEOUT_MS = 120_000;

export class InMemorySink {
  constructor({ chatId } = {}) {
    this.chatId = chatId || null;
    this.statusCode = 200;
    this.jsonBody = null;
    this.headers = {};
    this.headersSent = false;

    this.chunks = [];
    this.toolCalls = [];
    this.citations = [];
    this.usage = null;
    this.finishReason = null;
    this.errorPayload = null;
    this.done = false;

    this._listener = null;
    this._donePromise = null;
    this._doneResolver = null;
  }

  // ─── Express-res shim ──────────────────────────────────────────────────
  status(code) {
    this.statusCode = code;
    return this;
  }
  json(body) {
    this.jsonBody = body;
    this.headersSent = true;
    return this;
  }
  setHeader(key, value) {
    this.headers[key] = value;
    return this;
  }
  send(body) {
    return this.json(body);
  }
  end() {
    this.headersSent = true;
    return this;
  }
  write() {
    // Streaming writes are silently ignored — agents consume the assembled
    // result via actionTracker events.
    return true;
  }
  // The chat plumbing reads these flags to decide on streaming.
  get writable() {
    return true;
  }

  // ─── actionTracker subscription ────────────────────────────────────────
  startListening() {
    if (!this.chatId) return;
    this._donePromise = new Promise(resolve => {
      this._doneResolver = resolve;
    });
    this._listener = step => {
      if (!step || step.chatId !== this.chatId) return;
      const event = step.event;
      if (event === UnifiedEvents.CHUNK || event === 'chunk') {
        if (typeof step.content === 'string') this.chunks.push(step.content);
      } else if (event === UnifiedEvents.TOOL_CALL_END || event === 'tool-call-end') {
        this.toolCalls.push({
          toolName: step.toolName,
          toolInput: step.toolInput,
          toolOutput: step.toolOutput
        });
      } else if (event === UnifiedEvents.CITATION || event === 'citation') {
        this.citations.push(step);
      } else if (event === UnifiedEvents.DONE || event === 'done') {
        this.finishReason = step.finishReason || step.reason || null;
        if (step.usage) this.usage = step.usage;
        this._markDone();
      } else if (event === 'error') {
        this.errorPayload = { message: step.message || 'error', details: step };
        this._markDone();
      }
    };
    actionTracker.on('fire-sse', this._listener);
  }

  stopListening() {
    if (this._listener) {
      actionTracker.off('fire-sse', this._listener);
      this._listener = null;
    }
  }

  _markDone() {
    if (this.done) return;
    this.done = true;
    if (this._doneResolver) {
      this._doneResolver();
      this._doneResolver = null;
    }
  }

  /**
   * Wait for the chat to finish and return the assembled result.
   */
  async getResult({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    // If we have a non-streaming JSON body (NonStreamingHandler path), return it directly.
    if (this.jsonBody && !this.chatId) {
      return this._assembleNonStreamingResult();
    }

    // If we already have a JSON body and no SSE traffic, prefer the JSON body.
    if (this.jsonBody && this.chunks.length === 0 && !this.done) {
      return this._assembleNonStreamingResult();
    }

    // Otherwise wait for streaming completion.
    if (this._donePromise) {
      await Promise.race([
        this._donePromise,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`InMemorySink timed out after ${timeoutMs}ms`)),
            timeoutMs
          )
        )
      ]);
    }
    this.stopListening();

    if (this.errorPayload) {
      return {
        status: 'error',
        error: this.errorPayload,
        finalMessage: null,
        toolCalls: this.toolCalls
      };
    }

    const finalContent = this.chunks.join('');
    return {
      status: 'ok',
      statusCode: this.statusCode,
      finalMessage: { role: 'assistant', content: finalContent },
      toolCalls: this.toolCalls,
      citations: this.citations,
      usage: this.usage,
      finishReason: this.finishReason
    };
  }

  _assembleNonStreamingResult() {
    if (this.statusCode >= 400) {
      return {
        status: 'error',
        statusCode: this.statusCode,
        error: this.jsonBody,
        finalMessage: null
      };
    }
    // OpenAI-compatible shape: {choices: [{message: {content}}], usage}.
    // Provider-specific shapes (Google candidates[], Anthropic content[], …)
    // must be normalised by the adapter layer BEFORE they reach this sink —
    // adapters own the model-specific knowledge. Do not parse raw provider
    // bodies here.
    const body = this.jsonBody || {};
    let assistantContent = '';
    if (Array.isArray(body.choices) && body.choices.length > 0) {
      assistantContent = body.choices[0]?.message?.content || '';
    } else if (typeof body.content === 'string') {
      assistantContent = body.content;
    }
    return {
      status: 'ok',
      statusCode: this.statusCode,
      finalMessage: { role: 'assistant', content: assistantContent },
      toolCalls: [],
      citations: [],
      usage: body.usage || null,
      finishReason: body.choices?.[0]?.finish_reason || null
      // NOTE: do NOT include the raw response body here. Callers that go
      // through the App-as-tool gateway feed this object back into an LLM
      // tool message, and the raw shape blows up the context.
    };
  }
}

export default InMemorySink;
