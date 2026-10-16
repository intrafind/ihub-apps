// Mirrors each server transcription provider's `mode` (server/transcription/*).
// The admin model list does not carry the public `transcriptionMode` field.
const STREAMING_PROVIDERS = new Set(['vllm-realtime', 'google-live', 'mistral']);

/**
 * Whether a transcription model streams (answers while the audio arrives).
 * Dictation needs one; batch models (google-transcribe, openai, local) only
 * answer once all the audio is there.
 *
 * @param {object} model Model config.
 * @returns {boolean}
 */
export const isStreamingTranscriptionModel = model =>
  model?.transcriptionMode
    ? model.transcriptionMode === 'stream'
    : STREAMING_PROVIDERS.has(model?.provider);
