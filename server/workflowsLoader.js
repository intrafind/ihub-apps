// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { createResourceLoader, createSchemaValidator } from './utils/resourceLoader.js';
import { workflowConfigSchema, knownWorkflowKeys } from './validators/workflowConfigSchema.js';

/**
 * Workflows Loader Service
 *
 * This service loads workflow definitions from individual files in contents/workflows/.
 *
 * Uses the generic resource loader factory to eliminate code duplication.
 * Workflow definitions are validated against the workflowConfigSchema.
 *
 * @module workflowsLoader
 */

// Create the workflows resource loader
const workflowsLoader = createResourceLoader({
  resourceName: 'Workflows',
  individualPath: 'workflows',
  validateItem: createSchemaValidator(workflowConfigSchema, knownWorkflowKeys)
});

/**
 * Load workflows from individual files in contents/workflows/
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Promise<Array>} Array of workflow objects
 */
export async function loadWorkflowsFromFiles(verbose = true) {
  return await workflowsLoader.loadFromFiles(verbose);
}

/**
 * Load all workflows
 * @param {boolean} includeDisabled - Whether to include disabled workflows
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Promise<Array>} Array of workflow objects, sorted by order
 */
export async function loadAllWorkflows(includeDisabled = false, verbose = true) {
  return await workflowsLoader.loadAll(includeDisabled, verbose);
}
