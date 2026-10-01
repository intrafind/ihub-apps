/**
 * Mistral realtime transcription provider (`voxtral-mini-transcribe-realtime-2602`
 * on the Mistral platform).
 *
 * The hosted counterpart of the self-hosted Voxtral model on vLLM
 * (`vllmRealtimeProvider.js`): the same model family, but Mistral's own wire
 * protocol. Registered for `provider: 'mistral'` with `modelType:
 * 'transcription'` — like the Voxtral TTS model — so it takes the Mistral API
 * key the chat models already use. The bridge keeps auth, limits, timers,
 * buffering and the browser-facing protocol; this module owns the wire format.
 *
 * Wire protocol (WSS, `…/v1/audio/transcriptions/realtime?model=…`):
 *   ← { type: 'session.created', session }                         session ready
 *   → { type: 'session.update', session: { audio_format, … } }     PCM16 16 kHz mono
 *   → { type: 'input_audio.append', audio }                        base64 audio in
 *   ← { type: 'transcription.text.delta', text }                   streaming text
 *   → { type: 'input_audio.flush' }, { type: 'input_audio.end' }   end of audio
 *   ← { type: 'transcription.done', text, language, segments }     the whole transcript
 *   ← { type: 'error', error: { message, code } }
 * `session.updated`, `transcription.language` and `transcription.segment` need
 * no client action. The browser already streams PCM16 at 16 kHz mono, so no
 * client change is needed.
 *
 * The server authenticates with the API key as a Bearer token. Mistral's
 * short-lived `rt_*` client tokens exist for browsers that dial Mistral
 * directly; behind the bridge the key never leaves the server.
 *
 * Docs: https://docs.mistral.ai/studio/audio/speech_to_text/realtime_transcription
 * (the frame names are those of Mistral's SDK, `@mistralai/mistralai`
 * `extra/realtime`).
 */
import { expandEnvVars, resolveApiKey } from './credentials.js';

/** Default realtime endpoint. Overridable per model via `url`. */
export const DEFAULT_REALTIME_URL = 'wss://api.mistral.ai/v1/audio/transcriptions/realtime';

/** The audio the bridge relays: raw little-endian 16-bit PCM, 16 kHz mono. */
export const AUDIO_FORMAT = Object.freeze({ encoding: 'pcm_s16le', sample_rate: 16000 });

/**
 * Resolve upstream connection details.
 *
 * `url` stays credential-free — the bridge logs it on failure. The model goes
 * into the query string in `connect()`.
 *
 * @param {Object} model - The transcription model config (as stored in cache).
 * @returns {{ url: string, apiKey: string, model: string, targetStreamingDelayMs: number|null }}
 */
export function resolveUpstream(model) {
  const delay = Number(model?.config?.targetStreamingDelayMs);
  return {
    url: expandEnvVars(model?.url || '').trim() || DEFAULT_REALTIME_URL,
    // Same chain a Mistral chat model uses: model key, the `mistral` provider
    // key, <MODEL_ID>_API_KEY, MISTRAL_API_KEY.
    apiKey: resolveApiKey(model, { credentialProvider: 'mistral', envVars: ['MISTRAL_API_KEY'] }),
    model: model?.modelId || '',
    targetStreamingDelayMs: Number.isInteger(delay) && delay > 0 ? delay : null
  };
}

/** Dial details: the model as a query parameter, the key as a Bearer token. */
export function connect(cfg) {
  const url = new URL(cfg.url);
  if (cfg.model) url.searchParams.set('model', cfg.model);
  const headers = {};
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  return { url: url.toString(), options: { headers } };
}

/** Nothing to send before `session.created` arrives. */
export function openFrames() {
  return [];
}

/** Declare the audio format (and the streaming delay, when configured). */
export function readyFrames(cfg) {
  const session = { audio_format: { ...AUDIO_FORMAT } };
  if (cfg?.targetStreamingDelayMs) session.target_streaming_delay_ms = cfg.targetStreamingDelayMs;
  return [{ type: 'session.update', session }];
}

/** One chunk of base64 PCM16 (16 kHz mono). */
export function audioFrame(base64) {
  return { type: 'input_audio.append', audio: base64 };
}

/** End of audio: flush what is buffered, then end the stream so `transcription.done` follows. */
export function stopFrames() {
  return [{ type: 'input_audio.flush' }, { type: 'input_audio.end' }];
}

/**
 * Reduce a Mistral error payload to a short string. `error.message` may be a
 * string or an object (validation details).
 *
 * @param {*} error
 * @returns {string}
 */
export function formatUpstreamError(error) {
  if (!error) return 'unknown';
  if (typeof error === 'string') return error;
  const message =
    typeof error.message === 'string'
      ? error.message
      : error.message
        ? JSON.stringify(error.message)
        : '';
  return [error.code, message].filter(Boolean).join(': ') || 'unknown';
}

/**
 * Classify one parsed upstream frame for the bridge.
 *
 * Text deltas stream the transcript as it is recognized. `transcription.done`
 * carries the whole transcript once the audio has ended; as a `final` it
 * replaces the accumulated deltas on the client.
 *
 * @param {Object} msg
 * @returns {{ kind: 'session-ready'|'delta'|'final'|'error'|'ignore', text?: string, error?: string }}
 */
export function interpret(msg = {}) {
  switch (msg.type) {
    case 'session.created':
      return { kind: 'session-ready' };
    case 'transcription.text.delta':
      return { kind: 'delta', text: typeof msg.text === 'string' ? msg.text : '' };
    case 'transcription.done':
      return { kind: 'final', text: typeof msg.text === 'string' ? msg.text : '' };
    case 'error':
      return { kind: 'error', error: formatUpstreamError(msg.error) };
    default:
      return { kind: 'ignore' };
  }
}

export default {
  id: 'mistral',
  mode: 'stream',
  // `session.created` is the first frame of every session, so there is no
  // fallback window: a handshake that never completes is caught by the
  // bridge's idle timer.
  readyFallbackMs: 0,
  resolveUpstream,
  connect,
  openFrames,
  readyFrames,
  audioFrame,
  stopFrames,
  interpret
};
