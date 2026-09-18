/**
 * Base class for web search providers.
 *
 * Lives in its own module (rather than in `WebSearchService.js`) so a concrete
 * provider can extend it without importing the service that registers it —
 * the import cycle that would otherwise force every provider into one file.
 *
 * `WebSearchService` re-exports this class, so existing
 * `import { SearchProvider } from '../services/WebSearchService.js'` keeps working.
 *
 * @module services/search/SearchProvider
 */
class SearchProvider {
  /**
   * Execute a search query.
   * @param {string} query - The search query
   * @param {Object} [options] - Provider options ({ chatId, language, count, ... })
   * @returns {Promise<{results: Array<{title: string, url: string, description: string}>}>}
   */
  // eslint-disable-next-line no-unused-vars
  async search(query, options = {}) {
    throw new Error('search() method must be implemented');
  }

  /**
   * Get the provider name (the id used in `websearch.provider` and by
   * `WebSearchService.search(query, { provider })`).
   * @returns {string} Provider name
   */
  getName() {
    throw new Error('getName() method must be implemented');
  }

  /**
   * Whether the provider can run a search right now. Providers that need
   * credentials override this; keyless providers are always ready.
   *
   * Used to pick a usable provider for `websearch.provider: "auto"` instead of
   * offering the model a tool whose every call will fail on a missing key.
   * @returns {boolean}
   */
  isConfigured() {
    return true;
  }
}

export { SearchProvider };
export default SearchProvider;
