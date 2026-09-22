/**
 * Brave Search API key resolution.
 *
 * Extracted from `BraveSearchProvider` because two callers need it and they sit
 * on opposite sides of an import cycle: the provider, to authenticate a search,
 * and `toolLoader`, to decide whether `websearch.provider: "auto"` should offer
 * Brave or fall back to the keyless Qwant. Importing `WebSearchService` into
 * `toolLoader` for that one question closes the loop
 * `configCache → toolLoader → WebSearchService → qwantProvider →
 * requestThrottler → configCache`, and `WebSearchService` builds its singleton
 * at module scope, so whichever module is entered first hits a
 * temporal-dead-zone ReferenceError. This module holds functions only — no
 * module-scope work — so it is safe on either side.
 *
 * @module services/search/braveApiKey
 */
import config from '../../config.js';
import configCache from '../../configCache.js';
import tokenStorageService from '../TokenStorageService.js';
import logger from '../../utils/logger.js';

/**
 * Resolve the Brave Search API key, in order:
 * 1. the provider-level key from `providers.json` (decrypted)
 * 2. the `BRAVE_SEARCH_API_KEY` environment variable
 *
 * @returns {string|undefined} The key, or undefined when none is configured
 */
export function getBraveApiKey() {
  try {
    const { data: providers } = configCache.getProviders(true);
    const braveProvider = providers.find(p => p.id === 'brave');

    if (braveProvider?.apiKey) {
      try {
        return tokenStorageService.decryptString(braveProvider.apiKey);
      } catch (error) {
        logger.error('Failed to decrypt Brave provider API key', {
          component: 'WebSearch',
          error
        });
        // Fall through to environment variable
      }
    }
  } catch (error) {
    logger.error('Failed to load Brave provider configuration', {
      component: 'WebSearch',
      error
    });
    // Fall through to environment variable
  }

  // Fallback to environment variable
  return config.BRAVE_SEARCH_API_KEY;
}

/**
 * Whether Brave Search can run a query right now.
 * @returns {boolean}
 */
export function isBraveSearchConfigured() {
  return Boolean(getBraveApiKey());
}
