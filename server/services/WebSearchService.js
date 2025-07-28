import { actionTracker } from '../actionTracker.js';
import config from '../config.js';
import { throttledFetch } from '../requestThrottler.js';

/**
 * Base Search Provider Interface
 * All search providers must implement this interface
 */
class SearchProvider {
  /**
   * Execute a search query
   * @param {string} query - The search query
   * @param {Object} options - Provider-specific options
   * @returns {Promise<Object>} Search results in standardized format
   */
  async search(query, options = {}) {
    throw new Error('search() method must be implemented');
  }

  /**
   * Get the provider name
   * @returns {string} Provider name
   */
  getName() {
    throw new Error('getName() method must be implemented');
  }
}

/**
 * Brave Search Provider
 */
class BraveSearchProvider extends SearchProvider {
  getName() {
    return 'brave';
  }

  async search(query, options = {}) {
    const { chatId } = options;
    const apiKey = config.BRAVE_SEARCH_API_KEY;
    
    if (!apiKey) {
      throw new Error('BRAVE_SEARCH_API_KEY is not set');
    }

    const endpoint = config.BRAVE_SEARCH_ENDPOINT || 'https://api.search.brave.com/res/v1/web/search';
    
    if (chatId) {
      actionTracker.trackAction(chatId, { action: 'search', query, provider: 'brave' });
    }

    const res = await throttledFetch(
      'braveSearch',
      `${endpoint}?q=${encodeURIComponent(query)}`,
      {
        headers: {
          'X-Subscription-Token': apiKey,
          Accept: 'application/json'
        }
      }
    );

    if (!res.ok) {
      throw new Error(`Brave search failed with status ${res.status}`);
    }

    const data = await res.json();
    const results = [];

    if (data.web && Array.isArray(data.web.results)) {
      for (const item of data.web.results) {
        results.push({
          title: item.title,
          url: item.url,
          description: item.description,
          language: item.language
        });
      }
    }

    return { results };
  }
}

/**
 * Tavily Search Provider
 */
class TavilySearchProvider extends SearchProvider {
  getName() {
    return 'tavily';
  }

  async search(query, options = {}) {
    const { chatId, search_depth = 'basic', max_results = 5 } = options;
    const apiKey = config.TAVILY_SEARCH_API_KEY;
    
    if (!apiKey) {
      throw new Error('TAVILY_SEARCH_API_KEY is not set');
    }

    const endpoint = config.TAVILY_ENDPOINT || 'https://api.tavily.com/search';
    
    if (chatId) {
      actionTracker.trackAction(chatId, { action: 'search', query, provider: 'tavily' });
    }

    const res = await throttledFetch('tavilySearch', endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth,
        max_results
      })
    });

    if (!res.ok) {
      throw new Error(`Tavily search failed with status ${res.status}`);
    }

    const data = await res.json();
    const results = [];

    if (Array.isArray(data.results)) {
      for (const item of data.results) {
        results.push({
          title: item.title,
          url: item.url,
          description: item.content,
          score: item.score
        });
      }
    }

    return { results };
  }
}

/**
 * Web Search Service
 * Unified interface for multiple search providers
 */
class WebSearchService {
  constructor() {
    this.providers = new Map();
    this.defaultProvider = null;
    
    // Register built-in providers
    this.registerProvider(new BraveSearchProvider());
    this.registerProvider(new TavilySearchProvider());
  }

  /**
   * Register a search provider
   * @param {SearchProvider} provider - The search provider instance
   */
  registerProvider(provider) {
    if (!(provider instanceof SearchProvider)) {
      throw new Error('Provider must extend SearchProvider class');
    }
    
    this.providers.set(provider.getName(), provider);
    
    // Set first registered provider as default
    if (!this.defaultProvider) {
      this.defaultProvider = provider.getName();
    }
  }

  /**
   * Get available provider names
   * @returns {Array<string>} Array of provider names
   */
  getAvailableProviders() {
    return Array.from(this.providers.keys());
  }

  /**
   * Set the default provider
   * @param {string} providerName - Name of the provider to set as default
   */
  setDefaultProvider(providerName) {
    if (!this.providers.has(providerName)) {
      throw new Error(`Provider '${providerName}' is not registered`);
    }
    this.defaultProvider = providerName;
  }

  /**
   * Perform a web search using the specified or default provider
   * @param {string} query - The search query
   * @param {Object} options - Search options
   * @param {string} options.provider - Provider to use (optional, uses default if not specified)
   * @returns {Promise<Object>} Search results
   */
  async search(query, options = {}) {
    if (!query) {
      throw new Error('Query parameter is required');
    }

    const providerName = options.provider || this.defaultProvider;
    const provider = this.providers.get(providerName);

    if (!provider) {
      throw new Error(`Provider '${providerName}' is not available`);
    }

    try {
      return await provider.search(query, options);
    } catch (error) {
      throw new Error(`Search failed with ${providerName}: ${error.message}`);
    }
  }
}

// Create singleton instance
const webSearchService = new WebSearchService();

export default webSearchService;
export { SearchProvider, BraveSearchProvider, TavilySearchProvider, WebSearchService };