// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * One chat as the browser drives it:
 *   1. GET  /api/apps/{appId}/chat/{chatId}   (SSE, kept open for the whole session)
 *   2. wait for `stream/connected`
 *   3. POST /api/apps/{appId}/chat/{chatId}   per turn, exactly one message
 *   4. read `step/delta` … `run/ended` from the stream
 *
 * Metrics per turn (prefix = scenario label):
 *   <label>.ttft          send → first text delta (ms)
 *   <label>.duration      send → run/ended (ms)
 *   <label>.charsPerSec   streamed answer speed after the first token
 *   <label>.outputChars   answer length
 *   <label>.promptTokens  prompt size the server reported (shows injected project context)
 *   <label>.tools         tool calls in the turn (knowledge_search …)
 *   counters: <label>.turn.ok | <label>.turn.error | <label>.streamMiss
 */

import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { readSse, EventPuller } from './sse.mjs';

const CONNECT_TIMEOUT_MS = 15_000;

export function newChatId() {
  return `chat-lt-${randomUUID()}`;
}

function messageId() {
  return `msg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

export class ChatSession {
  /**
   * @param {object} ctx  VU context (client, metrics, config)
   * @param {object} opts
   * @param {string} opts.appId
   * @param {string} [opts.chatId]
   * @param {string} opts.label  metric prefix, e.g. "chat" or "projectChat"
   */
  constructor(ctx, { appId, chatId = newChatId(), label }) {
    this.ctx = ctx;
    this.appId = appId;
    this.chatId = chatId;
    this.label = label;
    this.path = `/api/apps/${encodeURIComponent(appId)}/chat/${encodeURIComponent(chatId)}`;
    this.abort = new AbortController();
    this.puller = null;
    this.turns = 0;
  }

  async open() {
    const { client, metrics } = this.ctx;
    const t0 = performance.now();
    let res;
    try {
      res = await client.raw('GET', this.path, {
        headers: { Accept: 'text/event-stream' },
        signal: this.abort.signal
      });
    } catch (err) {
      metrics.error('sse.connect', 'network');
      throw err;
    }
    if (!res.ok || !res.body) {
      metrics.error('sse.connect', `HTTP_${res.status}`);
      const err = new Error(`SSE connect failed: HTTP ${res.status}`);
      err.code = `SSE_HTTP_${res.status}`;
      throw err;
    }
    this.puller = new EventPuller(readSse(res.body));
    for (;;) {
      const ev = await this.puller.next(CONNECT_TIMEOUT_MS);
      if (!ev) throw Object.assign(new Error('SSE closed before connect'), { code: 'SSE_CLOSED' });
      if (ev.event === 'stream/connected') break;
    }
    metrics.trend('sse.connect', performance.now() - t0);
    return this;
  }

  /**
   * Send one user message and read the answer.
   * @param {object} msg
   * @param {string} msg.content
   * @param {string[]} [msg.fileIds]
   * @param {object} [msg.body]  extra top-level POST fields (projectId, modelId, ephemeral …)
   */
  async turn({ content, fileIds, body = {} }) {
    const { client, metrics, config } = this.ctx;
    const label = this.label;
    const turnTimeoutMs = (config.turnTimeoutSec ?? 300) * 1000;
    const idleTimeoutMs = (config.streamIdleTimeoutSec ?? 120) * 1000;

    const message = { role: 'user', content, messageId: messageId(), variables: {} };
    if (fileIds?.length) message.fileIds = fileIds;
    const payload = {
      messages: [message],
      language: config.language || 'en',
      style: 'normal',
      outputFormat: 'markdown',
      sendChatHistory: true,
      ...(config.modelId ? { modelId: config.modelId } : {}),
      ...body
    };

    const tSend = performance.now();
    let postResult = null;
    let postError = null;
    const postSettled = client
      .request('POST', this.path, {
        json: payload,
        name: `${label}.post`,
        timeoutMs: turnTimeoutMs
      })
      .then(
        r => (postResult = r),
        e => (postError = e)
      )
      .then(() => ({ postSettled: true }));

    let ttft = null;
    let firstAt = null;
    let chars = 0;
    let tools = 0;
    let ended = null;
    let streamError = null;
    let postDone = false;

    const deadline = tSend + turnTimeoutMs;
    while (!ended && !streamError) {
      if (performance.now() > deadline) {
        streamError = { code: 'TURN_TIMEOUT' };
        break;
      }
      // After the POST came back the run is over on the server; allow a short
      // grace for the trailing events to arrive over the stream.
      const waitMs = postDone ? 5_000 : idleTimeoutMs;
      let ev;
      try {
        ev = await (postDone
          ? this.puller.next(waitMs)
          : Promise.race([this.puller.next(waitMs), postSettled]));
      } catch (err) {
        streamError = { code: err.code || 'STREAM_TIMEOUT' };
        break;
      }
      if (ev && ev.postSettled) {
        postDone = true;
        if (postError) {
          streamError = { code: postError.code || postError.name || 'POST_FAILED' };
          break;
        }
        const b = postResult.body;
        if (!postResult.ok) {
          streamError = { code: b?.code || `HTTP_${postResult.status}` };
          break;
        }
        if (b && b.status === 'error') {
          streamError = { code: b.code || 'RUN_ERROR' };
          break;
        }
        if (b && b.status !== 'streaming' && typeof b.content === 'string') {
          // The server found no stream for this chat (GET and POST hit different
          // pods without session affinity) and answered without streaming.
          metrics.count(`${label}.streamMiss`);
          chars = b.content.length;
          ended = { status: 'completed', usage: b.usage };
          break;
        }
        continue;
      }
      if (!ev) {
        streamError = { code: 'SSE_CLOSED' };
        break;
      }
      const data = ev.data?.data ?? {};
      switch (ev.event) {
        case 'step/delta':
          if (data.kind === 'text' && typeof data.content === 'string') {
            if (ttft === null) {
              firstAt = performance.now();
              ttft = firstAt - tSend;
            }
            chars += data.content.length;
          }
          break;
        case 'tool/started':
          tools += 1;
          break;
        case 'stream/error':
          streamError = { code: data.code || 'STREAM_ERROR' };
          break;
        case 'run/paused':
          ended = { status: 'paused' };
          break;
        case 'run/ended':
          if (!data.parentRunId) ended = data;
          break;
        default:
          break;
      }
    }

    const tEnd = performance.now();
    if (!postDone) {
      // Do not leave the POST dangling into the next turn.
      await Promise.race([postSettled, new Promise(r => setTimeout(r, 10_000))]);
    }
    this.turns += 1;

    if (streamError || (ended && ended.status && ended.status !== 'completed')) {
      const code = streamError?.code || `RUN_${String(ended.status).toUpperCase()}`;
      metrics.count(`${label}.turn.error`);
      metrics.error(label, code);
      const err = new Error(`${label} turn failed: ${code}`);
      err.code = code;
      err.fatal = code === 'SSE_CLOSED' || code === 'STREAM_TIMEOUT';
      throw err;
    }

    metrics.count(`${label}.turn.ok`);
    if (ttft !== null) metrics.trend(`${label}.ttft`, ttft);
    metrics.trend(`${label}.duration`, tEnd - tSend);
    metrics.trend(`${label}.outputChars`, chars);
    metrics.trend(`${label}.tools`, tools);
    if (firstAt !== null && tEnd - firstAt > 50) {
      metrics.trend(`${label}.charsPerSec`, (chars * 1000) / (tEnd - firstAt));
    }
    const usage = ended?.usage || {};
    const promptTokens = usage.promptTokens ?? usage.prompt_tokens ?? usage.inputTokens;
    if (Number.isFinite(promptTokens)) metrics.trend(`${label}.promptTokens`, promptTokens);
    return { ttft, chars, tools, durationMs: tEnd - tSend };
  }

  close() {
    this.abort.abort();
  }
}

/**
 * One streamed request against the OpenAI-compatible Inference API
 * (`/api/inference/v1/chat/completions`): pure LLM path, no chat persistence.
 */
export async function inferenceTurn(ctx, { model, messages, label = 'inference' }) {
  const { client, metrics, config } = ctx;
  const tSend = performance.now();
  const res = await client.raw('POST', '/api/inference/v1/chat/completions', {
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true }
    }),
    signal: AbortSignal.timeout((config.turnTimeoutSec ?? 300) * 1000)
  });
  if (!res.ok) {
    let code = `HTTP_${res.status}`;
    try {
      code = (await res.json()).error?.code || code;
    } catch {
      /* ignore */
    }
    metrics.count(`${label}.turn.error`);
    metrics.error(label, code);
    throw Object.assign(new Error(`${label}: ${code}`), { code });
  }
  let ttft = null;
  let chars = 0;
  let usage = null;
  for await (const ev of readSse(res.body)) {
    if (ev.data === '[DONE]') break;
    const delta = ev.data?.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta.length) {
      if (ttft === null) ttft = performance.now() - tSend;
      chars += delta.length;
    }
    if (ev.data?.usage) usage = ev.data.usage;
  }
  const total = performance.now() - tSend;
  metrics.count(`${label}.turn.ok`);
  if (ttft !== null) metrics.trend(`${label}.ttft`, ttft);
  metrics.trend(`${label}.duration`, total);
  metrics.trend(`${label}.outputChars`, chars);
  if (usage?.prompt_tokens) metrics.trend(`${label}.promptTokens`, usage.prompt_tokens);
  return { ttft, chars };
}
