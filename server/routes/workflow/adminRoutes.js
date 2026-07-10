/**
 * Workflow Admin Routes
 *
 * Admin-only endpoints for listing all workflows (including disabled),
 * toggling a workflow's enabled status, and listing executions across users.
 *
 * @module routes/workflow/adminRoutes
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { getExecutionRegistry } from '../../services/workflow/ExecutionRegistry.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import { getRootDir } from '../../pathUtils.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import { sendNotFound, sendFailedOperationError } from '../../utils/responseHelpers.js';
import logger from '../../utils/logger.js';
import configCache from '../../configCache.js';
import { checkWorkflowsFeature, loadWorkflows, findWorkflowFile } from './workflowRouteHelpers.js';

/**
 * Registers admin-only workflow management endpoints.
 *
 * @param {Express} app - Express application instance
 * @param {Object} deps - Dependencies
 * @param {WorkflowEngine} deps.workflowEngine - Shared workflow engine instance
 */
export default function registerAdminRoutes(app, deps = {}) {
  const { workflowEngine } = deps;

  /**
   * @swagger
   * /api/admin/workflows:
   *   get:
   *     summary: List all workflows (admin view)
   *     description: |
   *       Retrieves all workflow definitions including disabled ones.
   *       Admin access required.
   *     tags:
   *       - Workflows
   *       - Admin
   *     security:
   *       - adminAuth: []
   *     responses:
   *       200:
   *         description: All workflows
   *       401:
   *         description: Authentication required
   *       403:
   *         description: Admin access required
   *       500:
   *         description: Internal server error
   */
  app.get(
    buildServerPath('/api/admin/workflows'),
    checkWorkflowsFeature,
    adminAuth,
    async (req, res) => {
      try {
        const workflows = await loadWorkflows(true); // Include disabled
        res.json(workflows);
      } catch (error) {
        sendFailedOperationError(res, 'fetch workflows', error);
      }
    }
  );

  /**
   * @swagger
   * /api/admin/workflows/{id}/toggle:
   *   post:
   *     summary: Toggle workflow enabled/disabled status
   *     description: |
   *       Toggles the enabled status of a workflow.
   *       Admin access required.
   *     tags:
   *       - Workflows
   *       - Admin
   *     security:
   *       - adminAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Workflow status toggled
   *       401:
   *         description: Authentication required
   *       403:
   *         description: Admin access required
   *       404:
   *         description: Workflow not found
   *       500:
   *         description: Internal server error
   */
  app.post(
    buildServerPath('/api/admin/workflows/:id/toggle'),
    checkWorkflowsFeature,
    adminAuth,
    async (req, res) => {
      try {
        const { id } = req.params;

        // Validate ID for security
        if (!validateIdForPath(id, 'workflow', res)) {
          return;
        }

        // Find workflow file
        const rootDir = getRootDir();
        const workflowsDir = join(rootDir, 'contents', 'workflows');
        const filename = await findWorkflowFile(id, workflowsDir);

        if (!filename) {
          return sendNotFound(res, 'Workflow');
        }

        // Read current workflow
        const workflowPath = join(workflowsDir, filename);
        const content = await fs.readFile(workflowPath, 'utf8');
        const workflow = JSON.parse(content);

        // Toggle enabled status
        const newEnabledState = workflow.enabled === false;
        workflow.enabled = newEnabledState;

        // Save updated workflow
        await atomicWriteJSON(workflowPath, workflow);

        logger.info('Workflow toggled', {
          component: 'WorkflowRoutes',
          workflowId: id,
          enabled: newEnabledState
        });

        res.json({
          message: `Workflow ${newEnabledState ? 'enabled' : 'disabled'} successfully`,
          workflow,
          enabled: newEnabledState
        });

        // Refresh workflow cache after successful toggle
        configCache.refreshWorkflowsCache?.();
      } catch (error) {
        sendFailedOperationError(res, 'toggle workflow', error);
      }
    }
  );

  /**
   * @swagger
   * /api/admin/workflows/executions:
   *   get:
   *     summary: List workflow executions (admin view)
   *     description: |
   *       Retrieves workflow executions with optional filtering.
   *       When status=all or a specific status is provided, returns executions
   *       from the ExecutionRegistry (which includes completed/failed/cancelled).
   *       Without filters, returns only active (running/paused) executions.
   *       Admin access required.
   *     tags:
   *       - Workflows
   *       - Admin
   *       - Execution
   *     security:
   *       - adminAuth: []
   *     parameters:
   *       - in: query
   *         name: status
   *         schema:
   *           type: string
   *           enum: [all, running, paused, completed, failed, cancelled]
   *         description: Filter by execution status. Use 'all' to return all executions.
   *       - in: query
   *         name: search
   *         schema:
   *           type: string
   *         description: Search by user ID or workflow name
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *           default: 100
   *         description: Maximum number of results
   *       - in: query
   *         name: offset
   *         schema:
   *           type: integer
   *           default: 0
   *         description: Number of results to skip
   *     responses:
   *       200:
   *         description: Execution summaries with stats
   *       401:
   *         description: Authentication required
   *       403:
   *         description: Admin access required
   *       500:
   *         description: Internal server error
   */
  app.get(
    buildServerPath('/api/admin/workflows/executions'),
    checkWorkflowsFeature,
    adminAuth,
    async (req, res) => {
      try {
        const { status, search, limit = 100, offset = 0 } = req.query;
        const registry = getExecutionRegistry();

        let executions;

        if (status === 'all' || status) {
          // Get all executions from the registry
          let allExecutions = Array.from(registry.executions.values()).map(e => ({ ...e }));

          // Apply status filter (unless 'all')
          if (status !== 'all') {
            allExecutions = allExecutions.filter(e => e.status === status);
          }

          // Apply search filter on userId or workflowName
          if (search) {
            const searchLower = search.toLowerCase();
            allExecutions = allExecutions.filter(e => {
              const userId = (e.userId || '').toLowerCase();
              const workflowName =
                typeof e.workflowName === 'object'
                  ? Object.values(e.workflowName).join(' ').toLowerCase()
                  : (e.workflowName || '').toLowerCase();
              const workflowId = (e.workflowId || '').toLowerCase();
              return (
                userId.includes(searchLower) ||
                workflowName.includes(searchLower) ||
                workflowId.includes(searchLower)
              );
            });
          }

          // Sort by startedAt descending (most recent first)
          allExecutions.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));

          // Apply pagination
          const parsedOffset = parseInt(offset, 10) || 0;
          const parsedLimit = parseInt(limit, 10) || 100;
          const total = allExecutions.length;
          executions = allExecutions.slice(parsedOffset, parsedOffset + parsedLimit);

          // Get stats from registry
          const stats = registry.getStats();

          res.json({
            executions,
            total,
            stats,
            offset: parsedOffset,
            limit: parsedLimit
          });
        } else {
          // Default behavior: return only active executions from WorkflowEngine
          const activeExecutions = await workflowEngine.listActiveExecutions();
          const stats = registry.getStats();

          res.json({
            executions: activeExecutions,
            total: activeExecutions.length,
            stats,
            offset: 0,
            limit: activeExecutions.length
          });
        }
      } catch (error) {
        sendFailedOperationError(res, 'fetch executions', error);
      }
    }
  );
}
