/**
 * The OpenAI Responses wire: the `response` object, its output items and the
 * semantic streaming events.
 *
 * One {@link ResponseAssembler} follows a turn. It is fed what the turn does —
 * text deltas, tools starting and finishing, an answer rejected by
 * validation — and either writes the matching events to an SSE response or
 * only collects the items for a non-streamed reply. The final `response`
 * object is built from the same items either way.
 *
 * Events (each `event: <type>` + `data: {type, sequence_number, …}`):
 *
 *   response.created → response.in_progress
 *   response.output_item.added / response.content_part.added      a message starts
 *   response.output_text.delta …                                  its text
 *   response.output_text.done / content_part.done / output_item.done
 *   response.output_item.added / .done                            an iHub tool call
 *   response.completed | response.failed
 *
 * The text in `response.output_text.done` and `response.completed` is the
 * final answer — for structured output the validated JSON — and the
 * completed `response` is authoritative (the OpenAI SDKs take it as the final
 * response). An attempt rejected by validation is closed as an `incomplete`
 * message item and left out of the completed response.
 *
 * iHub runs an app's tools itself, so they are reported as `ihub_tool_call`
 * items — never as `function_call`, which would tell an agent framework to
 * execute the call.
 *
 * @module services/inference/responsesWire
 */
import crypto from 'node:crypto';
import { openAiErrorObject } from './errors.js';

const hex = () => crypto.randomUUID().replaceAll('-', '');

export const newResponseId = () => `resp_${hex()}`;
const newMessageItemId = () => `msg_${hex()}`;
const newToolItemId = () => `tc_${hex()}`;

/**
 * Usage in Responses form.
 *
 * @param {Object|null} usage - iHub usage (`promptTokens`, …).
 * @returns {Object|null}
 */
export function responsesUsage(usage) {
  if (!usage) return null;
  const input = usage.promptTokens || 0;
  const output = usage.completionTokens || 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: usage.cacheReadTokens || 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: usage.reasoningTokens || 0 },
    total_tokens: usage.totalTokens || input + output
  };
}

/**
 * The `text` parameter echoed on a response.
 *
 * @param {Object|null} format - Normalized structured-output format.
 * @returns {{format: Object}}
 */
export function textParam(format) {
  if (!format) return { format: { type: 'text' } };
  if (format.kind === 'json_object') return { format: { type: 'json_object' } };
  return {
    format: {
      type: 'json_schema',
      name: format.name || 'response',
      schema: format.schema,
      strict: true
    }
  };
}

