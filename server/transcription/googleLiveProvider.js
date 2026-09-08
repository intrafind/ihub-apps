/**
 * Google Gemini Live API transcription provider (`gemini-3.5-transcribe-live`).
 *
 * Second streaming provider behind the realtime WebSocket bridge, and the
 * reason the vLLM wire protocol moved out of the bridge and into the provider
 * registry: the two upstreams are protocol-incompatible. The bridge still owns
 * auth, connection limits, timers, buffering, backpressure and the
 * browser-facing protocol; this module owns the Gemini Live wire format.
 *
 * Wire protocol (BidiGenerateContent over WSS):
 *   → { setup: { model, generationConfig, inputAudioTranscription } }   on open
 *   ← { setupComplete: {} }                                            session ready
 *   → { realtimeInput: { audio: { data, mimeType } } }                 audio in
 *   ← { serverContent: { interimInputTranscription: { text } } }       partial
 *   ← { serverContent: { inputTranscription: { text } } }              finalized
 *   → { realtimeInput: { audioStreamEnd: true } }                      end of audio
 * Audio must be raw little-endian 16-bit PCM at 16 kHz mono — exactly what the
 * browser already streams for Voxtral, so no client change is needed.
 *
 * Limits worth knowing (they are Google's, not ours): a Live API session runs
 * for at most 10 minutes, so longer recordings belong on the batch provider
 * (`google-transcribe`).
 *
 * Docs: https://ai.google.dev/gemini-api/docs/live-api/live-transcribe
 */
import { expandEnvVars, resolveApiKey } from './credentials.js';

/** Default Live API endpoint. Overridable per model via `url`. */
export const DEFAULT_LIVE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

/** PCM format the Live API requires for input audio. */
export const INPUT_AUDIO_MIME_TYPE = 'audio/pcm;rate=16000';

/**
 * Resolve upstream connection details.
 *
 * `url` stays credential-free — the bridge logs it on failure, and the API key
 * only ever joins the URL inside `connect()`.
 *
 * @param {Object} model
 * @returns {{ url: string, apiKey: string, model: string, languageCodes: string[] }}
 */
export function resolveUpstream(model) {
  const url = expandEnvVars(model?.url || '').trim() || DEFAULT_LIVE_URL;
  const languageCodes = Array.isArray(model?.config?.languageCodes)
    ? model.config.languageCodes.filter(code => typeof code === 'string' && code)
    : [];
  return {
    url,
    apiKey: resolveApiKey(model, { credentialProvider: 'google', envVars: ['GOOGLE_API_KEY'] }),
    model: model?.modelId || '',
    languageCodes
  };
}

/**
 * The Live API authenticates with a `key` query parameter rather than a header.
 * Built here (not in `resolveUpstream`) so the key never lands in `cfg.url`,
 * which the bridge writes to its logs.
 */
export function connect(cfg) {
  const url = new URL(cfg.url);
  if (cfg.apiKey) url.searchParams.set('key', cfg.apiKey);
  return { url: url.toString(), options: {} };
}

/**
 * The setup frame must be the first message on the socket, before any audio.
 * An empty `languageCodes` asks Gemini to auto-detect (and code-switch).
 */
export function openFrames(cfg) {
  return [
    {
      setup: {
        model: cfg.model?.startsWith('models/') ? cfg.model : `models/${cfg.model}`,
        generationConfig: { responseModalities: ['TEXT'] },
        inputAudioTranscription: { languageCodes: cfg.languageCodes || [] }
      }
    }
  ];
}

/** Setup already went out on open; nothing more once `setupComplete` arrives. */
export function readyFrames() {
  return [];
}

/** One chunk of base64 PCM16 (16 kHz mono). */
export function audioFrame(base64) {
  return { realtimeInput: { audio: { data: base64, mimeType: INPUT_AUDIO_MIME_TYPE } } };
}

/** End of audio, so Gemini finalizes the trailing utterance. */
export function stopFrames() {
  return [{ realtimeInput: { audioStreamEnd: true } }];
}

/**
 * Reduce a Gemini error payload to a short string. The shape varies between
 * `{ error: { code, message, status } }` and a bare string.
 *
 * @param {*} error
 * @returns {string}
 */
export function formatUpstreamError(error) {
  if (!error) return 'unknown';
  if (typeof error === 'string') return error;
  const { code, message, status } = error;
  return [status || code, message].filter(Boolean).join(': ') || 'unknown';
}

/**
 * Classify one parsed upstream frame for the bridge.
 *
 * `interimInputTranscription` is a speculative partial hypothesis that gets
 * revised while the speaker is still talking, so it maps to `delta` (the bridge
 * relays it as streaming text). `inputTranscription` is the finalized segment
 * and maps to `final`, which is what the client keeps.
 *
 * @param {Object} msg
 * @returns {{ kind: 'session-ready'|'delta'|'final'|'error'|'ignore', text?: string, error?: string }}
 */
export function interpret(msg = {}) {
  if (msg.setupComplete) return { kind: 'session-ready' };
  if (msg.error) return { kind: 'error', error: formatUpstreamError(msg.error) };

  const content = msg.serverContent;
  if (content) {
    const interim = content.interimInputTranscription?.text;
    if (typeof interim === 'string' && interim.length) return { kind: 'delta', text: interim };
    const finalText = content.inputTranscription?.text;
    if (typeof finalText === 'string' && finalText.length)
      return { kind: 'final', text: finalText };
  }
  // goAway, sessionResumptionUpdate, usageMetadata, turnComplete, … need no
  // client action; the bridge's own timers govern the session.
  return { kind: 'ignore' };
}

export default {
  id: 'google-live',
  mode: 'stream',
  // `setupComplete` is guaranteed by the protocol, and sending audio before it
  // arrives is an error — so there is no fallback window here. A handshake that
  // never completes is caught by the bridge's idle timer.
  readyFallbackMs: 0,
  resolveUpstream,
  connect,
  openFrames,
  readyFrames,
  audioFrame,
  stopFrames,
  interpret
};
