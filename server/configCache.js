import { loadJson, loadBuiltinLocaleJson } from './configLoader.js';
import { loadAllApps } from './appsLoader.js';
import { loadAllModels } from './modelsLoader.js';
import { loadAllPrompts } from './promptsLoader.js';
import { createHash } from 'crypto';

function expandToolFunctions(tools = []) {
  const expanded = [];
  for (const tool of tools) {
    if (tool.functions && typeof tool.functions === 'object') {
      for (const [fn, cfg] of Object.entries(tool.functions)) {
        expanded.push({
          ...tool,
          id: `${tool.id}.${fn}`,
          name: cfg.name || `${tool.name} ${fn}`,
          description: cfg.description || tool.description,
          parameters: cfg.parameters || {},
          method: fn
        });
      }
    } else {
      expanded.push(tool);
    }
  }
  return expanded;
}

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
      'config/ui.json'
    ];

    // Built-in locales that should always be preloaded
    this.defaultLocales = ['en', 'de'];
  }

  /**
   * Initialize the cache by preloading all critical configuration files
   * Should be called at server startup
   */
  async initialize() {
    console.log('🚀 Initializing configuration cache...');
    
    const loadPromises = this.criticalConfigs.map(async (configPath) => {
      try {
        // Special handling for apps.json - load from both sources
        if (configPath === 'config/apps.json') {
          // Load enabled apps only
          const enabledApps = await loadAllApps(false);
          this.setCacheEntry(configPath, enabledApps);
          console.log(`✓ Cached: ${configPath} (${enabledApps.length} enabled apps)`);
          
          // Also load and cache all apps (including disabled)
          const allApps = await loadAllApps(true);
          this.setCacheEntry('config/apps-all.json', allApps);
          console.log(`✓ Cached: config/apps-all.json (${allApps.length} total apps)`);
          return;
        }
        
        // Special handling for models.json - load from both sources
        if (configPath === 'config/models.json') {
          // Load enabled models only
          const enabledModels = await loadAllModels(false);
          this.setCacheEntry(configPath, enabledModels);
          console.log(`✓ Cached: ${configPath} (${enabledModels.length} enabled models)`);
          
          // Also load and cache all models (including disabled)
          const allModels = await loadAllModels(true);
          this.setCacheEntry('config/models-all.json', allModels);
          console.log(`✓ Cached: config/models-all.json (${allModels.length} total models)`);
          return;
        }
        
        // Special handling for prompts.json - load from both sources
        if (configPath === 'config/prompts.json') {
          // Load enabled prompts only
          const enabledPrompts = await loadAllPrompts(false);
          this.setCacheEntry(configPath, enabledPrompts);
          console.log(`✓ Cached: ${configPath} (${enabledPrompts.length} enabled prompts)`);
          
          // Also load and cache all prompts (including disabled)
          const allPrompts = await loadAllPrompts(true);
          this.setCacheEntry('config/prompts-all.json', allPrompts);
          console.log(`✓ Cached: config/prompts-all.json (${allPrompts.length} total prompts)`);
          return;
        }
        
        const data = await loadJson(configPath);
        if (data !== null) {
          // Expand tool functions into individual entries
          const finalData =
            configPath === 'config/tools.json' ? expandToolFunctions(data) : data;
          this.setCacheEntry(configPath, finalData);
          console.log(`✓ Cached: ${configPath}`);
        } else {
          console.warn(`⚠️  Failed to load: ${configPath}`);
        }
      } catch (error) {
        console.error(`❌ Error caching ${configPath}:`, error.message);
      }
    });

    const localePromises = this.defaultLocales.map((lang) => this.loadAndCacheLocale(lang));

    await Promise.all([...loadPromises, ...localePromises]);
    this.isInitialized = true;
    console.log(`✅ Configuration cache initialized with ${this.cache.size} files`);
  }

  /**
   * Generate ETag for data
   */
  generateETag(data) {
    const hash = createHash('md5');
    hash.update(JSON.stringify(data));
    return `"${hash.digest('hex')}"`;
  }

  mergeLocaleData(base = {}, overrides = {}, path = '') {
    const result = { ...base };
    if (typeof overrides !== 'object' || overrides === null) return result;
    for (const [key, value] of Object.entries(overrides)) {
      if (!(key in base)) {
        console.warn(`Unknown locale key '${path + key}' in overrides`);
        continue;
      }
      if (typeof value === 'object' && value !== null && typeof base[key] === 'object') {
        result[key] = this.mergeLocaleData(base[key], value, `${path + key}.`);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * Set a cache entry with automatic refresh timer
   */
  setCacheEntry(key, data) {
    // Clear existing timer if any
    if (this.refreshTimers.has(key)) {
      clearTimeout(this.refreshTimers.get(key));
    }

    // Generate ETag for the data
    const etag = this.generateETag(data);

    // Set cache entry
    this.cache.set(key, {
      data,
      etag,
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
      // Special handling for apps.json - load from both sources
      if (key === 'config/apps.json') {
        // Refresh enabled apps cache
        const enabledApps = await loadAllApps(false);
        this.setCacheEntry(key, enabledApps);
        
        // Also refresh all apps cache
        const allApps = await loadAllApps(true);
        this.setCacheEntry('config/apps-all.json', allApps);
        return;
      }
      
      // Special handling for apps-all.json
      if (key === 'config/apps-all.json') {
        const allApps = await loadAllApps(true);
        this.setCacheEntry(key, allApps);
        
        // Also refresh enabled apps cache
        const enabledApps = await loadAllApps(false);
        this.setCacheEntry('config/apps.json', enabledApps);
        return;
      }
      
      if (key.startsWith('locales/')) {
        const lang = key.split('/')[1].replace('.json', '');
        await this.loadAndCacheLocale(lang);
        return;
      }

      const data = await loadJson(key, { useCache: false });
      if (data !== null) {
        const finalData =
          key === 'config/tools.json' ? expandToolFunctions(data) : data;
        this.setCacheEntry(key, finalData);
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
   * Get ETag for a cache entry
   */
  getETag(configPath) {
    const entry = this.cache.get(configPath);
    return entry ? entry.etag : null;
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
  getModels(includeDisabled = false) {
    if (includeDisabled) {
      // Check cache for all models (including disabled)
      const cachedAllModels = this.get('config/models-all.json');
      if (cachedAllModels !== null) {
        return cachedAllModels;
      }
      // Data not in cache - return empty array as fallback
      console.warn('Models cache not initialized - returning empty array');
      return [];
    }
    return this.get('config/models.json');
  }

  /**
   * Get apps configuration
   */
  getApps(includeDisabled = false) {
    if (includeDisabled) {
      // Check cache for all apps (including disabled)
      const cachedAllApps = this.get('config/apps-all.json');
      if (cachedAllApps !== null) {
        return cachedAllApps;
      }
      // Data not in cache - return empty array as fallback
      console.warn('Apps cache not initialized - returning empty array');
      return [];
    }
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
  getPrompts(includeDisabled = false) {
    if (includeDisabled) {
      // Check cache for all prompts (including disabled)
      const cachedAllPrompts = this.get('config/prompts-all.json');
      if (cachedAllPrompts !== null) {
        return cachedAllPrompts;
      }
      // Data not in cache - return empty array as fallback
      console.warn('Prompts cache not initialized - returning empty array');
      return [];
    }
    return this.get('config/prompts.json');
  }

  /**
   * Get prompts with ETag information
   */
  getPromptsWithETag(includeDisabled = false) {
    const cacheKey = includeDisabled ? 'config/prompts-all.json' : 'config/prompts.json';
    const data = this.get(cacheKey);
    const etag = this.getETag(cacheKey);
    
    if (data === null && includeDisabled) {
      // Data not in cache - return empty array as fallback
      console.warn('Prompts cache not initialized for ETag - returning empty array');
      return {
        data: [],
        etag: null
      };
    }
    
    return {
      data,
      etag
    };
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

  async loadAndCacheLocale(language) {
    try {
      const base = await loadBuiltinLocaleJson(`${language}.json`);
      if (!base) {
        console.warn(`⚠️  Failed to load builtin locale for ${language}`);
        return;
      }
      const overrides = await loadJson(`locales/${language}.json`) || {};
      const merged = this.mergeLocaleData(base, overrides);
      this.setCacheEntry(`locales/${language}.json`, merged);
      console.log(`✓ Cached locale: ${language}`);
    } catch (error) {
      console.error(`❌ Error caching locale ${language}:`, error.message);
    }
  }

  /**
   * Refresh models cache (both enabled and all models)
   * Should be called when models are modified (create, update, delete, toggle)
   */
  async refreshModelsCache() {
    console.log('🔄 Refreshing models cache...');
    
    try {
      // Refresh enabled models cache
      const enabledModels = await loadAllModels(false);
      this.setCacheEntry('config/models.json', enabledModels);
      
      // Refresh all models cache
      const allModels = await loadAllModels(true);
      this.setCacheEntry('config/models-all.json', allModels);
      
      console.log(`✅ Models cache refreshed: ${enabledModels.length} enabled, ${allModels.length} total`);
    } catch (error) {
      console.error('❌ Error refreshing models cache:', error.message);
    }
  }

  /**
   * Refresh apps cache (both enabled and all apps)
   * Should be called when apps are modified (create, update, delete, toggle)
   */
  async refreshAppsCache() {
    console.log('🔄 Refreshing apps cache...');
    
    try {
      // Refresh enabled apps cache
      const enabledApps = await loadAllApps(false);
      this.setCacheEntry('config/apps.json', enabledApps);
      
      // Refresh all apps cache
      const allApps = await loadAllApps(true);
      this.setCacheEntry('config/apps-all.json', allApps);
      
      console.log(`✅ Apps cache refreshed: ${enabledApps.length} enabled, ${allApps.length} total`);
    } catch (error) {
      console.error('❌ Error refreshing apps cache:', error.message);
    }
  }

  /**
   * Refresh prompts cache (both enabled and all prompts)
   * Should be called when prompts are modified (create, update, delete, toggle)
   */
  async refreshPromptsCache() {
    console.log('🔄 Refreshing prompts cache...');
    
    try {
      // Refresh enabled prompts cache
      const enabledPrompts = await loadAllPrompts(false);
      this.setCacheEntry('config/prompts.json', enabledPrompts);
      
      // Refresh all prompts cache
      const allPrompts = await loadAllPrompts(true);
      this.setCacheEntry('config/prompts-all.json', allPrompts);
      
      console.log(`✅ Prompts cache refreshed: ${enabledPrompts.length} enabled, ${allPrompts.length} total`);
    } catch (error) {
      console.error('❌ Error refreshing prompts cache:', error.message);
    }
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
