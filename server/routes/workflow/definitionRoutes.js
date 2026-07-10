/**
 * Workflow Definition Routes
 *
 * CRUD endpoints for workflow definitions (list, get, create, update, delete)
 * plus the user's own executions listing.
 *
 * @module routes/workflow/definitionRoutes
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { authRequired } from '../../middleware/authRequired.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { getExecutionRegistry } from '../../services/workflow/ExecutionRegistry.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import { getRootDir } from '../../pathUtils.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import {
  sendNotFound,
  sendBadRequest,
  sendFailedOperationError,
  sendInsufficientPermissions,
  sendErrorResponse
} from '../../utils/responseHelpers.js';
import logger from '../../utils/logger.js';
import configCache from '../../configCache.js';
import { removeMarketplaceInstallation } from '../../utils/installationCleanup.js';
import {
  checkWorkflowsFeature,
  filterByPermissions,
  loadWorkflows,
  findWorkflowFile,
  validateWorkflow
} from './workflowRouteHelpers.js';

/**
 * Registers workflow definition CRUD endpoints.
 *
 * @param {Express} app - Express application instance
 */
export default function registerDefinitionRoutes(app) {
  /**
   * @swagger
   * /api/workflows:
   *   get:
   *     summary: List available workflows
   *     description: |
   *       Retrieves all workflow definitions that the authenticated user has permission to access.
   *       Workflows are filtered based on the user's group memberships and the workflow's allowedGroups.
   *
   *       **Permission Filtering:**
   *       - Workflows without allowedGroups are accessible to all authenticated users
   *       - Workflows with allowedGroups are only shown to users in those groups
   *       - Admin users can see all workflows
   *     tags:
   *       - Workflows
   *     security:
   *       - bearerAuth: []
   *       - cookieAuth: []
   *     responses:
   *       200:
   *         description: List of accessible workflows
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 type: object
   *       401:
   *         description: Authentication required
   *       500:
   *         description: Internal server error
   */
  app.get(
    buildServerPath('/api/workflows'),
    checkWorkflowsFeature,
    authRequired,
    async (req, res) => {
      try {
        const workflows = await loadWorkflows();
        const filtered = filterByPermissions(workflows, req.user);

        res.json(filtered);
      } catch (error) {
        sendFailedOperationError(res, 'fetch workflows', error);
      }
    }
  );

  /**
   * @swagger
   * /api/workflows/my-executions:
   *   get:
   *     summary: List user's workflow executions
   *     description: |
   *       Retrieves all workflow executions started by the current user.
   *       Supports filtering by status and pagination.
   *     tags:
   *       - Workflows
   *       - Execution
   *     security:
   *       - bearerAuth: []
   *       - cookieAuth: []
   *     parameters:
   *       - in: query
   *         name: status
   *         schema:
   *           type: string
   *           enum: [pending, running, paused, completed, failed, cancelled]
   *         description: Filter by execution status
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *           default: 20
   *         description: Maximum number of results
   *       - in: query
   *         name: offset
   *         schema:
   *           type: integer
   *           default: 0
   *         description: Number of results to skip
   *     responses:
   *       200:
   *         description: List of user's executions
   *       401:
   *         description: Authentication required
   *       500:
   *         description: Internal server error
   */
  app.get(
    buildServerPath('/api/workflows/my-executions'),
    checkWorkflowsFeature,
    authRequired,
    async (req, res) => {
      try {
        const userId = req.user?.id || req.user?.sub || req.user?.username || 'anonymous';
        const { status, limit = 20, offset = 0, includeArchived } = req.query;

        const registry = getExecutionRegistry();
        const executions = registry.getByUser(userId, {
          status,
          includeArchived: includeArchived === 'true' || includeArchived === '1',
          limit: parseInt(limit, 10),
          offset: parseInt(offset, 10)
        });

        res.json(executions);
      } catch (error) {
        sendFailedOperationError(res, 'fetch user executions', error);
      }
    }
  );

  /**
   * @swagger
   * /api/workflows/{id}:
   *   get:
   *     summary: Get workflow definition
   *     description: |
   *       Retrieves a single workflow definition by ID.
   *       User must have permission to access the workflow.
   *     tags:
   *       - Workflows
   *     security:
   *       - bearerAuth: []
   *       - cookieAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         description: Unique identifier of the workflow
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Workflow definition
   *       401:
   *         description: Authentication required
   *       403:
   *         description: Access denied
   *       404:
   *         description: Workflow not found
   *       500:
   *         description: Internal server error
   */
  app.get(
    buildServerPath('/api/workflows/:id'),
    checkWorkflowsFeature,
    authRequired,
    async (req, res) => {
      try {
        const { id } = req.params;

        // Validate ID for security
        if (!validateIdForPath(id, 'workflow', res)) {
          return;
        }

        const workflows = await loadWorkflows();
        const workflow = workflows.find(w => w.id === id);

        if (!workflow) {
          return sendNotFound(res, 'Workflow');
        }

        // Check if user has permission to access this workflow
        const accessible = filterByPermissions([workflow], req.user);
        if (accessible.length === 0) {
          return sendInsufficientPermissions(res, 'workflow access');
        }

        res.json(workflow);
      } catch (error) {
        sendFailedOperationError(res, 'fetch workflow', error);
      }
    }
  );

  /**
   * @swagger
   * /api/workflows:
   *   post:
   *     summary: Create workflow (admin only)
   *     description: |
   *       Creates a new workflow definition.
   *       Requires admin privileges.
   *
   *       **Validation:**
   *       - Workflow must pass schema validation
   *       - Workflow ID must be unique
   *     tags:
   *       - Workflows
   *       - Admin
   *     security:
   *       - adminAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *     responses:
   *       201:
   *         description: Workflow created successfully
   *       400:
   *         description: Validation error
   *       401:
   *         description: Authentication required
   *       403:
   *         description: Admin access required
   *       409:
   *         description: Workflow with this ID already exists
   *       500:
   *         description: Internal server error
   */
  app.post(
    buildServerPath('/api/workflows'),
    checkWorkflowsFeature,
    adminAuth,
    async (req, res) => {
      try {
        const workflowData = req.body;

        // Validate workflow schema
        const validation = validateWorkflow(workflowData);
        if (!validation.success) {
          return sendBadRequest(res, 'Invalid workflow definition', validation.errors);
        }

        // Validate ID for security
        if (!validateIdForPath(workflowData.id, 'workflow', res)) {
          return;
        }

        // Check if workflow already exists
        const rootDir = getRootDir();
        const workflowsDir = join(rootDir, 'contents', 'workflows');
        await fs.mkdir(workflowsDir, { recursive: true });

        const existingFile = await findWorkflowFile(workflowData.id, workflowsDir);
        if (existingFile) {
          return sendErrorResponse(res, 409, 'Workflow with this ID already exists');
        }

        // Write workflow file
        const workflowPath = join(workflowsDir, `${workflowData.id}.json`);
        await atomicWriteJSON(workflowPath, validation.data);

        logger.info('Workflow created', {
          component: 'WorkflowRoutes',
          workflowId: workflowData.id
        });

        res.status(201).json({
          message: 'Workflow created successfully',
          workflow: validation.data
        });

        // Refresh workflow cache after successful creation
        configCache.refreshWorkflowsCache?.();
      } catch (error) {
        sendFailedOperationError(res, 'create workflow', error);
      }
    }
  );

  /**
   * @swagger
   * /api/workflows/{id}:
   *   put:
   *     summary: Update workflow (admin only)
   *     description: |
   *       Updates an existing workflow definition.
   *       Requires admin privileges.
   *
   *       **Validation:**
   *       - Workflow must pass schema validation
   *       - Workflow ID cannot be changed
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
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *     responses:
   *       200:
   *         description: Workflow updated successfully
   *       400:
   *         description: Validation error
   *       401:
   *         description: Authentication required
   *       403:
   *         description: Admin access required
   *       404:
   *         description: Workflow not found
   *       500:
   *         description: Internal server error
   */
  app.put(
    buildServerPath('/api/workflows/:id'),
    checkWorkflowsFeature,
    adminAuth,
    async (req, res) => {
      try {
        const { id } = req.params;
        const workflowData = req.body;

        // Validate ID for security
        if (!validateIdForPath(id, 'workflow', res)) {
          return;
        }

        // Validate workflow schema
        const validation = validateWorkflow(workflowData);
        if (!validation.success) {
          return sendBadRequest(res, 'Invalid workflow definition', validation.errors);
        }

        // Ensure ID cannot be changed
        if (workflowData.id !== id) {
          return sendBadRequest(res, 'Workflow ID cannot be changed');
        }

        // Find existing workflow file
        const rootDir = getRootDir();
        const workflowsDir = join(rootDir, 'contents', 'workflows');
        const filename = await findWorkflowFile(id, workflowsDir);

        if (!filename) {
          return sendNotFound(res, 'Workflow');
        }

        // Update workflow file
        const workflowPath = join(workflowsDir, filename);
        await atomicWriteJSON(workflowPath, validation.data);

        logger.info('Workflow updated', {
          component: 'WorkflowRoutes',
          workflowId: id
        });

        res.json({
          message: 'Workflow updated successfully',
          workflow: validation.data
        });

        // Refresh workflow cache after successful update
        configCache.refreshWorkflowsCache?.();
      } catch (error) {
        sendFailedOperationError(res, 'update workflow', error);
      }
    }
  );

  /**
   * @swagger
   * /api/workflows/{id}:
   *   delete:
   *     summary: Delete workflow (admin only)
   *     description: |
   *       Permanently deletes a workflow definition.
   *       Requires admin privileges.
   *
   *       **Warning:** This operation cannot be undone.
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
   *         description: Workflow deleted successfully
   *       401:
   *         description: Authentication required
   *       403:
   *         description: Admin access required
   *       404:
   *         description: Workflow not found
   *       500:
   *         description: Internal server error
   */
  app.delete(
    buildServerPath('/api/workflows/:id'),
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

        // Delete workflow file
        const workflowPath = join(workflowsDir, filename);
        await fs.unlink(workflowPath);

        logger.info('Workflow deleted', {
          component: 'WorkflowRoutes',
          workflowId: id
        });

        res.json({
          message: 'Workflow deleted successfully'
        });

        // Refresh workflow cache after successful deletion
        configCache.refreshWorkflowsCache?.();
        await removeMarketplaceInstallation('workflow', id);
      } catch (error) {
        sendFailedOperationError(res, 'delete workflow', error);
      }
    }
  );
}
