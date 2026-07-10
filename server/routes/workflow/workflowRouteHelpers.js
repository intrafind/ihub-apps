/**
 * Workflow Route Helpers
 *
 * Shared, stateless helpers and module-level state used across the
 * workflow route modules (definitionRoutes, executionRoutes, streamRoutes,
 * adminRoutes, versionRoutes).
 *
 * @module routes/workflow/workflowRouteHelpers
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { workflowConfigSchema } from '../../validators/workflowConfigSchema.js';
import { getRootDir } from '../../pathUtils.js';
import { filterResourcesByPermissions } from '../../utils/authorization.js';
import { startInactiveClientSweep } from '../../utils/sseChannel.js';
import logger from '../../utils/logger.js';
import { requireFeature } from '../../featureRegistry.js';

export const checkWorkflowsFeature = requireFeature('workflows');

/**
 * SSE clients map for workflow execution streaming
 * Maps executionId -> { response, lastActivity }
 * @type {Map<string, {response: object, lastActivity: Date}>}
 */
export const workflowClients = new Map();
startInactiveClientSweep(workflowClients, { component: 'WorkflowRoutes' });

/**
 * Filters workflows based on user permissions from groups.json.
 * Uses the standard group-based permission system (permissions.workflows)
 * consistent with how apps, models, and prompts are handled.
 *
 * @param {Object[]} workflows - Array of workflow definitions
 * @param {Object} user - User object with groups and permissions
 * @returns {Object[]} Filtered array of accessible workflows
 */
export function filterByPermissions(workflows, user) {
  if (!Array.isArray(workflows)) {
    return [];
  }

  // Admin users can see all workflows
  if (isAdmin(user)) {
    return workflows;
  }

  // Use the standard permission system via user.permissions.workflows
  const workflowPermissions = user?.permissions?.workflows;
  if (!workflowPermissions) {
    return [];
  }

  return filterResourcesByPermissions(workflows, workflowPermissions);
}

/**
 * Checks if a user has admin privileges.
 *
 * @param {Object} user - User object from request
 * @returns {boolean} True if user has admin access
 */
export function isAdmin(user) {
  if (!user) return false;
  return user.groups?.includes('admin') || user.permissions?.adminAccess === true;
}

/**
 * Maximum entries kept in the input preview shown on the executions list.
 */
const INPUT_PREVIEW_MAX_ENTRIES = 6;
/**
 * Per-value truncation length (characters) for string fields in the input preview.
 */
const INPUT_PREVIEW_MAX_VALUE_LENGTH = 120;

/**
 * Builds a sanitized input preview from a workflow execution's initial data.
 * Strips internal underscore-prefixed keys, drops empty values, truncates long
 * strings, and caps entry count. Object/array values are summarized.
 *
 * @param {Object} initialData - Raw initialData passed to /execute
 * @returns {Object|null} Preview object (possibly with a `__more` count), or null if empty
 */
export function buildInputPreview(initialData) {
  if (!initialData || typeof initialData !== 'object') return null;

  const preview = {};
  const allKeys = Object.keys(initialData).filter(k => !k.startsWith('_'));
  let kept = 0;

  for (const key of allKeys) {
    if (kept >= INPUT_PREVIEW_MAX_ENTRIES) break;
    const value = initialData[key];
    if (value === null || value === undefined || value === '') continue;

    if (typeof value === 'string') {
      preview[key] =
        value.length > INPUT_PREVIEW_MAX_VALUE_LENGTH
          ? value.slice(0, INPUT_PREVIEW_MAX_VALUE_LENGTH - 1) + '…'
          : value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      preview[key] = value;
    } else if (Array.isArray(value)) {
      preview[key] = `[${value.length} items]`;
    } else if (typeof value === 'object') {
      const keys = Object.keys(value);
      preview[key] =
        keys.length === 0
          ? '{}'
          : `{${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', …' : ''}}`;
    } else {
      preview[key] = String(value);
    }
    kept += 1;
  }

  if (kept === 0) return null;

  const remaining =
    allKeys.filter(
      k => initialData[k] !== null && initialData[k] !== undefined && initialData[k] !== ''
    ).length - kept;
  if (remaining > 0) preview.__more = remaining;

  return preview;
}

