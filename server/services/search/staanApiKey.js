/**
 * Staan Search API key resolution.
 *
 * Split out of the provider for the same reason as `braveApiKey.js`: two
 * callers need the key and they sit on opposite sides of an import cycle — the
 * provider, to authenticate a search, and `toolLoader`, to decide whether
 * `websearch.provider: "auto"` can offer Staan. Importing `WebSearchService`
 * into `toolLoader` closes the loop `configCache → toolLoader →
 * WebSearchService → staanProvider → requestThrottler → configCache`, and
 * `WebSearchService` builds its singleton at module scope, so whichever module
 * is entered first hits a temporal-dead-zone ReferenceError. This module holds
 * functions only — no module-scope work — so it is safe on either side.
 *
 * @module services/search/staanApiKey
 */
import config from '../../config.js';
import configCache from '../../configCache.js';
import tokenStorageService from '../TokenStorageService.js';
import logger from '../../utils/logger.js';

/**
 * Resolve the Staan Search API key, in order:
 * 1. the provider-level key from `providers.json` (decrypted)
 * 2. the `STAAN_API_KEY` environment variable
 *
 * @returns {string|undefined} The key, or undefined when none is configured
 */
export function getStaanApiKey() {
  try {
    const { data: providers } = configCache.getProviders(true);
    const staanProvider = providers.find(p => p.id === 'staan');

    if (staanProvider?.apiKey) {
      try {
        return tokenStorageService.decryptString(staanProvider.apiKey);
      } catch (error) {
        logger.error('Failed to decrypt Staan provider API key', {
          component: 'WebSearch',
          error
        });
        // Fall through to environment variable
      }
    }
  } catch (error) {
    logger.error('Failed to load Staan provider configuration', {
      component: 'WebSearch',
      error
    });
    // Fall through to environment variable
  }

  // Fallback to environment variable. STAAN_API_KEY reaches `config` through
  // the dynamic `*_API_KEY` pass-through in config.js, not a declared field.
  return config.STAAN_API_KEY;
}

/**
 * Whether Staan Search can run a query right now.
 * @returns {boolean}
 */
export function isStaanSearchConfigured() {
  return Boolean(getStaanApiKey());
}
