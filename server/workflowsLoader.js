import { createResourceLoader, createSchemaValidator } from './utils/resourceLoader.js';
import { workflowConfigSchema, knownWorkflowKeys } from './validators/workflowConfigSchema.js';

/**
 * Workflows Loader Service
 *
 * This service loads workflow definitions from individual files in contents/workflows/
 * and the legacy config/workflows.json file for backward compatibility.
 *
 * Uses the generic resource loader factory to eliminate code duplication.
 * Workflow definitions are validated against the workflowConfigSchema.
 *
 * @module workflowsLoader
 */

// Create the workflows resource loader
const workflowsLoader = createResourceLoader({
  resourceName: 'Workflows',
  legacyPath: 'config/workflows.json',
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
 * Load workflows from legacy workflows.json file
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Promise<Array>} Array of workflow objects
 */
export async function loadWorkflowsFromLegacyFile(verbose = true) {
  return await workflowsLoader.loadFromLegacy(verbose);
}

/**
 * Load all workflows from both sources
 * Individual files take precedence over legacy workflows.json
 * @param {boolean} includeDisabled - Whether to include disabled workflows
 * @param {boolean} verbose - Whether to log verbose output
 * @returns {Promise<Array>} Array of workflow objects, sorted by order
 */
export async function loadAllWorkflows(includeDisabled = false, verbose = true) {
  return await workflowsLoader.loadAll(includeDisabled, verbose);
}