/**
 * Builds the distinct list of model IDs referenced by a workflow definition's
 * nodes. Used at registration time so the executions list can show which
 * model(s) a run uses.
 *
 * @param {Object} workflow - Workflow definition
 * @returns {string[]} Distinct model IDs in insertion order
 */
export function buildModelsList(workflow) {
  const set = new Set();
  for (const node of workflow?.nodes || []) {
    if (typeof node.model === 'string' && node.model) set.add(node.model);
  }
  return Array.from(set);
}

/**
 * Loads all workflow definitions from the filesystem.
 * Workflows are stored as individual JSON files in contents/workflows/
 *
 * @param {boolean} includeDisabled - Whether to include disabled workflows
 * @returns {Promise<Object[]>} Array of workflow definitions
 */
export async function loadWorkflows(includeDisabled = false) {
  const rootDir = getRootDir();
  const workflowsDir = join(rootDir, 'contents', 'workflows');

  try {
    // Create directory if it doesn't exist
    await fs.mkdir(workflowsDir, { recursive: true });

    const files = await fs.readdir(workflowsDir);
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    const workflows = [];
    for (const file of jsonFiles) {
      try {
        const filePath = join(workflowsDir, file);
        const content = await fs.readFile(filePath, 'utf8');
        const workflow = JSON.parse(content);

        // Skip disabled workflows unless explicitly requested
        if (!includeDisabled && workflow.enabled === false) {
          continue;
        }

        workflows.push(workflow);
      } catch (error) {
        logger.warn('Failed to load workflow file', {
          component: 'WorkflowRoutes',
          file,
          error: error.message
        });
      }
    }

    return workflows;
  } catch (error) {
    logger.error('Failed to read workflows directory', {
      component: 'WorkflowRoutes',
      error: error.message
    });
    return [];
  }
}

/**
 * Finds the actual filename for a workflow ID.
 * Handles cases where the filename doesn't match the workflow ID.
 *
 * @param {string} workflowId - The workflow ID to search for
 * @param {string} workflowsDir - The workflows directory path
 * @returns {Promise<string|null>} The filename if found, null otherwise
 */
export async function findWorkflowFile(workflowId, workflowsDir) {
  try {
    const files = await fs.readdir(workflowsDir);
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    // First try the expected filename
    const expectedFilename = `${workflowId}.json`;
    if (jsonFiles.includes(expectedFilename)) {
      return expectedFilename;
    }

    // If not found, search through all files to find one with matching ID
    for (const file of jsonFiles) {
      try {
        const filePath = join(workflowsDir, file);
        const content = await fs.readFile(filePath, 'utf8');
        const workflow = JSON.parse(content);
        if (workflow.id === workflowId) {
          return file;
        }
      } catch (error) {
        // Skip files that can't be read or parsed
        logger.debug('Skipping malformed workflow file', {
          component: 'WorkflowRoutes',
          file,
          error: error.message
        });
      }
    }

    return null;
  } catch (error) {
    logger.warn('Failed to read workflows directory', {
      component: 'WorkflowRoutes',
      workflowsDir,
      error: error.message
    });
    return null;
  }
}

/**
 * Validates a workflow definition against the schema.
 *
 * @param {Object} workflow - Workflow definition to validate
 * @returns {{success: boolean, errors?: Object[]}} Validation result
 */
export function validateWorkflow(workflow) {
  try {
    const result = workflowConfigSchema.safeParse(workflow);
    if (result.success) {
      return { success: true, data: result.data };
    }
    return {
      success: false,
      errors: result.error.errors.map(err => ({
        path: err.path.join('.'),
        message: err.message
      }))
    };
  } catch (error) {
    return {
      success: false,
      errors: [{ path: '', message: error.message }]
    };
  }
}
