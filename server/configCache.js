import { loadJson, loadText } from './configLoader.js';

/**
 * Configuration Cache Service
 * 
 * This service provides memory-based caching for frequently accessed configuration files
 * to eliminate the performance bottleneck of reading from disk on every API request.
 * 
 * Features:
 * - Preloads critical configuration files at startup
 * - Provides synchronous access to cached data
 * - Automatic cache refresh with configurable TTL
 * - Fallback to file loading if cache miss occurs
 */

class ConfigCache {
  constructor() {
    this.cache = new Map();
    this.refreshTimers = new Map();
    this.isInitialized = false;
    
    // Cache TTL in milliseconds (default: 5 minutes for production, shorter for development)
    this.cacheTTL = process.env.NODE_ENV === 'production' ? 5 * 60 * 1000 : 60 * 1000;
    
    // List of critical configuration files to preload
    this.criticalConfigs = [
      'config/models.json',
      'config/apps.json', 
      'config/tools.json',
      'config/styles.json',
      'config/prompts.json',
      'config/platform.json',
      'config/ui.json',
      'locales/en.json',
      'locales/de.json'
    ];
  }

  /**
   * Initialize the cache by preloading all critical configuration files
   * Should be called at server startup
   */
  async initialize() {
    console.log('🚀 Initializing configuration cache...');
    
    const loadPromises = this.criticalConfigs.map(async (configPath) => {
      try {
        const data = await loadJson(configPath);
        if (data !== null) {
          this.setCacheEntry(configPath, data);
          console.log(`✓ Cached: ${configPath}`);
        } else {
          console.warn(`⚠️  Failed to load: ${configPath}`);
        }
      } catch (error) {
        console.error(`❌ Error caching ${configPath}:`, error.message);
      }
    });

    await Promise.all(loadPromises);
    this.isInitialized = true;
    console.log(`✅ Configuration cache initialized with ${this.cache.size} files`);
  }

  /**
   * Set a cache entry with automatic refresh timer
   */
  setCacheEntry(key, data) {
    // Clear existing timer if any
    if (this.refreshTimers.has(key)) {
      clearTimeout(this.refreshTimers.get(key));
    }

    // Set cache entry
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });

    // Set refresh timer
    const refreshTimer = setTimeout(() => {
      this.refreshCacheEntry(key);
    }, this.cacheTTL);
    
    this.refreshTimers.set(key, refreshTimer);
  }

  /**
   * Refresh a single cache entry
   */
  async refreshCacheEntry(key) {
    try {
      const data = await loadJson(key, { useCache: false });
      if (data !== null) {
        this.setCacheEntry(key, data);
      }
    } catch (error) {
      console.error(`Error refreshing cache for ${key}:`, error.message);
      // Keep the old data in cache on refresh failure
    }
  }

  /**
   * Get configuration data from cache (synchronous)
   * Returns null if not found in cache
   */
  get(configPath) {
    const entry = this.cache.get(configPath);
    if (!entry) {
      return null;
    }

    // Check if entry is still valid (extra safety check)
    const age = Date.now() - entry.timestamp;
    if (age > this.cacheTTL * 2) { // Allow 2x TTL grace period
      console.warn(`Cache entry for ${configPath} is stale (${Math.round(age/1000)}s old)`);
    }

    return entry.data;
  }

  /**
   * Get configuration data with fallback to file loading
   * This maintains backward compatibility while providing performance benefits
   */
  async getWithFallback(configPath) {
    // Try cache first
    const cached = this.get(configPath);
    if (cached !== null) {
      return cached;
    }

    // Fallback to file loading
    console.warn(`Cache miss for ${configPath}, loading from file`);
    const data = await loadJson(configPath);
    
    // Cache the result for future use
    if (data !== null) {
      this.setCacheEntry(configPath, data);
    }
    
    return data;
  }

  /**
   * Get models configuration (most frequently accessed)
   */
  getModels() {
    return this.get('config/models.json');
  }

  /**
   * Get apps configuration
   */
  getApps() {
    return this.get('config/apps.json');
  }

  /**
   * Get tools configuration
   */
  getTools() {
    return this.get('config/tools.json');
  }

  /**
   * Get styles configuration
   */
  getStyles() {
    return this.get('config/styles.json');
  }

  /**
   * Get prompts configuration
   */
  getPrompts() {
    return this.get('config/prompts.json');
  }

  /**
   * Get platform configuration
   */
  getPlatform() {
    return this.get('config/platform.json');
  }

  /**
   * Get UI configuration
   */
  getUI() {
    return this.get('config/ui.json');
  }

  /**
   * Get localization data for a specific language
   */
  getLocalizations(language = 'en') {
    return this.get(`locales/${language}.json`);
  }

  /**
   * Invalidate and refresh all cached entries
   */
  async refreshAll() {
    console.log('🔄 Refreshing all cached configurations...');
    
    const refreshPromises = Array.from(this.cache.keys()).map(async (configPath) => {
      await this.refreshCacheEntry(configPath);
    });

    await Promise.all(refreshPromises);
    console.log('✅ All configurations refreshed');
  }

  /**
   * Clear all cache entries and timers
   */
  clear() {
    // Clear all refresh timers
    for (const timer of this.refreshTimers.values()) {
      clearTimeout(timer);
    }
    
    this.refreshTimers.clear();
    this.cache.clear();
    this.isInitialized = false;
    console.log('🧹 Configuration cache cleared');
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const stats = {
      isInitialized: this.isInitialized,
      totalEntries: this.cache.size,
      cacheTTL: this.cacheTTL,
      entries: {}
    };

    for (const [key, entry] of this.cache.entries()) {
      stats.entries[key] = {
        age: Date.now() - entry.timestamp,
        sizeApprox: JSON.stringify(entry.data).length
      };
    }

    return stats;
  }
}

// Create singleton instance
const configCache = new ConfigCache();

export default configCache;
