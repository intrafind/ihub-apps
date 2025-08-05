import configCache from '../configCache.js';

/**
 * Source Dependency Tracker
 *
 * Utility for tracking which apps use which sources and managing dependencies.
 * Provides safe deletion warnings and usage analytics.
 *
 * Features:
 * - Track source usage across all apps
 * - Provide dependency information for safe deletion
 * - Generate usage statistics for monitoring
 * - Detect circular dependencies
 */
class SourceDependencyTracker {
  /**
   * Get all apps that use a specific source
   *
   * @param {string} sourceId - Source ID to check usage for
   * @returns {Array} Array of apps using the source
   */
  static getSourceUsage(sourceId) {
    try {
      const apps = configCache.getApps() || [];
      const usedBy = [];

      for (const app of apps) {
        if (this.appUsesSource(app, sourceId)) {
          usedBy.push({
            appId: app.id,
            appName: this.getAppName(app),
            usage: this.getUsageType(app, sourceId),
            enabled: app.enabled !== false
          });
        }
      }

      return usedBy;
    } catch (error) {
      console.error('Error getting source usage:', error);
      return [];
    }
  }

  /**
   * Check if an app uses a specific source
   *
   * @param {object} app - App configuration
   * @param {string} sourceId - Source ID to check
   * @returns {boolean} True if app uses the source
   */
  static appUsesSource(app, sourceId) {
    if (!app.sources || !Array.isArray(app.sources)) {
      return false;
    }

    return app.sources.some(source => {
      // String reference (admin source)
      if (typeof source === 'string') {
        return source === sourceId;
      }

      // Inline source object
      if (typeof source === 'object' && source.id) {
        return source.id === sourceId;
      }

      return false;
    });
  }

  /**
   * Get the usage type for a source in an app
   *
   * @param {object} app - App configuration
   * @param {string} sourceId - Source ID
   * @returns {string} Usage type (admin-reference, inline, unknown)
   */
  static getUsageType(app, sourceId) {
    if (!app.sources) return 'unknown';

    for (const source of app.sources) {
      if (typeof source === 'string' && source === sourceId) {
        return 'admin-reference';
      }

      if (typeof source === 'object' && source.id === sourceId) {
        return 'inline';
      }
    }

    return 'unknown';
  }

  /**
   * Get localized app name
   *
   * @param {object} app - App configuration
   * @param {string} language - Preferred language (default: 'en')
   * @returns {string} Localized app name
   */
  static getAppName(app, language = 'en') {
    if (typeof app.name === 'string') {
      return app.name;
    }

    if (typeof app.name === 'object') {
      return app.name[language] || app.name['en'] || Object.values(app.name)[0] || app.id;
    }

    return app.id;
  }

  /**
   * Check if a source can be safely deleted
   *
   * @param {string} sourceId - Source ID to check
   * @returns {object} Safety check result
   */
  static canSafelyDelete(sourceId) {
    const usage = this.getSourceUsage(sourceId);
    const enabledUsage = usage.filter(app => app.enabled);

    return {
      canDelete: enabledUsage.length === 0,
      totalUsage: usage.length,
      enabledUsage: enabledUsage.length,
      disabledUsage: usage.length - enabledUsage.length,
      usedBy: usage,
      warnings: this.generateDeletionWarnings(usage)
    };
  }

  /**
   * Generate deletion warnings for a source
   *
   * @param {Array} usage - Source usage data
   * @returns {Array} Array of warning messages
   */
  static generateDeletionWarnings(usage) {
    const warnings = [];
    const enabledApps = usage.filter(app => app.enabled);
    const disabledApps = usage.filter(app => !app.enabled);

    if (enabledApps.length > 0) {
      warnings.push({
        type: 'error',
        message: `This source is used by ${enabledApps.length} active app(s): ${enabledApps.map(app => app.appName).join(', ')}`
      });
    }

    if (disabledApps.length > 0) {
      warnings.push({
        type: 'warning',
        message: `This source is also used by ${disabledApps.length} disabled app(s): ${disabledApps.map(app => app.appName).join(', ')}`
      });
    }

    return warnings;
  }

  /**
   * Get all source dependencies for the system
   *
   * @returns {object} Complete dependency map
   */
  static getAllSourceDependencies() {
    try {
      const { data: sources } = configCache.getSources() || { data: [] };
      const apps = configCache.getApps() || [];
      const dependencies = {};

      // Initialize dependency map
      for (const source of sources) {
        dependencies[source.id] = {
          source: source,
          usedBy: [],
          totalUsage: 0,
          enabledUsage: 0
        };
      }

      // Find all source references in apps
      for (const app of apps) {
        if (!app.sources) continue;

        for (const sourceRef of app.sources) {
          let sourceId = null;

          if (typeof sourceRef === 'string') {
            sourceId = sourceRef;
          } else if (typeof sourceRef === 'object' && sourceRef.id) {
            sourceId = sourceRef.id;
          }

          if (sourceId && dependencies[sourceId]) {
            dependencies[sourceId].usedBy.push({
              appId: app.id,
              appName: this.getAppName(app),
              enabled: app.enabled !== false,
              usageType: typeof sourceRef === 'string' ? 'admin-reference' : 'inline'
            });

            dependencies[sourceId].totalUsage++;
            if (app.enabled !== false) {
              dependencies[sourceId].enabledUsage++;
            }
          }
        }
      }

      return dependencies;
    } catch (error) {
      console.error('Error getting all source dependencies:', error);
      return {};
    }
  }

