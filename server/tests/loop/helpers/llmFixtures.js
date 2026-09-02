/**
 * Shared fixtures for LLMClient / adapter-conformance tests: fake fetch
 * Responses (SSE, JSON, binary Bedrock EventStream), a deterministic client
 * factory and an in-memory ledger capture.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LLMClient } from '../../../services/loop/LLMClient.js';
import { RunLog } from '../../../services/loop/RunLog.js';

const encoder = new TextEncoder();

/** Build a ReadableStream from byte chunks (Uint8Array or string). */
export function bytesStream(chunks) {
  const parts = chunks.map(c => (typeof c === 'string' ? encoder.encode(c) : c));
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    }
  });
}

/** Split a string into fixed-size pieces (to exercise buffering). */
export function splitEvery(str, size) {
  const out = [];
  for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
  return out;
}

/**
 * Fake fetch Response streaming SSE `data:` events. Each item of `events` may
 * be an object (JSON-encoded), a string (sent verbatim as the data payload,
 * e.g. '[DONE]') or `{ __raw: 'event: ping\n' }` for arbitrary wire lines.
 */
export function sseResponse(events, { status = 200, headers = {}, chunkSize } = {}) {
  const wire = events
    .map(e => {
      if (e && typeof e === 'object' && '__raw' in e) return e.__raw;
      const payload = typeof e === 'string' ? e : JSON.stringify(e);
      return `data: ${payload}\n\n`;
    })
    .join('');
  const pieces = chunkSize ? splitEvery(wire, chunkSize) : [wire];
  return fakeResponse({
    status,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', ...headers },
    body: bytesStream(pieces),
    text: wire
  });
}

/** Fake fetch Response with a JSON body (non-streaming). */
export function jsonResponse(obj, { status = 200, headers = {} } = {}) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return fakeResponse({
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: bytesStream([text]),
    text
  });
}

/** Fake fetch Response with a plain-text body (error bodies). */
export function textResponse(text, { status = 500, headers = {} } = {}) {
  return fakeResponse({
    status,
    headers: { 'content-type': 'text/plain', ...headers },
    body: bytesStream([text]),
    text
  });
}

export function fakeResponse({ status, headers, body, text }) {
  const h = new Headers(headers);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: h,
    body,
    text: async () => text,
    json: async () => JSON.parse(text)
  };
}

// ── Bedrock binary EventStream encoder (mirror of adapters/bedrockEventStream.js) ──

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function u32(view, offset, value) {
  view.setUint32(offset, value >>> 0, false);
}

/**
 * Encode one Bedrock EventStream frame.
 * @param {{eventType?: string, messageType?: string, payload?: object}} frame
 * @returns {Uint8Array}
 */
export function bedrockFrame({ eventType, messageType = 'event', payload = {} }) {
  const headerEntries = [
    [':message-type', messageType],
    ...(eventType ? [[':event-type', eventType]] : [])
  ];
  const headerBytes = [];
  for (const [name, value] of headerEntries) {
    const n = encoder.encode(name);
    const v = encoder.encode(value);
    headerBytes.push(n.length, ...n, 7, (v.length >> 8) & 0xff, v.length & 0xff, ...v);
  }
  const headers = Uint8Array.from(headerBytes);
  const body = encoder.encode(JSON.stringify(payload));
  const total = 12 + headers.length + body.length + 4;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  u32(view, 0, total);
  u32(view, 4, headers.length);
  u32(view, 8, crc32(out, 0, 8));
  out.set(headers, 12);
  out.set(body, 12 + headers.length);
  u32(view, total - 4, crc32(out, 0, total - 4));
  return out;
}

/** Fake Response streaming Bedrock frames. */
export function bedrockResponse(frames) {
  return fakeResponse({
    status: 200,
    headers: { 'content-type': 'application/vnd.amazon.eventstream' },
    body: bytesStream(frames.map(bedrockFrame)),
    text: ''
  });
}

// ── Client factory ──────────────────────────────────────────────────────────

