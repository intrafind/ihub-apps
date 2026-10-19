// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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
 *   maxRealtimeFactor       → number (optional)  pace a file (`start.source: 'file'`)
 *                                                at this multiple of real time
 *   maxSessionSeconds       → number (optional)  open a fresh upstream session
 *                                                before this; `interpret` may also
 *                                                return kind `go-away` to ask for it
 *   Both can be overridden per model in `config`.
 *
 * Streaming providers may also take part in conversation mode (voice mode:
 * many user turns over one upstream session; `start.conversation: true`).
 * All three are optional, and a provider without them is safe: the bridge
 * sends nothing at the end of a turn and settles on the upstream going quiet.
 *   commitFrames(cfg)       → [json]             the user's turn ended: flush
 *                                                what the upstream holds back,
 *                                                without ending the session
 *   turnStartFrames(cfg)    → [json]             arm the upstream for the next
 *                                                turn; sent once, before the
 *                                                first audio after a commit
 *                                                (`readyFrames` armed turn 1)
 *   commitEndsWithFinal     → boolean            the upstream answers the commit
 *                                                with a `final` carrying the
 *                                                turn's text: wait for it
 *                                                instead of settling on quiet
 *
 * Batch providers (`mode: 'batch'`) have no upstream protocol. The bridge
 * buffers the audio the browser streams and calls, once, on `stop`:
 *   transcribe({ cfg, pcm, sampleRate, signal }) → { text }
 * The browser-facing protocol is identical either way, so a batch model looks
 * to the client like a streaming one that emits a single `final`. In
 * conversation mode it is called once per `commit` with that turn's audio.
 */
import vllmRealtimeProvider from './vllmRealtimeProvider.js';
import googleLiveProvider from './googleLiveProvider.js';
import googleTranscribeProvider from './googleTranscribeProvider.js';
import mistralRealtimeProvider from './mistralRealtimeProvider.js';
import openaiTranscribeProvider from './openaiTranscribeProvider.js';

// `mistral`, `openai` and `local` are chat API types too: a model only reaches
// this registry with `modelType: 'transcription'` (the bridge checks it
// first), as Voxtral TTS reaches server/tts/ with `modelType: 'tts'`. The two
// OpenAI types speak the OpenAI audio API (`/audio/transcriptions`): Whisper
// on T-Systems LLM Hub, OpenAI, vLLM.
const providers = {
  'vllm-realtime': vllmRealtimeProvider,
  'google-live': googleLiveProvider,
  'google-transcribe': googleTranscribeProvider,
  mistral: mistralRealtimeProvider,
  openai: openaiTranscribeProvider,
  local: openaiTranscribeProvider
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
