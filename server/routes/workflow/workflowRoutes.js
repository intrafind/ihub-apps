/**
 * Workflow API Routes
 *
 * Provides RESTful endpoints for managing and executing agentic workflows.
 * Includes support for workflow CRUD operations, execution control, and
 * real-time progress streaming via Server-Sent Events (SSE).
 *
 * @module routes/workflow/workflowRoutes
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { authRequired } from '../../middleware/authRequired.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { WorkflowEngine } from '../../services/workflow/WorkflowEngine.js';
import { actionTracker } from '../../actionTracker.js';
import { workflowConfigSchema } from '../../validators/workflowConfigSchema.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import { getRootDir } from '../../pathUtils.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import {
  sendNotFound,
  sendBadRequest,
  sendFailedOperationError,
  sendInsufficientPermissions
} from '../../utils/responseHelpers.js';
import logger from '../../utils/logger.js';

/**
 * SSE clients map for workflow execution streaming
 * Maps executionId -> { response, lastActivity }
 * @type {Map<string, {response: object, lastActivity: Date}>}
 */
const workflowClients = new Map();

/**
 * Filters workflows based on user permissions.
 * A workflow is accessible if:
 * - It has no allowedGroups defined (public)
 * - The user belongs to at least one of the allowed groups
 * - The user has admin permissions
 *
 * @param {Object[]} workflows - Array of workflow definitions
 * @param {Object} user - User object with groups and permissions
 * @returns {Object[]} Filtered array of accessible workflows
 */
function filterByPermissions(workflows, user) {
  if (!Array.isArray(workflows)) {
    return [];
  }

  return workflows.filter(workflow => {
    // If no allowedGroups defined, workflow is accessible to all authenticated users
    if (!workflow.allowedGroups || workflow.allowedGroups.length === 0) {
      return true;
    }

    // If user has no groups, deny access to restricted workflows
    if (!user?.groups || !Array.isArray(user.groups)) {
      return false;
    }

    // Check if user has admin access (admins can see all workflows)
    const hasAdminAccess = user.groups.includes('admin') || user.permissions?.adminAccess === true;
    if (hasAdminAccess) {
      return true;
    }

    // Check if user belongs to any of the allowed groups
    return workflow.allowedGroups.some(group => user.groups.includes(group));
  });
}

/**
 * Checks if a user has admin privileges.
 *
 * @param {Object} user - User object from request
 * @returns {boolean} True if user has admin access
 */
function isAdmin(user) {
  if (!user) return false;
  return user.groups?.includes('admin') || user.permissions?.adminAccess === true;
}

/**
 * Loads all workflow definitions from the filesystem.
 * Workflows are stored as individual JSON files in contents/workflows/
 *
 * @param {boolean} includeDisabled - Whether to include disabled workflows
 * @returns {Promise<Object[]>} Array of workflow definitions
 */
