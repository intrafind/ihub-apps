import configCache from '../configCache.js';
import { createSourceManager } from '../sources/index.js';

/**
 * Source Resolution Service
 *
 * Bridges the gap between admin-configured sources (sources.json) and
 * app-embedded source usage. Enables apps to reference sources by ID.
 *
 * Key Features:
 * - Resolves source ID string references to configured sources
 * - Unifies admin and app source schemas
 * - Provides caching and error handling
 */
class SourceResolutionService {
  constructor() {
    this.configCache = configCache;
    this.sourceManager = createSourceManager();
    this.resolutionCache = new Map();
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes cache TTL
  }

  /**
   * Resolve app source references to actual source configurations
   *
   * @param {object} app - Application configuration containing sources
   * @param {object} context - Request context (user, chatId, etc.)
   * @returns {Promise<Array>} Array of resolved source configurations
   */
  async resolveAppSources(app, context = {}) {
    if (!app.sources || !Array.isArray(app.sources) || app.sources.length === 0) {
      console.log('No sources configured for app:', app.id);
      return [];
    }

    // Generate cache key for resolution caching
    const cacheKey = this.generateCacheKey(app.id, app.sources);

    // Check cache first
    if (this.resolutionCache.has(cacheKey)) {
      const cached = this.resolutionCache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.cacheTimeout) {
        console.log(`Using cached source resolution for app: ${app.id}`);
        return cached.sources;
      }
    }

    console.log(`Resolving ${app.sources.length} source references for app: ${app.id}`);
    const resolvedSources = [];

    for (const sourceRef of app.sources) {
      try {
        if (typeof sourceRef === 'string') {
          // String reference - resolve from admin sources
          const resolvedSource = await this.resolveSourceById(sourceRef, context);
          if (resolvedSource) {
            resolvedSources.push(resolvedSource);
            console.log(`✓ Resolved admin source reference: ${sourceRef}`);
          } else {
            console.warn(
              `⚠ Source reference '${sourceRef}' not found in admin sources or disabled`
            );
          }
        } else {
          console.warn(
            `⚠ Invalid source reference format - only string IDs are supported:`,
            sourceRef
          );
        }
      } catch (error) {
        console.error(`Error resolving source reference:`, sourceRef, error);
        // Continue processing other sources
      }
    }

    // Cache the resolved sources
    this.resolutionCache.set(cacheKey, {
      sources: resolvedSources,
      timestamp: Date.now()
    });

    console.log(
      `Resolved ${resolvedSources.length}/${app.sources.length} sources for app: ${app.id}`
    );
    return resolvedSources;
  }

  /**
   * Resolve a single source by ID from admin configuration
   *
   * @param {string} sourceId - Source identifier
   * @param {object} context - Request context
   * @returns {Promise<object|null>} Resolved source configuration or null
   */
  async resolveSourceById(sourceId, context = {}) {
    const adminSource = this.getAdminSourceById(sourceId);

    if (!adminSource) {
      console.warn(`Admin source not found: ${sourceId}`);
      return null;
    }

    if (!adminSource.enabled) {
      console.warn(`Admin source disabled: ${sourceId}`);
      return null;
    }

    // Convert admin source schema to app-compatible format
    const unifiedSource = this.unifySourceSchema(adminSource, context);

    return unifiedSource;
  }

  /**
   * Get admin source configuration by ID
   *
   * @param {string} sourceId - Source identifier
   * @returns {object|null} Admin source configuration or null
   */
  getAdminSourceById(sourceId) {
    try {
      const { data: sources } = this.configCache.getSources() || { data: [] };
      return sources.find(source => source.id === sourceId) || null;
    } catch (error) {
      console.error(`Error loading admin sources:`, error);
      return null;
    }
  }

  /**
   * Convert admin source schema to app-compatible source schema
   *
   * Admin sources use localized names/descriptions and different config structure.
   * App sources expect specific fields like exposeAs, caching, etc.
   *
   * @param {object} adminSource - Source from sources.json
   * @param {object} context - Request context for localization
   * @returns {object} App-compatible source configuration
   */
  unifySourceSchema(adminSource, context = {}) {
    const language = context.language || 'en';

    // Handle schema field mismatch: admin uses 'path', handler expects 'path'
    // But admin schema currently uses 'basePath' which needs to be fixed
    let config = { ...adminSource.config };

    // Convert localized fields to simple strings for app usage
    const description =
      this.getLocalizedValue(adminSource.description, language) ||
      this.getLocalizedValue(adminSource.name, language) ||
      adminSource.id;

    return {
      id: adminSource.id,
      name: adminSource.name, // Keep the original localized name for display purposes
      type: adminSource.type,
      description: description,
      config: config,
      exposeAs: adminSource.exposeAs || 'prompt', // Default for admin sources
      enabled: adminSource.enabled !== false,
      caching: {
        ttl: 3600, // Default 1 hour cache
        strategy: 'static' // Admin sources are typically static
      }
    };
  }

  /**
   * Get localized value from localized object or return string directly
   *
   * @param {string|object} value - Localized object or string
   * @param {string} language - Preferred language
   * @returns {string|null} Localized string or null
   */
  getLocalizedValue(value, language = 'en') {
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'object' && value !== null) {
      return value[language] || value['en'] || Object.values(value)[0] || null;
    }
    return null;
  }

  /**
   * Generate cache key for source resolution
   *
   * @param {string} appId - Application ID
   * @param {Array} sources - Source references array (all strings)
   * @returns {string} Cache key
   */
  generateCacheKey(appId, sources) {
    const sourceSignature = sources.filter(source => typeof source === 'string').join('|');
    return `${appId}:${sourceSignature}`;
  }

  /**
   * Clear resolution cache (useful for testing or config changes)
   */
  clearCache() {
    this.resolutionCache.clear();
    console.log('Source resolution cache cleared');
  }

  /**
   * Get cache statistics for monitoring
   *
   * @returns {object} Cache statistics
   */
  getCacheStats() {
    const now = Date.now();
    let validEntries = 0;
    let expiredEntries = 0;

    for (const [key, value] of this.resolutionCache.entries()) {
      if (now - value.timestamp < this.cacheTimeout) {
        validEntries++;
      } else {
        expiredEntries++;
      }
    }

    return {
      totalEntries: this.resolutionCache.size,
      validEntries,
      expiredEntries,
      cacheTimeout: this.cacheTimeout
    };
  }
}

export default SourceResolutionService;
