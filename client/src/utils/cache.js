/**
 * Advanced in-memory cache implementation with TTL (Time-To-Live) support.
 * Features:
 * - Key-based and pattern-based invalidation
 * - Memory usage limits
 * - Cache statistics
 * - Automated cleanup
 */
class Cache {
  constructor(options = {}) {
    this.store = new Map();
    this.maxSize = options.maxSize || 200; // Max number of items
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      cleanups: 0
    };
    this.persistenceEnabled = options.persistence === true;
    this.persistenceKey = options.persistenceKey || 'ai_hub_cache';
    this.storageType = options.storageType || 'session'; // 'session' or 'local'
    
    // Start cleanup interval (every 5 minutes)
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }
  
  /**
   * Get a value from the cache
   * @param {string} key - The cache key
   * @returns {*|null} The cached value or null if not found or expired
   */
  get(key) {
    if (!this.store.has(key)) {
      this.stats.misses++;
      return null;
    }
    
    const cachedItem = this.store.get(key);
    
    // Check if item has expired
    if (cachedItem.expiry && cachedItem.expiry < Date.now()) {
      this.delete(key);
      this.stats.misses++;
      return null;
    }
    
    // Update last accessed time and hit count
    cachedItem.lastAccessed = Date.now();
    cachedItem.hits++;
    this.stats.hits++;
    
    // Support both old format (direct value) and new format (with data/etag)
    if (cachedItem.value && typeof cachedItem.value === 'object' && cachedItem.value.data !== undefined) {
      return cachedItem.value; // Return the whole object with data/etag
    }
    
    return cachedItem.value;
  }
  
  /**
   * Store a value in the cache with optional TTL
   * @param {string} key - The cache key
   * @param {*} value - The value to cache
   * @param {number} [ttl=null] - Time-to-live in milliseconds (null = no expiry)
   */
  set(key, value, ttl = null) {
    // Check if we need to make room for new items
    if (this.store.size >= this.maxSize && !this.store.has(key)) {
      this.evictLeastRecent();
    }
    
    const expiry = ttl ? Date.now() + ttl : null;
    
    this.store.set(key, {
      value,
      expiry,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      hits: 0
    });
    
    this.stats.sets++;

    // Persistent storage is disabled
    
    return value;
  }
  
  /**
   * Remove an item from the cache
   * @param {string} key - The cache key to delete
   */
  delete(key) {
    const result = this.store.delete(key);
    if (result) {
      this.stats.deletes++;
      // No persistent storage updates
    }
    return result;
  }
  
  /**
   * Clear the entire cache
   */
  clear() {
    const size = this.store.size;
    this.store.clear();
    this.stats.deletes += size;
    
    // Persistent storage disabled
  }
  
  /**
   * Clean up expired cache items
   */
  cleanup() {
    const now = Date.now();
    let count = 0;
    
    for (const [key, item] of this.store.entries()) {
      if (item.expiry && item.expiry < now) {
        this.store.delete(key);
        count++;
      }
    }
    
    if (count > 0) {
      this.stats.cleanups++;
      this.stats.deletes += count;
      
      // No persistent storage updates
    }
    
    return count;
  }
  
  /**
   * Evict least recently used items when cache is full
   * @private
   */
  evictLeastRecent() {
    if (this.store.size === 0) return;
    
    let oldest = null;
    let oldestKey = null;
    
    // Find the least recently accessed item
    for (const [key, item] of this.store.entries()) {
      if (oldest === null || item.lastAccessed < oldest) {
        oldest = item.lastAccessed;
        oldestKey = key;
      }
    }
    
    // Remove the oldest item
    if (oldestKey) {
      this.delete(oldestKey);
    }
  }
  
  /**
   * Get statistics about cache usage
   * @returns {Object} Cache statistics
   */
  getStats() {
    return {
      ...this.stats,
      size: this.store.size,
      hitRate: this.stats.hits / (this.stats.hits + this.stats.misses) || 0
    };
  }
  
  /**
   * Invalidate cache entries by pattern
   * @param {string|RegExp} pattern - String prefix or RegExp pattern to match keys
   * @returns {number} Number of invalidated entries
   */
  invalidateByPattern(pattern) {
    let count = 0;
    const isRegExp = pattern instanceof RegExp;
    
    for (const key of this.store.keys()) {
      if (
        (isRegExp && pattern.test(key)) || 
        (!isRegExp && key.startsWith(pattern))
      ) {
        this.delete(key);
        count++;
      }
    }
    
    // Update persistent storage if enabled and items were deleted
    if (this.persistenceEnabled && count > 0) {
      this.saveToStorage();
    }
    
    return count;
  }
  
  /**
   * Check if a key exists in the cache (without updating access time)
   * @param {string} key - The cache key
   * @returns {boolean} True if the key exists and is not expired
   */
  has(key) {
    if (!this.store.has(key)) {
      return false;
    }
    
    const cachedItem = this.store.get(key);
    
    // Check if item has expired
    if (cachedItem.expiry && cachedItem.expiry < Date.now()) {
      this.delete(key);
      return false;
    }
    
    return true;
  }
  
  /**
   * Get the number of items in the cache
   */
  get size() {
    return this.store.size;
  }
  
  /**
   * Get the storage object based on configuration
   * @private
   */
  getStorageObject() {
    return this.storageType === 'local' ? localStorage : sessionStorage;
  }

  /**
   * Save cache to storage
   * @private
   */
  saveToStorage() {
    // Persistence disabled - no-op
  }

  /**
   * Load cache from storage
   * @private
   */
  loadFromStorage() {
    // Persistence disabled - no-op
  }
  
  /**
   * Destroy the cache and clean up the cleanup interval
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.clear();
  }
}

// Default TTL values (in milliseconds)
export const DEFAULT_CACHE_TTL = {
  SHORT: 60 * 1000,               // 1 minute
  MEDIUM: 5 * 60 * 1000,          // 5 minutes
  LONG: 30 * 60 * 1000,           // 30 minutes
  VERY_LONG: 24 * 60 * 60 * 1000  // 24 hours
};

// Cache key definitions for consistency
export const CACHE_KEYS = {
  APPS_LIST: 'apps-list',
  APP_DETAILS: 'app-details',
  MODELS_LIST: 'models-list',
  MODEL_DETAILS: 'model-details',
  STYLES: 'styles',
  PROMPTS: 'prompts',
  UI_CONFIG: 'ui-config',
  PAGE_CONTENT: 'page-content',
  TRANSLATIONS: 'translations',
  PLATFORM_CONFIG: 'platform-config'
};

/**
 * Build a cache key with contextual parameters
 * @param {string} baseKey - The base key from CACHE_KEYS
 * @param {Object} params - Parameters to include in the key
 * @returns {string} - The constructed cache key
 */
export const buildCacheKey = (baseKey, params = {}) => {
  if (!params || Object.keys(params).length === 0) {
    return baseKey;
  }
  
  const paramsStr = Object.entries(params)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('&');
  
  return paramsStr ? `${baseKey}?${paramsStr}` : baseKey;
};

// Create a singleton cache instance without persistent storage
const cache = new Cache({
  persistence: false,
  persistenceKey: 'ai_hub_apps_cache',
  storageType: 'session'
});

// Add global access in development for debugging
if (import.meta.env.DEV) {
  window.appCache = cache;
}

export default cache;