async function loadWorkflows(includeDisabled = false) {
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
      } catch (err) {
        logger.warn({
          component: 'WorkflowRoutes',
          message: 'Failed to load workflow file',
          file,
          error: err.message
        });
      }
    }

    return workflows;
  } catch (err) {
    logger.error({
      component: 'WorkflowRoutes',
      message: 'Failed to read workflows directory',
      error: err.message
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
async function findWorkflowFile(workflowId, workflowsDir) {
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
      } catch (err) {
        // Skip files that can't be read or parsed
        logger.debug({
          component: 'WorkflowRoutes',
          message: 'Skipping malformed workflow file',
          file,
          error: err.message
        });
      }
    }

    return null;
  } catch (err) {
    logger.warn({
      component: 'WorkflowRoutes',
      message: 'Failed to read workflows directory',
      workflowsDir,
      error: err.message
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
function validateWorkflow(workflow) {
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
  } catch (err) {
    return {
      success: false,
      errors: [{ path: '', message: err.message }]
    };
  }
}

/**
 * Registers all workflow-related API routes.
 *
 * @param {Express} app - Express application instance
 * @param {Object} deps - Dependencies and configuration
 * @param {string} deps.basePath - Base path for API routes
 * @param {WorkflowEngine} deps.workflowEngine - Optional custom workflow engine instance
 */
export default function registerWorkflowRoutes(app, deps = {}) {
  const { basePath = '' } = deps;
  const workflowEngine = deps.workflowEngine || new WorkflowEngine();

  // ============================================================================
  // Workflow Definition Endpoints
  // ============================================================================

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
  app.get(buildServerPath('/api/workflows', basePath), authRequired, async (req, res) => {
    try {
      const workflows = await loadWorkflows();
      const filtered = filterByPermissions(workflows, req.user);

      res.json(filtered);
    } catch (error) {
      sendFailedOperationError(res, 'fetch workflows', error);
    }
  });

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
  app.get(buildServerPath('/api/workflows/:id', basePath), authRequired, async (req, res) => {
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
  });

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
  app.post(buildServerPath('/api/workflows', basePath), adminAuth, async (req, res) => {
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
        return res.status(409).json({ error: 'Workflow with this ID already exists' });
      }

      // Write workflow file
      const workflowPath = join(workflowsDir, `${workflowData.id}.json`);
      await atomicWriteJSON(workflowPath, validation.data);

      logger.info({
        component: 'WorkflowRoutes',
        message: 'Workflow created',
        workflowId: workflowData.id
      });

      res.status(201).json({
        message: 'Workflow created successfully',
        workflow: validation.data
      });
    } catch (error) {
      sendFailedOperationError(res, 'create workflow', error);
    }
  });

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
  app.put(buildServerPath('/api/workflows/:id', basePath), adminAuth, async (req, res) => {
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

      logger.info({
        component: 'WorkflowRoutes',
        message: 'Workflow updated',
        workflowId: id
      });

      res.json({
        message: 'Workflow updated successfully',
        workflow: validation.data
      });
    } catch (error) {
      sendFailedOperationError(res, 'update workflow', error);
    }
  });

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
  app.delete(buildServerPath('/api/workflows/:id', basePath), adminAuth, async (req, res) => {
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

      logger.info({
        component: 'WorkflowRoutes',
        message: 'Workflow deleted',
        workflowId: id
      });

      res.json({
        message: 'Workflow deleted successfully'
      });
    } catch (error) {
      sendFailedOperationError(res, 'delete workflow', error);
    }
  });

  // ============================================================================
  // Workflow Execution Endpoints
  // ============================================================================

  /**
   * @swagger
   * /api/workflows/{id}/execute:
   *   post:
   *     summary: Start workflow execution
   *     description: |
   *       Starts a new execution of the specified workflow.
   *       Returns an execution ID that can be used to monitor progress.
   *
   *       **Initial Data:**
   *       The initialData object is passed to the workflow as starting context.
   *       It can contain any data needed by the workflow's nodes.
   *
   *       **Options:**
   *       - checkpointOnNode: Create checkpoint after each node execution
   *       - timeout: Override default node execution timeout
   *     tags:
   *       - Workflows
   *       - Execution
   *     security:
   *       - bearerAuth: []
   *       - cookieAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: false
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               initialData:
   *                 type: object
   *                 description: Initial data/context for the workflow
   *               options:
   *                 type: object
   *                 properties:
   *                   checkpointOnNode:
   *                     type: boolean
   *                   timeout:
   *                     type: number
   *     responses:
   *       200:
   *         description: Execution started
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 executionId:
   *                   type: string
   *                 status:
   *                   type: string
   *       401:
   *         description: Authentication required
   *       403:
   *         description: Access denied
   *       404:
   *         description: Workflow not found
   *       500:
   *         description: Internal server error
   */
  app.post(
    buildServerPath('/api/workflows/:id/execute', basePath),
    authRequired,
    async (req, res) => {
      try {
        const { id } = req.params;
        const { initialData = {}, options = {} } = req.body || {};

        // Validate ID for security
        if (!validateIdForPath(id, 'workflow', res)) {
          return;
        }

        // Load and validate workflow access
        const workflows = await loadWorkflows();
        const workflow = workflows.find(w => w.id === id);

        if (!workflow) {
          return sendNotFound(res, 'Workflow');
        }

        // Check if user has permission to execute this workflow
        const accessible = filterByPermissions([workflow], req.user);
        if (accessible.length === 0) {
          return sendInsufficientPermissions(res, 'workflow execution');
        }

        // Store workflow definition in initial data for resume support
        const enrichedInitialData = {
          ...initialData,
          _workflowDefinition: workflow
        };

        // Start workflow execution
        const state = await workflowEngine.start(workflow, enrichedInitialData, {
          ...options,
          user: req.user
        });

        logger.info({
          component: 'WorkflowRoutes',
          message: 'Workflow execution started',
          workflowId: id,
          executionId: state.executionId,
          userId: req.user?.id
        });

        res.json({
          executionId: state.executionId,
          status: state.status,
          workflowId: workflow.id,
          startedAt: state.createdAt
        });
      } catch (error) {
        // Handle specific workflow errors
        if (error.code === 'WORKFLOW_CYCLE_DETECTED' || error.code === 'WORKFLOW_NO_START_NODE') {
          return sendBadRequest(res, error.message);
        }

        sendFailedOperationError(res, 'start workflow execution', error);
      }
    }
  );

  /**
   * @swagger
   * /api/workflows/executions/{executionId}:
   *   get:
   *     summary: Get execution state
   *     description: |
   *       Retrieves the current state of a workflow execution.
   *       Returns detailed information including status, current nodes,
   *       completed nodes, execution history, and any errors.
   *     tags:
   *       - Workflows
   *       - Execution
   *     security:
   *       - bearerAuth: []
   *       - cookieAuth: []
   *     parameters:
   *       - in: path
   *         name: executionId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Execution state
   *       401:
   *         description: Authentication required
   *       404:
   *         description: Execution not found
   *       500:
   *         description: Internal server error
   */
  app.get(
    buildServerPath('/api/workflows/executions/:executionId', basePath),
    authRequired,
    async (req, res) => {
      try {
        const { executionId } = req.params;

        const state = await workflowEngine.getState(executionId);

        if (!state) {
          return sendNotFound(res, 'Execution');
        }

        // Return state without sensitive internal data
        res.json({
          executionId: state.executionId,
          workflowId: state.workflowId,
          status: state.status,
          currentNodes: state.currentNodes,
          completedNodes: state.completedNodes,
          failedNodes: state.failedNodes,
          createdAt: state.createdAt,
          startedAt: state.startedAt,
          completedAt: state.completedAt,
          history: state.history,
          errors: state.errors,
          checkpoints: state.checkpoints?.map(cp => ({
            id: cp.id,
            timestamp: cp.timestamp
          }))
        });
      } catch (error) {
        sendFailedOperationError(res, 'fetch execution state', error);
      }
    }
  );

  /**
   * @swagger
   * /api/workflows/executions/{executionId}/resume:
   *   post:
   *     summary: Resume paused workflow
   *     description: |
   *       Resumes a paused workflow execution.
   *       Can optionally include data to merge into the workflow context,
   *       such as human responses for human-in-the-loop nodes.
   *
   *       **Resume Data:**
   *       - humanResponse: Response from human-in-the-loop interaction
   *       - Additional context data as needed
   *
   *       **Checkpoint:**
   *       If checkpointId is provided, execution resumes from that checkpoint
   *       instead of the current state.
   *     tags:
   *       - Workflows
   *       - Execution
   *     security:
   *       - bearerAuth: []
   *       - cookieAuth: []
   *     parameters:
   *       - in: path
   *         name: executionId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: false
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               humanResponse:
   *                 description: Response data for human-in-the-loop nodes
   *               checkpointId:
   *                 type: string
   *                 description: Optional checkpoint ID to resume from
   *     responses:
   *       200:
   *         description: Execution resumed
   *       400:
   *         description: Cannot resume - invalid state
   *       401:
   *         description: Authentication required
   *       404:
   *         description: Execution not found
   *       500:
   *         description: Internal server error
   */
  app.post(
    buildServerPath('/api/workflows/executions/:executionId/resume', basePath),
    authRequired,
    async (req, res) => {
      try {
        const { executionId } = req.params;
        const { humanResponse, checkpointId, ...additionalData } = req.body || {};

        // Build resume data
        const resumeData = {
          ...additionalData
        };

        if (humanResponse !== undefined) {
          resumeData._humanResponse = humanResponse;
        }

        // Resume options
        const options = {
          user: req.user
        };

        if (checkpointId) {
          options.checkpointId = checkpointId;
        }

        const state = await workflowEngine.resume(executionId, resumeData, options);

        logger.info({
          component: 'WorkflowRoutes',
          message: 'Workflow execution resumed',
          executionId,
          userId: req.user?.id
        });

        res.json({
          executionId: state.executionId,
          status: state.status,
          currentNodes: state.currentNodes
        });
      } catch (error) {
        // Handle specific workflow errors
        if (
          error.code === 'EXECUTION_NOT_FOUND' ||
          error.code === 'INVALID_STATE_FOR_RESUME' ||
          error.code === 'WORKFLOW_NOT_AVAILABLE'
        ) {
          if (error.code === 'EXECUTION_NOT_FOUND') {
            return sendNotFound(res, 'Execution');
          }
          return sendBadRequest(res, error.message);
        }

        sendFailedOperationError(res, 'resume workflow execution', error);
      }
    }
  );

  /**
   * @swagger
   * /api/workflows/executions/{executionId}/cancel:
   *   post:
   *     summary: Cancel execution
   *     description: |
   *       Cancels a running or paused workflow execution.
   *       The execution status will be set to 'cancelled'.
   *
   *       **Note:** Already completed or cancelled executions cannot be cancelled.
   *     tags:
   *       - Workflows
   *       - Execution
   *     security:
   *       - bearerAuth: []
   *       - cookieAuth: []
   *     parameters:
   *       - in: path
   *         name: executionId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: false
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               reason:
   *                 type: string
   *                 description: Reason for cancellation
   *     responses:
   *       200:
   *         description: Execution cancelled
   *       401:
   *         description: Authentication required
   *       404:
   *         description: Execution not found
   *       500:
   *         description: Internal server error
   */
  app.post(
    buildServerPath('/api/workflows/executions/:executionId/cancel', basePath),
    authRequired,
    async (req, res) => {
      try {
        const { executionId } = req.params;
        const { reason = 'user_cancelled' } = req.body || {};

        const state = await workflowEngine.cancel(executionId, reason);

        logger.info({
          component: 'WorkflowRoutes',
          message: 'Workflow execution cancelled',
          executionId,
          reason,
          userId: req.user?.id
        });

        res.json({
          success: true,
          executionId: state.executionId,
          status: state.status
        });
      } catch (error) {
        if (error.code === 'EXECUTION_NOT_FOUND') {
          return sendNotFound(res, 'Execution');
        }

        sendFailedOperationError(res, 'cancel workflow execution', error);
      }
    }
  );

  // ============================================================================
  // SSE Streaming Endpoint
  // ============================================================================

  /**
   * @swagger
   * /api/workflows/executions/{executionId}/stream:
   *   get:
   *     summary: SSE event stream for workflow progress
   *     description: |
   *       Establishes a Server-Sent Events connection to receive real-time
   *       updates about workflow execution progress.
   *
   *       **Events:**
   *       - workflow.start: Workflow execution started
   *       - workflow.node.start: Node execution started
   *       - workflow.node.complete: Node execution completed
   *       - workflow.node.error: Node execution failed
   *       - workflow.paused: Workflow paused (e.g., for human input)
   *       - workflow.complete: Workflow completed successfully
   *       - workflow.failed: Workflow execution failed
   *       - workflow.cancelled: Workflow was cancelled
   *       - workflow.checkpoint.saved: Checkpoint was saved
   *     tags:
   *       - Workflows
   *       - Execution
   *       - Streaming
   *     security:
   *       - bearerAuth: []
   *       - cookieAuth: []
   *     parameters:
   *       - in: path
   *         name: executionId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: SSE stream established
   *         content:
   *           text/event-stream:
   *             schema:
   *               type: string
   *       401:
   *         description: Authentication required
   *       500:
   *         description: Internal server error
   */
  app.get(
    buildServerPath('/api/workflows/executions/:executionId/stream', basePath),
    authRequired,
    (req, res) => {
      const { executionId } = req.params;

      // Set up SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

      // Store client connection
      workflowClients.set(executionId, {
        response: res,
        lastActivity: new Date()
      });

      // Send initial connection event
      res.write(`event: connected\ndata: ${JSON.stringify({ executionId })}\n\n`);

      logger.info({
        component: 'WorkflowRoutes',
        message: 'SSE connection established for workflow execution',
        executionId
      });

      // Define event types to listen for
      const workflowEventTypes = [
        'workflow.start',
        'workflow.node.start',
        'workflow.node.complete',
        'workflow.node.error',
        'workflow.paused',
        'workflow.complete',
        'workflow.failed',
        'workflow.cancelled',
        'workflow.checkpoint.saved'
      ];

      /**
       * Handler for workflow events from actionTracker
       * @param {Object} eventData - Event data
       */
      const handleWorkflowEvent = eventData => {
        // Only forward events for this execution
        if (eventData.chatId !== executionId && eventData.executionId !== executionId) {
          return;
        }

        // Extract event type from the event data
        const eventType = eventData.event;

        // Check if this is a workflow event we care about
        if (!workflowEventTypes.some(type => eventType === type || eventType.startsWith(type))) {
          return;
        }

        // Update last activity timestamp
        const client = workflowClients.get(executionId);
        if (client) {
          client.lastActivity = new Date();
        }

        try {
          // Send event to client
          res.write(`event: ${eventType}\ndata: ${JSON.stringify(eventData)}\n\n`);
        } catch (err) {
          logger.error({
            component: 'WorkflowRoutes',
            message: 'Error sending SSE event',
            executionId,
            error: err.message
          });
        }
      };

      // Register event handler
      actionTracker.on('fire-sse', handleWorkflowEvent);

      // Handle client disconnect
      req.on('close', () => {
        // Remove event listener
        actionTracker.off('fire-sse', handleWorkflowEvent);

        // Remove client from map
        workflowClients.delete(executionId);

        logger.info({
          component: 'WorkflowRoutes',
          message: 'SSE connection closed for workflow execution',
          executionId
        });
      });

      // Send periodic heartbeat to keep connection alive
      const heartbeatInterval = setInterval(() => {
        if (!workflowClients.has(executionId)) {
          clearInterval(heartbeatInterval);
          return;
        }

        try {
          res.write(`: heartbeat\n\n`);
        } catch (_err) {
          clearInterval(heartbeatInterval);
          workflowClients.delete(executionId);
        }
      }, 30000); // 30 second heartbeat

      // Clean up heartbeat on disconnect
      req.on('close', () => {
        clearInterval(heartbeatInterval);
      });
    }
  );

  // ============================================================================
  // Admin Endpoints
  // ============================================================================

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
  app.get(buildServerPath('/api/admin/workflows', basePath), adminAuth, async (req, res) => {
    try {
      const workflows = await loadWorkflows(true); // Include disabled
      res.json(workflows);
    } catch (error) {
      sendFailedOperationError(res, 'fetch workflows', error);
    }
  });

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
    buildServerPath('/api/admin/workflows/:id/toggle', basePath),
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

        logger.info({
          component: 'WorkflowRoutes',
          message: `Workflow ${newEnabledState ? 'enabled' : 'disabled'}`,
          workflowId: id
        });

        res.json({
          message: `Workflow ${newEnabledState ? 'enabled' : 'disabled'} successfully`,
          workflow,
          enabled: newEnabledState
        });
      } catch (error) {
        sendFailedOperationError(res, 'toggle workflow', error);
      }
    }
  );

  /**
   * @swagger
   * /api/admin/workflows/executions:
   *   get:
   *     summary: List all active executions (admin view)
   *     description: |
   *       Retrieves summaries of all active workflow executions.
   *       Admin access required.
   *     tags:
   *       - Workflows
   *       - Admin
   *       - Execution
   *     security:
   *       - adminAuth: []
   *     responses:
   *       200:
   *         description: Active execution summaries
   *       401:
   *         description: Authentication required
   *       403:
   *         description: Admin access required
   *       500:
   *         description: Internal server error
   */
  app.get(
    buildServerPath('/api/admin/workflows/executions', basePath),
    adminAuth,
    async (req, res) => {
      try {
        const executions = await workflowEngine.listActiveExecutions();
        res.json(executions);
      } catch (error) {
        sendFailedOperationError(res, 'fetch active executions', error);
      }
    }
  );

  return {
    workflowEngine,
    workflowClients
  };
}

// Export helper functions for testing
export { filterByPermissions, isAdmin, loadWorkflows, findWorkflowFile, validateWorkflow };
