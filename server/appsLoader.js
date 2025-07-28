import { createResourceLoader, createSchemaValidator } from './utils/resourceLoader.js';
import { appConfigSchema, knownAppKeys } from './validators/appConfigSchema.js';

/**
 * Enhanced Apps Loader Service
 *
 * This service loads apps from both individual files in contents/apps/
 * and the legacy apps.json file for backward compatibility.
 *
 * Uses the generic resource loader factory to eliminate code duplication.
 */

// Create the apps resource loader
const appsLoader = createResourceLoader({
  resourceName: 'Apps',
  legacyPath: 'config/apps.json',
  individualPath: 'apps',
  validateItem: createSchemaValidator(appConfigSchema, knownAppKeys)
});

/**
 * Load apps from individual files in contents/apps/
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Array} Array of app objects
 */
export async function loadAppsFromFiles(verbose = true) {
  return await appsLoader.loadFromFiles(verbose);
}

/**
 * Load apps from legacy apps.json file
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Array} Array of app objects
 */
export async function loadAppsFromLegacyFile(verbose = true) {
  return await appsLoader.loadFromLegacy(verbose);
}

/**
 * Load all apps from both sources
 * Individual files take precedence over legacy apps.json
 * @param {boolean} includeDisabled - Whether to include disabled apps
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Array} Array of app objects, sorted by order
 */
export async function loadAllApps(includeDisabled = false, verbose = true) {
  return await appsLoader.loadAll(includeDisabled, verbose);
}
