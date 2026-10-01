/**
 * Server side of the LLM provider rules in `shared/llmProviders.js`: reading a
 * provider entry's API key. The pure rules are re-exported so server code has
 * one import for both.
 */

import config from '../config.js';
import tokenStorageService from './TokenStorageService.js';
import { providerEnvKeyName } from '../../shared/llmProviders.js';

export {
  BUILT_IN_LLM_PROVIDERS,
  CUSTOM_PROVIDER_API_TYPES,
  isCustomLlmProvider,
  getProviderApiType,
  getModelProviderId,
  getLinkedModels,
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
