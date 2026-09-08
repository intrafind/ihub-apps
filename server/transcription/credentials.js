/**
 * Credential resolution for transcription models.
 *
 * Transcription models store their key directly on the model config (the
 * "first-class model" design of #1927), encrypted at rest. Hosted providers
 * additionally need the usual escape hatches an operator expects — the
 * provider entry in `providers.json`, or a `GOOGLE_API_KEY`-style environment
 * variable — because the key is the same one the chat models already use.
 *
 * Deliberately NOT `getApiKeyForModel()` from `server/utils.js`: that helper
 * ends its provider switch with a `DEFAULT_API_KEY` fallback and an error log
 * when nothing matches, which is wrong for a self-hosted vLLM endpoint that
 * legitimately needs no auth at all. Here an unresolvable key is simply the
 * empty string and each provider decides whether that is fatal.
 */
import configCache from '../configCache.js';
import config from '../config.js';
import tokenStorageService from '../services/TokenStorageService.js';

/**
 * Expand `${ENV_VAR}` placeholders in a string using process.env, matching the
 * behavior configCache applies to platform config values. Unset variables
 * expand to an empty string.
 *
 * @param {*} value
 * @returns {*} The expanded string, or `value` unchanged when not a string.
 */
export function expandEnvVars(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([^}]+)\}/g, (_m, name) => process.env[name] || '');
}

/**
 * Decrypt / expand one stored secret. Supports: encrypted (`ENC[...]`) →
 * decrypted, `${ENV}` placeholder → expanded, plaintext → as-is, absent →
 * empty string.
 *
 * @param {*} raw
 * @returns {string}
 */
function readSecret(raw) {
  if (!raw || typeof raw !== 'string') return '';
  if (tokenStorageService.isEncrypted(raw)) {
    try {
      return tokenStorageService.decryptString(raw);
    } catch {
      return '';
    }
  }
  if (raw.includes('${')) return expandEnvVars(raw);
  return raw;
}

/**
 * The environment variable name `getApiKeyForModel()` derives for a model id,
 * kept identical so an operator only has to learn one convention.
 *
 * @param {string} modelId
 * @returns {string}
 */
function modelEnvVarName(modelId) {
  return `${String(modelId).toUpperCase().replace(/-/g, '_')}_API_KEY`;
}

/**
 * Read one environment variable. `config` is the validated snapshot taken at
 * import time (and the convention the rest of the server follows);
 * `process.env` is consulted after it so a variable set later in the process
 * still resolves.
 *
 * @param {string} name
 * @returns {string}
 */
function readEnv(name) {
  return config[name] || process.env[name] || '';
}

/**
 * Resolve the API key for a transcription model, in priority order:
 *   1. `model.apiKey` (encrypted, `${ENV}` placeholder, or plaintext)
 *   2. the `providers.json` entry for `credentialProvider` (so a Gemini
 *      transcription model reuses the key already stored for `google`)
 *   3. `<MODEL_ID>_API_KEY` from the environment
 *   4. the provider-wide environment variables in `envVars`, in order
 *
 * @param {Object} model - Transcription model config as stored in cache.
 * @param {{ credentialProvider?: string, envVars?: string[] }} [opts]
 * @returns {string} The key, or '' when none is configured.
 */
export function resolveApiKey(model, { credentialProvider, envVars = [] } = {}) {
  const fromModel = readSecret(model?.apiKey);
  if (fromModel) return fromModel;

  if (credentialProvider) {
    try {
      const { data: providers = [] } = configCache.getProviders(true);
      const entry = providers.find(p => p?.id === credentialProvider);
      const fromProvider = readSecret(entry?.apiKey);
      if (fromProvider) return fromProvider;
    } catch {
      // No providers config yet — fall through to the environment.
    }
  }

  if (model?.id) {
    const fromModelEnv = readEnv(modelEnvVarName(model.id));
    if (fromModelEnv) return fromModelEnv;
  }

  for (const name of envVars) {
    const fromEnv = readEnv(name);
    if (fromEnv) return fromEnv;
  }
  return '';
}

export default { expandEnvVars, resolveApiKey };
