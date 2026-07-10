/**
 * Transcription provider registry.
 *
 * Maps a model's `provider` id to a transcription provider implementation. A
 * provider exposes `resolveUpstream(model) → { url, apiKey, model }`, the
 * connection details the realtime WebSocket bridge uses to reach the upstream
 * speech-to-text endpoint.
 *
 * Parallel to `server/adapters/index.js` (the chat-completion adapter
 * registry), but intentionally separate: transcription models are not chat
 * models and are not routed through the LLM adapter pipeline.
 *
 * SCOPE (deliberate): today a provider abstracts endpoint RESOLUTION only.
 * The upstream wire protocol (session.update / input_audio_buffer.* /
 * transcription.delta|done) is vLLM-realtime and lives in the bridge
 * (server/websocket/realtimeTranscription.js). When a second, protocol-
 * incompatible provider (OpenAI realtime, Azure, …) becomes real, the
 * intended boundary is a provider-owned upstream session adapter — roughly
 * `createUpstreamSession(socket, { onReady, onDelta, onFinal, onError }) →
 * { sendAudio(buf), stop(), close() }` — with the bridge keeping auth,
 * limits, timers, buffering, and the browser-facing protocol. Do not build
 * that adapter before a second provider exists.
 */
import vllmRealtimeProvider from './vllmRealtimeProvider.js';

const providers = {
  'vllm-realtime': vllmRealtimeProvider
};

/**
 * @param {string} providerId
 * @returns {{ resolveUpstream: Function } | null}
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
