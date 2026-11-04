// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { createResourceLoader, createValidator } from './utils/resourceLoader.js';

/**
 * Enhanced Prompts Loader Service
 *
 * This service loads prompts from the individual files in contents/prompts/.
 *
 * Uses the generic resource loader factory to eliminate code duplication.
 */

// Create the prompts resource loader
const promptsLoader = createResourceLoader({
  resourceName: 'Prompts',
  individualPath: 'prompts',
  validateItem: createValidator(['id', 'name', 'prompt'])
});

/**
 * Load prompts from individual files in contents/prompts/
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Array} Array of prompt objects
 */
export async function loadPromptsFromFiles(verbose = true) {
  return await promptsLoader.loadFromFiles(verbose);
}

/**
 * Load all prompts
 * @param {boolean} includeDisabled - Include disabled prompts
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Array} Array of prompt objects
 */
export async function loadAllPrompts(includeDisabled = false, verbose = true) {
  return await promptsLoader.loadAll(includeDisabled, verbose);
}