export const MODELS = {
  openai: {
    id: 'oa',
    provider: 'openai',
    modelId: 'gpt-4o',
    url: 'https://u/v1/chat/completions',
    autoDiscovery: false,
    maxOutputTokens: 4096,
    default: true
  },
  local: {
    id: 'vl',
    provider: 'local',
    modelId: 'gpt-oss',
    url: 'http://localhost:8000/v1/chat/completions'
  },
  mistral: {
    id: 'ms',
    provider: 'mistral',
    modelId: 'mistral-small',
    url: 'https://api.mistral.ai/v1/chat/completions'
  },
  anthropic: {
    id: 'an',
    provider: 'anthropic',
    modelId: 'claude-3',
    url: 'https://api.anthropic.com/v1/messages'
  },
  google: {
    id: 'gm',
    provider: 'google',
    modelId: 'gemini-3-pro',
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:generateContent'
  },
  'openai-responses': {
    id: 'or',
    provider: 'openai-responses',
    modelId: 'gpt-5',
    url: 'https://api.openai.com/v1/responses'
  },
  bedrock: {
    id: 'br',
    provider: 'bedrock',
    modelId: 'anthropic.claude',
    url: 'https://bedrock-runtime.eu-central-1.amazonaws.com',
    config: { region: 'eu-central-1' }
  },
  iassistant: {
    id: 'ia',
    provider: 'iassistant-conversation',
    modelId: 'iassistant'
  },
  disabled: {
    id: 'off',
    provider: 'openai',
    modelId: 'gpt-4o-mini',
    url: 'https://u/v1/chat/completions',
    autoDiscovery: false,
    enabled: false
  }
};

export const MODEL_LIST = Object.values(MODELS);

/**
 * Create an LLMClient wired to fakes.
 * @param {Object} opts
 * @param {(request, ctx) => Promise<Response>} opts.transport
 * @param {Array} [opts.models]
 * @param {Object} [opts.apiKey] - resolved key (default 'sk-test')
 * @param {boolean} [opts.realRequest=false] - use the real adapter registry to build requests
 *   (default: a stub request that echoes messages/options, avoids provider-specific quirks)
 */
export function makeClient(opts = {}) {
  const models = opts.models || MODEL_LIST;
  const calls = [];
  const client = new LLMClient({
    transport: async (request, ctx) => {
      calls.push({ request, ctx });
      return opts.transport(request, ctx, calls.length);
    },
    createRequest: opts.realRequest
      ? undefined
      : async (model, messages, apiKey, options) => ({
          url: model.url || `https://fake/${model.provider}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: { model: model.modelId, messages, ...options }
        }),
    apiKeyVerifier: opts.apiKeyVerifier || {
      verifyApiKey: async model =>
        model.provider === 'iassistant-conversation'
          ? { success: true, apiKey: null }
          : { success: true, apiKey: opts.apiKey ?? 'sk-test' }
    },
    errorHandler: opts.errorHandler,
    getModels: includeDisabled => ({
      data: includeDisabled ? models : models.filter(m => m.enabled !== false)
    }),
    runLog: opts.runLog,
    sleep: opts.sleep || (async () => {}),
    maxRetries: opts.maxRetries
  });
  return { client, calls };
}

/** Temp-dir RunLog that persists + captures every event in memory. */
export async function captureRunLog() {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'llmclient-runlog-'));
  const runLog = new RunLog({
    baseDir,
    forceEnabled: true,
    getPlatformConfig: () => ({ runLog: { identityMode: 'default', flushIntervalMs: 20 } }),
    getFeatures: () => ({ runLog: true })
  });
  const events = [];
  runLog.subscribeAll(e => events.push(e));
  return { runLog, events, baseDir };
}

export const openaiText = (deltas, { usage } = {}) => [
  { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
  ...deltas.map(d => ({ choices: [{ index: 0, delta: { content: d }, finish_reason: null }] })),
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], ...(usage ? { usage } : {}) },
  '[DONE]'
];
