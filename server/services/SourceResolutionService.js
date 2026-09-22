import configCache from '../configCache.js';
import logger from '../utils/logger.js';
import { getLocalizedString } from '../utils/localize.js';

/**
 * Source Resolution Service
 *
 * Bridges the gap between admin-configured sources (sources.json) and
 * app-embedded source usage. Enables apps to reference sources by ID.
 *
 * Key Features:
 * - Resolves source ID string references to configured sources
 * - Unifies admin and app source schemas
 * - Provides error handling
 */
class SourceResolutionService {
  constructor() {
    this.configCache = configCache;
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
      logger.info('No sources configured for app', {
        component: 'SourceResolutionService',
        appId: app.id
      });
      return [];
    }

    logger.info('Resolving source references for app', {
      component: 'SourceResolutionService',
      appId: app.id,
      sourceCount: app.sources.length
    });
    const resolvedSources = [];

    for (const sourceRef of app.sources) {
      try {
        if (typeof sourceRef === 'string') {
          // String reference - resolve from admin sources
          const resolvedSource = await this.resolveSourceById(sourceRef, context);
          if (resolvedSource) {
            resolvedSources.push(resolvedSource);
            logger.info('Resolved admin source reference', {
              component: 'SourceResolutionService',
              sourceRef
            });
          } else {
            logger.warn('Source reference not found in admin sources or disabled', {
              component: 'SourceResolutionService',
              sourceRef
            });
          }
        } else {
          logger.warn('Invalid source reference format - only string IDs are supported', {
            component: 'SourceResolutionService',
            sourceRef
          });
        }
      } catch (error) {
        logger.error('Error resolving source reference', {
          component: 'SourceResolutionService',
          sourceRef,
          error
        });
        // Continue processing other sources
      }
    }

    logger.info('Resolved sources for app', {
      component: 'SourceResolutionService',
      appId: app.id,
      resolved: resolvedSources.length,
      total: app.sources.length
    });
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
      logger.warn('Admin source not found', { component: 'SourceResolutionService', sourceId });
      return null;
    }

    if (!adminSource.enabled) {
      logger.warn('Admin source disabled', { component: 'SourceResolutionService', sourceId });
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
      logger.error('Error loading admin sources', { component: 'SourceResolutionService', error });
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
      getLocalizedString(adminSource.description, language) ||
      getLocalizedString(adminSource.name, language) ||
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
}

export default SourceResolutionService;
