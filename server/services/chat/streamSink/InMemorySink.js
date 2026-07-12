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
// Cap accumulated streamed bytes. App-as-tool gateway responses can be very
// long, and nested agent-in-app recursion would otherwise pin unbounded
// per-run heap. Past this threshold we mark the sink errored so the caller
// returns to the LLM with a clean failure instead of OOMing the process.
const MAX_SINK_BYTES = 10 * 1024 * 1024;

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
    this._byteCount = 0;

    this._listener = null;
    this._donePromise = null;
    this._doneResolver = null;
  }

  /**
   * Returns true if the append should be rejected because the sink is full.
   * On overflow the sink is marked errored and `_markDone` is called so the
   * pending `getResult()` promise resolves immediately.
   */
  _wouldOverflow(bytes) {
    this._byteCount += bytes;
    if (this._byteCount > MAX_SINK_BYTES) {
      if (!this.errorPayload) {
        this.errorPayload = {
          message: 'sink overflow',
          details: { bytes: this._byteCount, limit: MAX_SINK_BYTES }
        };
      }
      this._markDone();
      return true;
    }
    return false;
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
      if (this.done) return;
      const event = step.event;
      if (event === UnifiedEvents.CHUNK || event === 'chunk') {
        if (typeof step.content === 'string') {
          if (this._wouldOverflow(step.content.length)) return;
          this.chunks.push(step.content);
        }
      } else if (event === UnifiedEvents.TOOL_CALL_END || event === 'tool-call-end') {
        const entry = {
          toolName: step.toolName,
          toolInput: step.toolInput,
          toolOutput: step.toolOutput
        };
        const size = JSON.stringify(entry).length;
        if (this._wouldOverflow(size)) return;
        this.toolCalls.push(entry);
      } else if (event === UnifiedEvents.CITATION || event === 'citation') {
        const size = JSON.stringify(step).length;
        if (this._wouldOverflow(size)) return;
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
    try {
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
    } finally {
      // Every exit path above (early return or timeout) must release the
      // actionTracker listener — it's a process-wide singleton, so a leaked
      // listener here accumulates for the life of the server.
      this.stopListening();
    }
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
