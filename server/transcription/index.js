/**
 * Transcription provider registry.
 *
 * Maps a model's `provider` id to a speech-to-text implementation. Parallel to
 * `server/adapters/index.js` (the chat-completion adapter registry), but
 * intentionally separate: transcription models are not chat models and are not
 * routed through the LLM adapter pipeline.
 *
 * The realtime WebSocket bridge (`server/websocket/realtimeTranscription.js`)
 * owns everything that is the same for every provider — auth, connection
 * limits, timers, buffering, backpressure, keepalive, and the browser-facing
 * protocol. A provider owns endpoint resolution and the upstream wire format.
 *
 * ## Provider contract
 *
 * Every provider:
 *   resolveUpstream(model) → cfg
 *     Connection details `{ url, apiKey, model, … }`. `url` must stay
 *     credential-free: the bridge logs it on failure. Credentials are joined in
 *     `connect()` instead.
 *
 * Streaming providers (`mode: 'stream'`) additionally own the upstream socket's
 * protocol. The bridge drives them in this order:
 *   connect(cfg)            → { url, options }   what to actually dial
 *   openFrames(cfg)         → [json]             sent as soon as the socket opens
 *   ← interpret(msg)        → 'session-ready'    upstream says the session exists
 *   readyFrames(cfg)        → [json]             sent once, before audio flows
 *   audioFrame(base64, cfg) → json               one chunk of PCM16 16 kHz mono
 *   stopFrames(cfg)         → [json]             the client sent `stop`
 *   interpret(msg)          → { kind, text?, error? }
 *                             kind: session-ready | delta | final | error | ignore
 *   readyFallbackMs         → number             assume ready after this long with
 *                                                no session-ready frame (0 = never)
 *
 * Batch providers (`mode: 'batch'`) have no upstream protocol. The bridge
 * buffers the audio the browser streams and calls, once, on `stop`:
 *   transcribe({ cfg, pcm, sampleRate, signal }) → { text }
 * The browser-facing protocol is identical either way, so a batch model looks
 * to the client like a streaming one that emits a single `final`.
 */
import vllmRealtimeProvider from './vllmRealtimeProvider.js';
import googleLiveProvider from './googleLiveProvider.js';
import googleTranscribeProvider from './googleTranscribeProvider.js';

const providers = {
  'vllm-realtime': vllmRealtimeProvider,
  'google-live': googleLiveProvider,
  'google-transcribe': googleTranscribeProvider
};

/**
 * @param {string} providerId
 * @returns {Object|null} The provider implementation, or null when unknown.
 */
export function getTranscriptionProvider(providerId) {
  return providers[providerId] || null;
}

/**
 * @param {Object} model
 * @returns {boolean} True when the model is a transcription model.
 */
export function isTranscriptionModel(model) {
  return model?.modelType === 'transcription';
}

export default { getTranscriptionProvider, isTranscriptionModel };
