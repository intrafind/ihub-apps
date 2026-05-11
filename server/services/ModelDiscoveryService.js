/**
 * Model Discovery Service
 *
 * Automatically discovers available models from OpenAI-compatible endpoints.
 * Used primarily for local LLM providers (vLLM, LM Studio, Jan.ai) where the
 * active model can change dynamically.
 *
 * Features:
 * - Discovers models via /v1/models endpoint
 * - Caches discovery results to minimize API calls
 * - Configurable cache TTL per model
 * - Falls back to configured modelId if discovery fails
 */

import logger from '../utils/logger.js';
import { throttledFetch } from '../requestThrottler.js';

class ModelDiscoveryService {
  constructor() {
    /**
     * Cache structure: Map<modelConfigId, {modelId: string, timestamp: number}>
     * @type {Map<string, {modelId: string, timestamp: number}>}
     */
    this.cache = new Map();

    /**
     * Default cache TTL: 5 minutes (300,000 ms)
     * Prevents excessive API calls while allowing timely model updates
     */
    this.DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

    /**
     * Track ongoing discovery requests to prevent duplicate simultaneous calls
     * @type {Map<string, Promise>}
     */
    this.pendingRequests = new Map();
  }

  /**
   * Discover available models from an OpenAI-compatible endpoint
   * @param {Object} model - Model configuration object
   * @param {string} apiKey - API key for authentication (may be placeholder for local)
   * @param {number} cacheTtlMs - Cache TTL in milliseconds (default: 5 minutes)
   * @returns {Promise<string|null>} - Discovered model ID or null if discovery fails
   */
  async discoverModel(model, apiKey, cacheTtlMs = this.DEFAULT_CACHE_TTL_MS) {
    // Return cached result if still valid
    const cached = this.cache.get(model.id);
    if (cached && Date.now() - cached.timestamp < cacheTtlMs) {
      logger.debug('Using cached model discovery result', {
        component: 'ModelDiscoveryService',
        modelConfigId: model.id,
        discoveredModelId: cached.modelId,
        cacheAge: Math.floor((Date.now() - cached.timestamp) / 1000) + 's'
      });
      return cached.modelId;
    }

    // Check if there's already a pending request for this model
    if (this.pendingRequests.has(model.id)) {
      logger.debug('Waiting for pending model discovery request', {
        component: 'ModelDiscoveryService',
        modelConfigId: model.id
      });
      return await this.pendingRequests.get(model.id);
    }

    // Create and track the discovery request
    const discoveryPromise = this._performDiscovery(model, apiKey, cacheTtlMs);
    this.pendingRequests.set(model.id, discoveryPromise);

    try {
      const result = await discoveryPromise;
      return result;
    } finally {
      // Clean up pending request tracking
      this.pendingRequests.delete(model.id);
    }
  }

