/**
 * vLLM realtime transcription provider.
 *
 * Resolves a `modelType: 'transcription'`, `provider: 'vllm-realtime'` model
 * config into the concrete upstream connection details the realtime WebSocket
 * bridge needs: the vLLM `/v1/realtime` URL, the upstream model id, and a
 * decrypted API key. All of these stay server-side — the browser only ever
 * sends a model *id*, never a URL or key (see the models-API sanitization in
 * modelRoutes.js).
 *
 * This is deliberately parallel to `server/adapters/` (the chat-completion
 * adapter registry). Transcription models are NOT routed through
 * `getAdapter()` / `createCompletionRequest`; they use this registry so other
 * STT backends (Whisper, Azure batch, …) can be added the same way later.
 */
import tokenStorageService from '../services/TokenStorageService.js';

/**
 * Expand `${ENV_VAR}` placeholders in a string using process.env, matching the
 * behavior configCache applies to platform config values. Unset variables
 * expand to an empty string.
 */
function expandEnvVars(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([^}]+)\}/g, (_m, name) => process.env[name] || '');
}

/**
 * Resolve the API key for a transcription model. Transcription models store the
 * key directly on the model (the "first-class" design), encrypted at rest.
 * Supports: encrypted (ENC[...]) → decrypted, `${ENV}` placeholder → expanded,
 * plaintext → as-is, or absent → empty string (self-hosted endpoints often need
 * no auth).
 */
function resolveApiKey(rawApiKey) {
  if (!rawApiKey || typeof rawApiKey !== 'string') return '';
  if (tokenStorageService.isEncrypted(rawApiKey)) {
    try {
      return tokenStorageService.decryptString(rawApiKey);
    } catch {
      return '';
    }
  }
  if (rawApiKey.includes('${')) return expandEnvVars(rawApiKey);
  return rawApiKey;
}

/**
 * @param {Object} model - The transcription model config (as stored in cache).
 * @returns {{ url: string, apiKey: string, model: string }} Upstream connection
 *   details. `model` is the upstream model id sent in the vLLM session.update.
 */
export function resolveUpstream(model) {
  return {
    url: expandEnvVars(model?.url || '').trim(),
    apiKey: resolveApiKey(model?.apiKey),
    model: model?.modelId || ''
  };
}

export default {
  id: 'vllm-realtime',
  resolveUpstream
};
