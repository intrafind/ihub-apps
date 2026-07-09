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