  /**
   * Get usage statistics for all sources
   *
   * @returns {object} Usage statistics
   */
  static getUsageStatistics() {
    try {
      const dependencies = this.getAllSourceDependencies();
      const stats = {
        totalSources: 0,
        usedSources: 0,
        unusedSources: 0,
        sourcesWithMultipleUsage: 0,
        averageUsagePerSource: 0,
        usageDistribution: {},
        topUsedSources: []
      };

      let totalUsage = 0;
      const usageData = [];

      for (const [sourceId, data] of Object.entries(dependencies)) {
        stats.totalSources++;
        totalUsage += data.totalUsage;

        if (data.totalUsage > 0) {
          stats.usedSources++;

          if (data.totalUsage > 1) {
            stats.sourcesWithMultipleUsage++;
          }

          usageData.push({
            sourceId,
            sourceName: this.getSourceName(data.source),
            usage: data.totalUsage,
            enabledUsage: data.enabledUsage
          });
        } else {
          stats.unusedSources++;
        }

        // Usage distribution
        const usageCount = data.totalUsage;
        stats.usageDistribution[usageCount] = (stats.usageDistribution[usageCount] || 0) + 1;
      }

      // Calculate averages and top sources
      stats.averageUsagePerSource = stats.totalSources > 0 ? totalUsage / stats.totalSources : 0;
      stats.topUsedSources = usageData.sort((a, b) => b.usage - a.usage).slice(0, 10);

      return stats;
    } catch (error) {
      console.error('Error getting usage statistics:', error);
      return {};
    }
  }

  /**
   * Get source name from source object
   *
   * @param {object} source - Source configuration
   * @param {string} language - Preferred language
   * @returns {string} Source name
   */
  static getSourceName(source, language = 'en') {
    if (typeof source.name === 'string') {
      return source.name;
    }

    if (typeof source.name === 'object') {
      return (
        source.name[language] || source.name['en'] || Object.values(source.name)[0] || source.id
      );
    }

    return source.id;
  }

  /**
   * Find orphaned sources (defined in apps but not in sources.json)
   *
   * @returns {Array} Array of orphaned source references
   */
  static findOrphanedSources() {
    try {
      const { data: adminSources } = configCache.getSources() || { data: [] };
      const apps = configCache.getApps() || [];
      const adminSourceIds = new Set(adminSources.map(s => s.id));
      const orphaned = [];

      for (const app of apps) {
        if (!app.sources) continue;

        for (const source of app.sources) {
          // Only check string references (admin source references)
          if (typeof source === 'string' && !adminSourceIds.has(source)) {
            orphaned.push({
              sourceId: source,
              appId: app.id,
              appName: this.getAppName(app)
            });
          }
        }
      }

      return orphaned;
    } catch (error) {
      console.error('Error finding orphaned sources:', error);
      return [];
    }
  }

  /**
   * Get detailed dependency report
   *
   * @returns {object} Comprehensive dependency report
   */
  static getDependencyReport() {
    return {
      timestamp: new Date().toISOString(),
      dependencies: this.getAllSourceDependencies(),
      statistics: this.getUsageStatistics(),
      orphanedSources: this.findOrphanedSources(),
      recommendations: this.generateRecommendations()
    };
  }

  /**
   * Generate optimization recommendations
   *
   * @returns {Array} Array of recommendations
   */
  static generateRecommendations() {
    const recommendations = [];
    const stats = this.getUsageStatistics();
    const orphaned = this.findOrphanedSources();

    if (stats.unusedSources > 0) {
      recommendations.push({
        type: 'cleanup',
        priority: 'low',
        message: `Consider removing ${stats.unusedSources} unused source(s) to reduce configuration complexity`
      });
    }

    if (orphaned.length > 0) {
      recommendations.push({
        type: 'error',
        priority: 'high',
        message: `Fix ${orphaned.length} orphaned source reference(s) - apps reference sources that don't exist`
      });
    }

    if (stats.sourcesWithMultipleUsage === 0 && stats.usedSources > 1) {
      recommendations.push({
        type: 'optimization',
        priority: 'medium',
        message: 'Consider consolidating similar sources to improve reusability'
      });
    }

    return recommendations;
  }
}

export default SourceDependencyTracker;