function toJsonString(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Collects a turn's output items and, with an SSE response, streams them.
 */
export class ResponseAssembler {
  /**
   * @param {Object} options
   * @param {import('express').Response|null} options.res - SSE response, or null to collect only.
   * @param {Object} options.base - Fields of the response object that do not change
   *   (`id`, `created_at`, `model`, `instructions`, `temperature`, …).
   */
  constructor({ res = null, base }) {
    this.res = res;
    this.base = base;
    this.sequence = 0;
    /** Every item in output order, `discarded` marking rejected attempts. */
    this.items = [];
    /** The message item receiving text, or null. */
    this.current = null;
    this.toolItems = new Map();
    this.closed = false;
  }

  /** Whether the client is still there to write to. */
  get writable() {
    return Boolean(this.res && !this.res.writableEnded && !this.res.destroyed);
  }

  _write(type, payload) {
    if (!this.writable || this.closed) return;
    const event = { type, sequence_number: this.sequence++, ...payload };
    this.res.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  _index(item) {
    return this.items.indexOf(item);
  }

  /**
   * The response object in a given state.
   *
   * @param {Object} fields - `status`, `output`, `usage`, `error`, …
   * @returns {Object}
   */
  response(fields = {}) {
    return {
      id: this.base.id,
      object: 'response',
      created_at: this.base.created_at,
      status: 'in_progress',
      error: null,
      incomplete_details: null,
      instructions: this.base.instructions ?? null,
      max_output_tokens: this.base.max_output_tokens ?? null,
      model: this.base.model,
      output: [],
      parallel_tool_calls: false,
      previous_response_id: null,
      reasoning: { effort: null, summary: null },
      store: Boolean(this.base.conversation),
      temperature: this.base.temperature ?? null,
      text: this.base.text || textParam(null),
      tool_choice: 'auto',
      tools: [],
      top_p: 1,
      truncation: 'disabled',
      usage: null,
      user: null,
      metadata: this.base.metadata || {},
      conversation: this.base.conversation ? { id: this.base.conversation } : null,
      ...fields
    };
  }

  /** Open the stream: headers, `response.created`, `response.in_progress`. */
  start() {
    if (!this.res) return;
    this.res.status(200);
    this.res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    this.res.setHeader('Cache-Control', 'no-cache');
    this.res.setHeader('X-Accel-Buffering', 'no');
    this.res.flushHeaders?.();
    const snapshot = this.response();
    this._write('response.created', { response: snapshot });
    this._write('response.in_progress', { response: snapshot });
  }

  _openMessage() {
    const item = {
      kind: 'message',
      id: newMessageItemId(),
      text: '',
      status: 'in_progress',
      discarded: false
    };
    this.items.push(item);
    this.current = item;
    this._write('response.output_item.added', {
      output_index: this._index(item),
      item: { type: 'message', id: item.id, status: 'in_progress', role: 'assistant', content: [] }
    });
    this._write('response.content_part.added', {
      item_id: item.id,
      output_index: this._index(item),
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [], logprobs: [] }
    });
    return item;
  }

  _closeMessage(item, { status, text, parsed }) {
    item.status = status;
    if (typeof text === 'string') item.text = text;
    if (parsed !== undefined) item.parsed = parsed;
    const output_index = this._index(item);
    this._write('response.output_text.done', {
      item_id: item.id,
      output_index,
      content_index: 0,
      text: item.text,
      logprobs: []
    });
    const part = this._part(item);
    this._write('response.content_part.done', {
      item_id: item.id,
      output_index,
      content_index: 0,
      part
    });
    this._write('response.output_item.done', { output_index, item: this._itemJson(item) });
    if (this.current === item) this.current = null;
  }

  _part(item) {
    return {
      type: 'output_text',
      text: item.text,
      annotations: [],
      logprobs: [],
      ...(item.parsed !== undefined ? { parsed: item.parsed } : {})
    };
  }

  _itemJson(item) {
    if (item.kind === 'message') {
      return {
        type: 'message',
        id: item.id,
        status: item.status,
        role: 'assistant',
        content: [this._part(item)]
      };
    }
    return {
      type: 'ihub_tool_call',
      id: item.id,
      call_id: item.callId,
      name: item.name,
      arguments: item.arguments,
      output: item.output,
      status: item.status,
      ...(item.error ? { error: item.error } : {})
    };
  }

  /** A piece of the answer. */
  textDelta(text) {
    if (!text || this.closed) return;
    const item = this.current || this._openMessage();
    item.text += text;
    this._write('response.output_text.delta', {
      item_id: item.id,
      output_index: this._index(item),
      content_index: 0,
      delta: text,
      logprobs: []
    });
  }

  /** The answer so far was rejected by validation; the next text is a new attempt. */
  rejectAttempt() {
    const item = this.current;
    if (!item) return;
    item.discarded = true;
    this._closeMessage(item, { status: 'incomplete' });
  }

  /** An iHub tool started. */
  toolStarted({ callId, name, args }) {
    if (this.closed) return;
    const item = {
      kind: 'tool',
      id: newToolItemId(),
      callId: callId ? String(callId) : newToolItemId(),
      name: String(name || 'tool'),
      arguments: toJsonString(args ?? {}),
      output: null,
      status: 'in_progress',
      discarded: false
    };
    this.items.push(item);
    this.toolItems.set(item.callId, item);
    this._write('response.output_item.added', {
      output_index: this._index(item),
      item: this._itemJson(item)
    });
  }

  /** An iHub tool finished. */
  toolCompleted({ callId, name, output, error }) {
    if (this.closed) return;
    let item = callId ? this.toolItems.get(String(callId)) : null;
    if (!item) {
      this.toolStarted({ callId, name, args: {} });
      item = this.items.at(-1);
    }
    item.output = toJsonString(output);
    item.status = error ? 'failed' : 'completed';
    if (error)
      item.error = { code: error.code || 'TOOL_ERROR', message: error.message || 'Tool failed' };
    this._write('response.output_item.done', {
      output_index: this._index(item),
      item: this._itemJson(item)
    });
  }

  /** Items of the final response: everything but rejected attempts. */
  _output() {
    return this.items.filter(item => !item.discarded).map(item => this._itemJson(item));
  }

  /**
   * The turn completed: settle the answer and send `response.completed`.
   *
   * @param {Object} options
   * @param {string} options.text - The final answer (the validated JSON for structured output).
   * @param {*} [options.parsed] - The validated structured output.
   * @param {Object|null} [options.usage] - iHub usage.
   * @returns {Object} The completed response object.
   */
  complete({ text, parsed, usage }) {
    let item = this.current;
    if (!item && text) {
      // An answer that arrived whole (a passthrough tool, Anthropic's
      // structured output) still reaches the caller as text first.
      item = this._openMessage();
      this.textDelta(text);
    }
    if (item) this._closeMessage(item, { status: 'completed', text, parsed });
    const response = this.response({
      status: 'completed',
      output: this._output(),
      usage: responsesUsage(usage)
    });
    this._write('response.completed', { response });
    this._end();
    return response;
  }

  /**
   * The turn failed: close what is open and send `response.failed`.
   *
   * @param {Error} error - InferenceApiError (or anything else, reported as internal).
   * @param {Object|null} [usage]
   * @returns {Object} The failed response object.
   */
  fail(error, usage = null) {
    if (this.current) this._closeMessage(this.current, { status: 'incomplete' });
    const response = this.response({
      status: 'failed',
      error: openAiErrorObject(error),
      output: this._output(),
      usage: responsesUsage(usage)
    });
    this._write('response.failed', { response });
    this._end();
    return response;
  }

  _end() {
    this.closed = true;
    if (this.writable) this.res.end();
  }
}
