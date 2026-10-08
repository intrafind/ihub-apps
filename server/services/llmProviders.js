/**
 * Server side of the LLM provider rules in `shared/llmProviders.js`: reading a
 * provider entry's API key. The pure rules are re-exported so server code has
 * one import for both.
 */

import config from '../config.js';
import tokenStorageService from './TokenStorageService.js';
import { getProviderApiType, providerEnvKeyName } from '../../shared/llmProviders.js';

export {
  BUILT_IN_LLM_PROVIDERS,
  allowsMissingApiKey,
  CUSTOM_PROVIDER_API_TYPES,
  isCustomLlmProvider,
  getProviderApiType,
  getModelProviderId,
  getLinkedModels,
  isReservedProviderId,
  MODEL_API_TYPES,
  providerEnvKeyName
} from '../../shared/llmProviders.js';

/**
 * Decrypt the key stored on a provider entry. Plaintext keys (written by hand)
 * are returned as they are.
 *
 * @param {Object} provider - Provider entry
 * @returns {string|null}
 * @throws when the stored key cannot be decrypted
 */
export function decryptProviderApiKey(provider) {
  if (!provider?.apiKey) return null;
  return tokenStorageService.isEncrypted(provider.apiKey)
    ? tokenStorageService.decryptString(provider.apiKey)
    : provider.apiKey;
}

/**
 * The key a provider entry makes available: the stored one, else the
 * provider's environment variable (`OPENAI_API_KEY`, `LLMHUB_API_KEY`, …).
 *
 * @param {Object} provider - Provider entry
 * @returns {string|null}
 */
export function resolveProviderApiKey(provider) {
  return decryptProviderApiKey(provider) || config[providerEnvKeyName(provider?.id)] || null;
}

/**
 * Whether a provider entry's key can be used, and where it comes from — for
 * the admin UI, which has to tell "no key" from "a key the server cannot read"
 * (stored under an encryption key this server does not have). Never returns
 * the key itself.
 *
 * @param {Object} provider - Provider entry
 * @returns {{state: 'ok'|'keyless'|'undecryptable'|'missing', source: 'provider'|'env'|'none', envVar: string|null}}
 */
export function inspectProviderApiKey(provider) {
  const envVar = providerEnvKeyName(provider?.id);
  let unreadable = false;

  if (provider?.apiKey) {
    try {
      if (decryptProviderApiKey(provider)) return { state: 'ok', source: 'provider', envVar: null };
    } catch {
      unreadable = true;
    }
  }
  if (config[envVar]) return { state: 'ok', source: 'env', envVar };
  if (unreadable) return { state: 'undecryptable', source: 'provider', envVar: null };
  if (provider?.requiresApiKey === false || getProviderApiType(provider) === 'local') {
    return { state: 'keyless', source: 'none', envVar: null };
  }
  return { state: 'missing', source: 'none', envVar };
}
