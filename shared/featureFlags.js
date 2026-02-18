/**
 * Feature Flags Utility
 *
 * Encapsulates feature flag checking logic to eliminate repetitive code
 * and provide a consistent API across the application.
 *
 * @module featureFlags
 */

/**
 * FeatureFlags class for checking feature enablement.
 * Supports both platform-level and app-level feature checks.
 */
export class FeatureFlags {
  /**
   * Create a FeatureFlags instance.
   * @param {Object} platformConfig - Platform configuration object
   */
  constructor(platformConfig = {}) {
    this.platformConfig = platformConfig;
  }

  /**
   * Check if a platform-level feature is enabled.
   *
   * @param {string} featureId - The feature identifier (e.g., 'shortLinks', 'tools')
   * @param {boolean} defaultValue - Default value if feature flag is not explicitly set (default: true)
   * @returns {boolean} True if the feature is enabled
   *
   * @example
   * const flags = new FeatureFlags(platformConfig);
   * const isEnabled = flags.isEnabled('shortLinks', true);
   */
  isEnabled(featureId, defaultValue = true) {
    const featuresMap = this.platformConfig?.featuresMap;
    if (!featuresMap || !(featureId in featuresMap)) {
      return defaultValue;
    }
    return featuresMap[featureId] !== false;
  }

  /**
   * Check if an app-level feature is enabled.
   *
   * @param {Object} app - The app configuration object
   * @param {string} featurePath - Dot-notation path to the feature (e.g., 'magicPrompt.enabled', 'shortLinks')
   * @param {boolean} defaultValue - Default value if feature flag is not explicitly set (default: false)
   * @returns {boolean} True if the feature is enabled
   *
   * @example
   * const flags = new FeatureFlags(platformConfig);
   * const magicEnabled = flags.isAppFeatureEnabled(app, 'magicPrompt.enabled', false);
   * const shortLinksEnabled = flags.isAppFeatureEnabled(app, 'shortLinks', true);
   */
  isAppFeatureEnabled(app, featurePath, defaultValue = false) {
    if (!app || !app.features) {
      return defaultValue;
    }

    const pathParts = featurePath.split('.');
    let value = app.features;

    for (const part of pathParts) {
      if (value && typeof value === 'object' && part in value) {
        value = value[part];
      } else {
        return defaultValue;
      }
    }

    // Handle both boolean and object values
    if (typeof value === 'boolean') {
      return value;
    }

    // For non-boolean values (like objects), check if they're truthy
    // and not explicitly false
    return value !== false && value !== undefined && value !== null ? defaultValue : defaultValue;
  }

  /**
   * Check if a feature is enabled at both platform and app levels.
   * Both must be enabled for this to return true.
   *
   * @param {Object} app - The app configuration object
   * @param {string} featureId - The feature identifier (e.g., 'shortLinks')
   * @param {boolean} defaultValue - Default value if feature flag is not explicitly set (default: true)
   * @returns {boolean} True if the feature is enabled at both levels
   *
   * @example
   * const flags = new FeatureFlags(platformConfig);
   * const shortLinksEnabled = flags.isBothEnabled(app, 'shortLinks', true);
   */
  isBothEnabled(app, featureId, defaultValue = true) {
    const platformEnabled = this.isEnabled(featureId, defaultValue);
    const appEnabled = this.isAppFeatureEnabled(app, featureId, defaultValue);
    return platformEnabled && appEnabled;
  }

  /**
   * Get a nested app feature value (not just enabled/disabled).
   * Useful for getting configuration values like magicPrompt.model or magicPrompt.prompt.
   *
   * @param {Object} app - The app configuration object
   * @param {string} featurePath - Dot-notation path to the feature value (e.g., 'magicPrompt.model')
   * @param {*} defaultValue - Default value if the path doesn't exist
   * @returns {*} The feature value or default
   *
   * @example
   * const flags = new FeatureFlags(platformConfig);
   * const magicModel = flags.getAppFeatureValue(app, 'magicPrompt.model', null);
   * const magicPrompt = flags.getAppFeatureValue(app, 'magicPrompt.prompt', '');
   */
  getAppFeatureValue(app, featurePath, defaultValue = null) {
    if (!app || !app.features) {
      return defaultValue;
    }

    const pathParts = featurePath.split('.');
    let value = app.features;

    for (const part of pathParts) {
      if (value && typeof value === 'object' && part in value) {
        value = value[part];
      } else {
        return defaultValue;
      }
    }

    return value ?? defaultValue;
  }
}

/**
 * Create a FeatureFlags instance from platform configuration.
 * Convenience function for one-off checks.
 *
 * @param {Object} platformConfig - Platform configuration object
 * @returns {FeatureFlags} A new FeatureFlags instance
 */
export function createFeatureFlags(platformConfig) {
  return new FeatureFlags(platformConfig);
}
