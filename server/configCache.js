import { loadJson, loadBuiltinLocaleJson } from './configLoader.js';
import { loadAllApps } from './appsLoader.js';
import { loadAllModels } from './modelsLoader.js';
import { loadAllPrompts } from './promptsLoader.js';
import { resolveGroupInheritance } from './utils/authorization.js';
import { createHash } from 'crypto';

/**
 * Resolve environment variables in a string
 * Replaces ${VAR_NAME} with the value of process.env.VAR_NAME
 */
function resolveEnvVars(value) {
  if (typeof value !== 'string') return value;

  return value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      console.warn(`Environment variable ${varName} is not defined, keeping placeholder: ${match}`);
      return match;
    }
    return envValue;
  });
}

/**
 * Recursively resolve environment variables in an object
 */
function resolveEnvVarsInObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => resolveEnvVarsInObject(item));
  }

  const resolved = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      resolved[key] = resolveEnvVars(value);
    } else if (typeof value === 'object') {
      resolved[key] = resolveEnvVarsInObject(value);
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

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
    this.localeLoadingLocks = new Map();

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
      'config/groups.json',
      'config/users.json'
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

    const loadPromises = this.criticalConfigs.map(async configPath => {
      try {
        // Special handling for apps.json - load from both sources
        if (configPath === 'config/apps.json') {
          // Load all apps (including disabled) for admin access
          const allApps = await loadAllApps(true);
          this.setCacheEntry(configPath, allApps);
          console.log(`✓ Cached: ${configPath} (${allApps.length} total apps)`);
          return;
        }

        // Special handling for models.json - load from both sources
        if (configPath === 'config/models.json') {
          // Also load and cache all models (including disabled)
          const allModels = await loadAllModels(true);
          this.setCacheEntry('config/models.json', allModels);
          console.log(`✓ Cached: config/models.json (${allModels.length} total models)`);
          return;
        }

        // Special handling for prompts.json - load from both sources
        if (configPath === 'config/prompts.json') {
          // Load all prompts (including disabled) for admin access
          const allPrompts = await loadAllPrompts(true);
          this.setCacheEntry(configPath, allPrompts);
          console.log(`✓ Cached: ${configPath} (${allPrompts.length} total prompts)`);
          return;
        }

        // Special handling for groups.json - load and resolve inheritance
        if (configPath === 'config/groups.json') {
          const groupsConfig = await loadJson(configPath);
          if (groupsConfig !== null) {
            const resolvedConfig = resolveGroupInheritance(groupsConfig);
            this.setCacheEntry(configPath, resolvedConfig);
            console.log(
              `✓ Cached: ${configPath} (${Object.keys(resolvedConfig.groups || {}).length} groups with resolved inheritance)`
            );
          } else {
            console.warn(`⚠️  Failed to load: ${configPath}`);
          }
          return;
        }

        const data = await loadJson(configPath);
        if (data !== null) {
          // Expand tool functions into individual entries
          const finalData = configPath === 'config/tools.json' ? expandToolFunctions(data) : data;
          this.setCacheEntry(configPath, finalData);
          console.log(`✓ Cached: ${configPath}`);
        } else {
          console.warn(`⚠️  Failed to load: ${configPath}`);
        }
      } catch (error) {
        console.error(`❌ Error caching ${configPath}:`, error.message);
      }
    });

    const localePromises = this.defaultLocales.map(lang => this.loadAndCacheLocale(lang));

    try {
      await Promise.all([...loadPromises, ...localePromises]);

      // Validate that all default locales were loaded successfully
      const failedLocales = [];
      for (const lang of this.defaultLocales) {
        const locale = this.getLocalizations(lang);
        if (!locale) {
          failedLocales.push(lang);
        }
      }

      if (failedLocales.length > 0) {
        console.error(`❌ Failed to load default locales: ${failedLocales.join(', ')}`);
        // Don't fail startup, but log the issue
      }

      this.isInitialized = true;
      console.log(`✅ Configuration cache initialized with ${this.cache.size} files`);
    } catch (error) {
      console.error('❌ Error during cache initialization:', error);
      this.isInitialized = true; // Still mark as initialized to avoid blocking
      console.log(`⚠️  Configuration cache initialized with errors`);
    }
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

    // Resolve environment variables in the data
    const resolvedData = resolveEnvVarsInObject(data);

    // Generate ETag for the data
    const etag = this.generateETag(resolvedData);

    // Set cache entry
    this.cache.set(key, {
      data: resolvedData,
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
        const apps = await loadAllApps(true, false);
        const newEtag = this.generateETag(apps);
        const existing = this.cache.get(key);
        if (!existing || existing.etag !== newEtag) {
          this.setCacheEntry(key, apps);
          console.log(`✓ Cached: config/apps.json (${apps.length} total apps)`);
        }
        return;
      }

      // Special handling for models.json - load from both sources
      if (key === 'config/models.json') {
        const models = await loadAllModels(true, false);
        const newEtag = this.generateETag(models);
        const existing = this.cache.get(key);
        if (!existing || existing.etag !== newEtag) {
          this.setCacheEntry(key, models);
          console.log(`✓ Cached: config/models.json (${models.length} total models)`);
        }
        return;
      }

      // Special handling for prompts.json - load from both sources
      if (key === 'config/prompts.json') {
        const prompts = await loadAllPrompts(true, false);
        const newEtag = this.generateETag(prompts);
        const existing = this.cache.get(key);
        if (!existing || existing.etag !== newEtag) {
          this.setCacheEntry(key, prompts);
          console.log(`✓ Cached: config/prompts.json (${prompts.length} total prompts)`);
        }
        return;
      }

      // Special handling for groups.json - load and resolve inheritance
      if (key === 'config/groups.json') {
        const groupsConfig = await loadJson(key, { useCache: false });
        if (groupsConfig !== null) {
          const resolvedConfig = resolveGroupInheritance(groupsConfig);
          const newEtag = this.generateETag(resolvedConfig);
          const existing = this.cache.get(key);
          if (!existing || existing.etag !== newEtag) {
            this.setCacheEntry(key, resolvedConfig);
            console.log(
              `✓ Cached: config/groups.json (${Object.keys(resolvedConfig.groups || {}).length} groups with resolved inheritance)`
            );
          }
        }
        return;
      }

      if (key.startsWith('locales/')) {
        const lang = key.split('/')[1].replace('.json', '');
        await this.loadAndCacheLocale(lang);
        return;
      }

      const data = await loadJson(key, { useCache: false });
      if (data !== null) {
        const finalData = key === 'config/tools.json' ? expandToolFunctions(data) : data;
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
      return {
        data: null,
        etag: null
      };
    }

    // Validate cache entry structure
    if (!entry.data || typeof entry.data !== 'object') {
      console.warn(`Cache entry for ${configPath} has invalid data structure`);
      return {
        data: null,
        etag: null
      };
    }

    // Check if entry is still valid (extra safety check)
    const age = Date.now() - entry.timestamp;
    if (age > this.cacheTTL * 2) {
      // Allow 2x TTL grace period
      console.warn(`Cache entry for ${configPath} is stale (${Math.round(age / 1000)}s old)`);
    }

    return entry;
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
    // After cache simplification, all models (including disabled) are now stored in config/models.json
    const models = this.get('config/models.json');
    if (models === null || !models.data) {
      console.warn('Models cache not initialized - returning empty array');
      return [];
    }

    if (includeDisabled) {
      return models;
    }

    // Filter to only enabled models
    return {
      data: models.data.filter(model => model.enabled !== false),
      etag: models.etag
    };
  }

  /**
   * Get apps configuration
   */
  getApps(includeDisabled = false) {
    // After cache simplification, all apps (including disabled) are now stored in config/apps.json
    const apps = this.get('config/apps.json');
    if (apps === null || !apps.data) {
      console.warn('Apps cache not initialized - returning empty array');
      return [];
    }

    if (includeDisabled) {
      return apps;
    }

    // Filter to only enabled apps
    return {
      data: apps.data.filter(app => app.enabled !== false),
      etag: apps.etag
    };
  }

  /**
   * Get tools configuration
   */
  getTools(includeDisabled = false) {
    // After cache simplification, all tools (including disabled) are now stored in config/tools.json
    const tools = this.get('config/tools.json');
    if (tools === null || !tools.data) {
      console.warn('Tools cache not initialized - returning empty array');
      return [];
    }

    if (includeDisabled) {
      return tools;
    }

    // Filter to only enabled tools
    return {
      data: tools.data.filter(tool => tool.enabled !== false),
      etag: tools.etag
    };
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
    const cacheKey = 'config/prompts.json';
    const prompts = this.get(cacheKey);

    if (prompts === null || !prompts.data) {
      console.warn('Prompts cache not initialized - returning empty array');
      return [];
    }

    if (includeDisabled) {
      return prompts;
    }

    // Filter to only enabled prompts
    return {
      data: prompts.data.filter(prompt => prompt.enabled !== false),
      etag: prompts.etag
    };
  }

  /**
   * Get platform configuration
   */
  getPlatform() {
    return this.get('config/platform.json').data;
  }

  /**
   * Get groups configuration with resolved inheritance
   */
  getGroups() {
    return this.get('config/groups.json');
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
    const lockKey = `locale-${language}`;

    // Check if this locale is already being loaded
    if (this.localeLoadingLocks.has(lockKey)) {
      console.log(`⏳ Locale ${language} already being loaded, waiting...`);
      return await this.localeLoadingLocks.get(lockKey);
    }

    // Create a promise to lock this locale loading
    const loadPromise = this._loadAndCacheLocaleInternal(language);
    this.localeLoadingLocks.set(lockKey, loadPromise);

    try {
      const result = await loadPromise;
      return result;
    } finally {
      // Always clean up the lock
      this.localeLoadingLocks.delete(lockKey);
    }
  }

  async _loadAndCacheLocaleInternal(language) {
    try {
      console.log(`🔄 Loading locale: ${language}`);

      const base = await loadBuiltinLocaleJson(`${language}.json`);
      if (!base) {
        console.warn(`⚠️  Failed to load builtin locale for ${language}`);
        return null;
      }

      const overrides = (await loadJson(`locales/${language}.json`)) || {};
      const merged = this.mergeLocaleData(base, overrides);
      this.setCacheEntry(`locales/${language}.json`, merged);

      const overrideInfo =
        Object.keys(overrides).length > 0 ? ` with ${Object.keys(overrides).length} overrides` : '';

      console.log(
        `✓ Cached locale: ${language} (${Object.keys(merged).length} keys${overrideInfo})`
      );
      return merged;
    } catch (error) {
      console.error(`❌ Error caching locale ${language}:`, error.message);
      console.error(error.stack);
      return null;
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
      const models = await loadAllModels(true);
      this.setCacheEntry('config/models.json', models);

      console.log(`✅ Models cache refreshed: ${models.length} enabled, ${models.length} total`);
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
      const apps = await loadAllApps(true);
      this.setCacheEntry('config/apps.json', apps);

      console.log(`✅ Apps cache refreshed: ${apps.length} enabled, ${apps.length} total`);
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
      const prompts = await loadAllPrompts(true);
      this.setCacheEntry('config/prompts.json', prompts);

      console.log(`✅ Prompts cache refreshed: ${prompts.length} enabled, ${prompts.length} total`);
    } catch (error) {
      console.error('❌ Error refreshing prompts cache:', error.message);
    }
  }

  /**
   * Invalidate and refresh all cached entries
   */
  async refreshAll() {
    console.log('🔄 Refreshing all cached configurations...');

    const refreshPromises = Array.from(this.cache.keys()).map(async configPath => {
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
