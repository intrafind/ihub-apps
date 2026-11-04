// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { createResourceLoader, createSchemaValidator } from './utils/resourceLoader.js';
import { appConfigSchema, knownAppKeys } from './validators/appConfigSchema.js';

/**
 * Enhanced Apps Loader Service
 *
 * This service loads apps from the individual files in contents/apps/.
 *
 * Uses the generic resource loader factory to eliminate code duplication.
 */

// Create the apps resource loader
const appsLoader = createResourceLoader({
  resourceName: 'Apps',
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
 * Load all apps
 * @param {boolean} includeDisabled - Whether to include disabled apps
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Array} Array of app objects, sorted by order
 */
export async function loadAllApps(includeDisabled = false, verbose = true) {
  return await appsLoader.loadAll(includeDisabled, verbose);
}
