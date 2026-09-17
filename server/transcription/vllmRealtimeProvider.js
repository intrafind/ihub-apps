/**
 * vLLM realtime transcription provider (e.g. Voxtral on `/v1/realtime`).
 *
 * Resolves a `modelType: 'transcription'`, `provider: 'vllm-realtime'` model
 * config into the concrete upstream connection details the realtime WebSocket
 * bridge needs, and owns the vLLM realtime **wire protocol**: which frames to
 * send when, and how to read what comes back. All of it stays server-side — the
 * browser only ever sends a model *id*, never a URL or key (see the models-API
 * sanitization in modelRoutes.js).
 *
 * The bridge (`server/websocket/realtimeTranscription.js`) keeps auth, limits,
 * timers, buffering and the browser-facing protocol; everything vLLM-specific
 * lives here. See `server/transcription/index.js` for the contract.
 *
 * Protocol reference: https://docs.vllm.ai/ —
 *   session.created / session.update / input_audio_buffer.append|commit /
 *   transcription.delta|done / error
 */
import { expandEnvVars, resolveApiKey } from './credentials.js';

// The vLLM realtime protocol sends `session.created` on connect and we defer
// session.update + the initial commit until then, so the client only streams
// into a fully-initialized session. Some builds don't emit session.created, so
// the bridge initializes anyway after this fallback window.
const SESSION_CREATED_FALLBACK_MS = 2_000;

/**
 * Extract the transcript text from a vLLM realtime transcription frame,
 * tolerating field-name variants across vLLM versions. The documented shapes
 * are `transcription.delta` → `{ delta }` and `transcription.done` → `{ text }`,
 * but some builds use `text` on delta or nest it under `.text`, so we look
 * across the known field names (in preference order for the given event) and
 * fall back to a nested `.text`.
 *
 * @param {Object} msg - Parsed upstream JSON frame.
 * @param {string[]} [preferred] - Field names to try first, in order.
 * @returns {string}
 */
export function extractTranscriptText(msg = {}, preferred = ['delta', 'text', 'transcript']) {
  for (const field of preferred) {
    const val = msg[field];
    if (typeof val === 'string' && val.length) return val;
    if (val && typeof val === 'object' && typeof val.text === 'string') return val.text;
  }
  return '';
}

/**
 * @param {Object} model - The transcription model config (as stored in cache).
 * @returns {{ url: string, apiKey: string, model: string }} Upstream connection
 *   details. `model` is the upstream model id sent in the vLLM session.update.
 */
export function resolveUpstream(model) {
  return {
    url: expandEnvVars(model?.url || '').trim(),
    // Self-hosted endpoints often need no auth, so there is deliberately no
    // environment fallback here: an unset key means "send no Authorization".
    apiKey: resolveApiKey(model),
    model: model?.modelId || ''
  };
}

/** Dial details. vLLM authenticates with a bearer token header. */
export function connect(cfg) {
  const headers = {};
  if (cfg?.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  return { url: cfg.url, options: { headers } };
}

/** Nothing to send before `session.created` arrives. */
export function openFrames() {
  return [];
}

/**
 * Identify the model and send the initial commit (which starts transcription
 * generation). The spurious empty `transcription.done` the initial commit can
 * emit is absorbed by the bridge's post-stop settle timer.
 */
export function readyFrames(cfg) {
  return [{ type: 'session.update', model: cfg.model }, { type: 'input_audio_buffer.commit' }];
}

/** One chunk of base64 PCM16 (16 kHz mono). */
export function audioFrame(base64) {
  return { type: 'input_audio_buffer.append', audio: base64 };
}

/** End of audio: a final commit so the tail utterance is transcribed. */
export function stopFrames() {
  return [{ type: 'input_audio_buffer.commit', final: true }];
}

/**
 * Classify one parsed upstream frame for the bridge.
 *
 * @param {Object} msg
 * @returns {{ kind: 'session-ready'|'delta'|'final'|'error'|'ignore', text?: string, error?: string }}
 */
export function interpret(msg = {}) {
  switch (msg.type) {
    case 'transcription.delta':
      return { kind: 'delta', text: extractTranscriptText(msg, ['delta', 'text', 'transcript']) };
    case 'transcription.done':
      return { kind: 'final', text: extractTranscriptText(msg, ['text', 'transcript', 'delta']) };
    case 'session.created':
      return { kind: 'session-ready' };
    case 'error':
      return { kind: 'error', error: msg.error || 'unknown' };
    default:
      return { kind: 'ignore' };
  }
}

export default {
  id: 'vllm-realtime',
  mode: 'stream',
  readyFallbackMs: SESSION_CREATED_FALLBACK_MS,
  resolveUpstream,
  connect,
  openFrames,
  readyFrames,
  audioFrame,
  stopFrames,
  interpret
};
