// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Base Source Handler Interface
 *
 * This abstract class defines the interface that all source handlers must implement.
 * Source handlers are responsible for loading content from various sources (URLs,
 * APIs, databases, etc.) and providing caching capabilities.
 */

import { BoundedSourceCache } from './boundedSourceCache.js';
import { SOURCE_CACHE_MAX_ENTRIES, sourceCacheBytes } from '../utils/cacheBudgets.js';

class SourceHandler {
  constructor(config = {}) {
    this.config = config;
    // Bounded by count and estimated bytes, oldest out first: a plain Map
    // only dropped an entry when its key was asked for again after the TTL.
    this.cache = new BoundedSourceCache({
      maxEntries: SOURCE_CACHE_MAX_ENTRIES,
      maxBytes: sourceCacheBytes()
    });
    this.cacheConfig = config.caching || { ttl: 3600, strategy: 'static' };
  }

  /**
   * Load content from the source
   * @param {Object} sourceConfig - Configuration specific to this source
   * @returns {Promise<Object>} - { content: string, metadata: Object }
   */
  async loadContent() {
    throw new Error('loadContent must be implemented by subclass');
  }

  /**
   * Get cached content or load fresh if needed
   * @param {Object} sourceConfig - Configuration specific to this source
   * @returns {Promise<Object>} - { content: string, metadata: Object }
   */
  async getCachedContent(sourceConfig) {
    const cacheKey = this.getCacheKey(sourceConfig);
    const cached = this.cache.get(cacheKey);

    // A caller that names its own lifetime (a project item's refresh TTL)
    // judges the entry by it, not by whoever cached the URL first.
    const callerTtlSeconds = Number(sourceConfig?.cacheTtlSeconds);
    const entry =
      cached && Number.isFinite(callerTtlSeconds) && callerTtlSeconds > 0
        ? { ...cached, ttl: Math.min(cached.ttl, callerTtlSeconds * 1000) }
        : cached;
    if (entry && this.isCacheValid(entry)) {
      return cached.data;
    }

    // Load fresh content
    const data = await this.loadContent(sourceConfig);

    // Cache the result, for the caller's lifetime when it names one (a
    // project item's refresh TTL, #3536), else the handler's.
    const ttlSeconds = Number(sourceConfig?.cacheTtlSeconds);
    this.cache.set(cacheKey, {
      data,
      timestamp: Date.now(),
      ttl:
        (Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : this.cacheConfig.ttl) * 1000
    });

    return data;
  }

  /**
   * Generate cache key for the source configuration
   * @param {Object} sourceConfig - Configuration specific to this source
   * @returns {string} - Cache key
   */
  getCacheKey(sourceConfig) {
    return JSON.stringify(sourceConfig);
  }

  /**
   * Check if cached entry is still valid
   * @param {Object} cached - Cached entry
   * @returns {boolean} - True if cache is valid
   */
  isCacheValid(cached) {
    const now = Date.now();
    const age = now - cached.timestamp;
    return age < cached.ttl;
  }

  /**
   * Clear cache for specific source or all cache
   * @param {Object} sourceConfig - Optional specific source config
   */
  clearCache(sourceConfig = null) {
    if (sourceConfig) {
      const cacheKey = this.getCacheKey(sourceConfig);
      this.cache.delete(cacheKey);
    } else {
      this.cache.clear();
    }
  }

  /**
   * Get handler type identifier
   * @returns {string} - Handler type
   */
  getType() {
    return 'base';
  }

  /**
   * Validate source configuration
   * @param {Object} sourceConfig - Configuration to validate
   * @returns {boolean} - True if valid
   */
  validateConfig() {
    return true; // Override in subclasses
  }

  /**
   * Get cache statistics
   * @returns {Object} - Cache stats
   */
  getCacheStats() {
    const entries = Array.from(this.cache.values());
    const validEntries = entries.filter(entry => this.isCacheValid(entry));

    return {
      totalEntries: this.cache.size,
      validEntries: validEntries.length,
      expiredEntries: this.cache.size - validEntries.length,
      memoryUsage: this.estimateMemoryUsage()
    };
  }

  /**
   * Estimate memory usage of cache
   * @returns {number} - Estimated bytes
   */
  estimateMemoryUsage() {
    let size = 0;
    for (const [key, value] of this.cache.entries()) {
      size += key.length * 2; // Rough estimate for string key
      size += JSON.stringify(value).length * 2; // Rough estimate for value
    }
    return size;
  }
}

export default SourceHandler;