  /**
   * Internal method to perform the actual model discovery
   * @private
   */
  async _performDiscovery(model, apiKey, cacheTtlMs) {
    if (!model.url) {
      logger.warn('Cannot discover model: no URL configured', {
        component: 'ModelDiscoveryService',
        modelConfigId: model.id
      });
      return null;
    }

    try {
      // Construct /v1/models endpoint URL from chat completions URL
      const modelsUrl = this._getModelsEndpoint(model.url);

      logger.info('Discovering available models', {
        component: 'ModelDiscoveryService',
        modelConfigId: model.id,
        url: modelsUrl,
        provider: model.provider
      });

      const headers = {
        'Content-Type': 'application/json'
      };

      // Add Authorization header if API key is provided and not a placeholder
      if (apiKey && apiKey !== 'sk-no-key-required') {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const response = await throttledFetch(model.id, modelsUrl, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(10000) // 10 second timeout for discovery
      });

      if (!response.ok) {
        logger.warn('Model discovery failed with HTTP error', {
          component: 'ModelDiscoveryService',
          modelConfigId: model.id,
          status: response.status,
          statusText: response.statusText
        });
        return null;
      }

      const data = await response.json();

      // OpenAI-compatible response format: { data: [{id: "model-name", ...}], object: "list" }
      if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
        logger.warn('No models found in discovery response', {
          component: 'ModelDiscoveryService',
          modelConfigId: model.id,
          responseKeys: Object.keys(data)
        });
        return null;
      }

      // Get the first available model (vLLM typically serves one model at a time)
      const discoveredModel = data.data[0];
      const discoveredModelId = discoveredModel.id;

      logger.info('Successfully discovered model', {
        component: 'ModelDiscoveryService',
        modelConfigId: model.id,
        discoveredModelId,
        totalModelsAvailable: data.data.length
      });

      // Cache the result
      this.cache.set(model.id, {
        modelId: discoveredModelId,
        timestamp: Date.now()
      });

      return discoveredModelId;
    } catch (error) {
      logger.warn('Model discovery failed with exception', {
        component: 'ModelDiscoveryService',
        modelConfigId: model.id,
        error: error.message,
        errorCode: error.code
      });
      return null;
    }
  }

  /**
   * Construct /v1/models endpoint URL from chat completions URL
   * @param {string} chatUrl - URL to /v1/chat/completions endpoint
   * @returns {string} URL to /v1/models endpoint
   * @private
   */
  _getModelsEndpoint(chatUrl) {
    // Handle both /v1/chat/completions and /v1/responses endpoints
    return chatUrl
      .replace('/v1/chat/completions', '/v1/models')
      .replace('/v1/responses', '/v1/models');
  }

  /**
   * Get the effective model ID, using discovery if enabled
   * @param {Object} model - Model configuration object
   * @param {string} apiKey - API key for authentication
   * @returns {Promise<string>} - Model ID to use for the request
   */
  async getEffectiveModelId(model, apiKey) {
    // Skip discovery if not enabled or not supported for this provider
    if (!model.autoDiscovery || !this._supportsDiscovery(model)) {
      return model.modelId;
    }

    const discoveredModelId = await this.discoverModel(model, apiKey);

    // Fall back to configured modelId if discovery fails
    if (!discoveredModelId) {
      logger.debug('Using configured modelId (discovery unavailable)', {
        component: 'ModelDiscoveryService',
        modelConfigId: model.id,
        modelId: model.modelId
      });
      return model.modelId;
    }

    // Log if discovered model differs from configured model
    if (discoveredModelId !== model.modelId) {
      logger.info('Using discovered model (differs from config)', {
        component: 'ModelDiscoveryService',
        modelConfigId: model.id,
        configuredModelId: model.modelId,
        discoveredModelId
      });
    }

    return discoveredModelId;
  }

  /**
   * Check if model discovery is supported for this provider
   * @param {Object} model - Model configuration object
   * @returns {boolean}
   * @private
   */
  _supportsDiscovery(model) {
    // Only OpenAI-compatible providers support /v1/models endpoint
    // This includes: openai, local (vLLM, LM Studio, Jan.ai)
    return model.provider === 'openai' || model.provider === 'local';
  }

  /**
   * Clear cache for a specific model or all models
   * @param {string|null} modelConfigId - Model config ID to clear, or null for all
   */
  clearCache(modelConfigId = null) {
    if (modelConfigId) {
      this.cache.delete(modelConfigId);
      logger.debug('Cleared model discovery cache', {
        component: 'ModelDiscoveryService',
        modelConfigId
      });
    } else {
      this.cache.clear();
      logger.debug('Cleared all model discovery cache', {
        component: 'ModelDiscoveryService'
      });
    }
  }

  /**
   * Get cache statistics for monitoring/debugging
   * @returns {Object}
   */
  getCacheStats() {
    const stats = {
      totalEntries: this.cache.size,
      entries: []
    };

    for (const [modelConfigId, entry] of this.cache.entries()) {
      stats.entries.push({
        modelConfigId,
        discoveredModelId: entry.modelId,
        ageSeconds: Math.floor((Date.now() - entry.timestamp) / 1000)
      });
    }

    return stats;
  }
}

// Export singleton instance
const modelDiscoveryService = new ModelDiscoveryService();
export default modelDiscoveryService;
