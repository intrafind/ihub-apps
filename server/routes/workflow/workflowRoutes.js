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
import { getExecutionRegistry } from '../../services/workflow/ExecutionRegistry.js';
import { HumanNodeExecutor } from '../../services/workflow/executors/HumanNodeExecutor.js';
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
import { filterResourcesByPermissions } from '../../utils/authorization.js';
import logger from '../../utils/logger.js';
import configCache from '../../configCache.js';

/**
 * Middleware to check if the experimental workflows feature is enabled.
 * Returns 403 if the feature is disabled.
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
function checkWorkflowsFeature(req, res, next) {
  const platform = configCache.getPlatform();
  if (platform?.features?.experimentalWorkflows !== true) {
    return res.status(403).json({
      error: 'Experimental workflows feature is not enabled',
      code: 'FEATURE_DISABLED'
    });
  }
  next();
}

/**
 * SSE clients map for workflow execution streaming
 * Maps executionId -> { response, lastActivity }
 * @type {Map<string, {response: object, lastActivity: Date}>}
 */
const workflowClients = new Map();

/**
 * Filters workflows based on user permissions from groups.json.
 * Uses the standard group-based permission system (permissions.workflows)
 * consistent with how apps, models, and prompts are handled.
 *
 * @param {Object[]} workflows - Array of workflow definitions
 * @param {Object} user - User object with groups and permissions
 * @returns {Object[]} Filtered array of accessible workflows
 */
function filterByPermissions(workflows, user) {
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

  // Recover persisted executions from disk on startup
  const registry = getExecutionRegistry();
  registry
    .loadFromDisk()
    .then(() => {
      // Mark previously-running executions as failed (server process died)
      for (const exec of registry.getActive()) {
        if (exec.status === 'running') {
          registry.updateStatus(exec.executionId, 'failed', { currentNode: null });
        }
      }
    })
    .catch(err => {
      logger.error({
        component: 'WorkflowRoutes',
        message: 'Failed to load execution registry from disk',
        error: err.message
      });
    });

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
  app.get(
    buildServerPath('/api/workflows', basePath),
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
    buildServerPath('/api/workflows/my-executions', basePath),
    checkWorkflowsFeature,
    authRequired,
    async (req, res) => {
      try {
        const userId = req.user?.id || req.user?.sub || req.user?.username || 'anonymous';
        const { status, limit = 20, offset = 0 } = req.query;

        const registry = getExecutionRegistry();
        const executions = registry.getByUser(userId, {
          status,
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
    buildServerPath('/api/workflows/:id', basePath),
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
    buildServerPath('/api/workflows', basePath),
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
    buildServerPath('/api/workflows/:id', basePath),
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

        logger.info({
          component: 'WorkflowRoutes',
          message: 'Workflow updated',
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
    buildServerPath('/api/workflows/:id', basePath),
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

        logger.info({
          component: 'WorkflowRoutes',
          message: 'Workflow deleted',
          workflowId: id
        });

        res.json({
          message: 'Workflow deleted successfully'
        });

        // Refresh workflow cache after successful deletion
        configCache.refreshWorkflowsCache?.();
      } catch (error) {
        sendFailedOperationError(res, 'delete workflow', error);
      }
    }
  );

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
    checkWorkflowsFeature,
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

        // Register with ExecutionRegistry for tracking
        const userId = req.user?.id || req.user?.username || 'anonymous';
        const registry = getExecutionRegistry();
        registry.register(state.executionId, {
          userId,
          workflowId: workflow.id,
          workflowName: workflow.name,
          status: state.status,
          startedAt: state.createdAt
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
    checkWorkflowsFeature,
    authRequired,
    async (req, res) => {
      try {
        const { executionId } = req.params;

        const state = await workflowEngine.getState(executionId);

        if (!state) {
          return sendNotFound(res, 'Execution');
        }

        // Determine if execution can be reconnected (streaming)
        const canReconnect = state.status === 'running' || state.status === 'paused';

        // Get pending human checkpoint if any
        const pendingCheckpoint = state.data?.pendingCheckpoint || null;

        // Get workflow name if available
        const workflowName = state.data?._workflowDefinition?.name || null;

        // Return state with reconnection info
        res.json({
          executionId: state.executionId,
          workflowId: state.workflowId,
          workflowName,
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
          })),
          // Include full data for node results display
          data: state.data,
          // Reconnection info
          canReconnect,
          pendingCheckpoint
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
    checkWorkflowsFeature,
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
    checkWorkflowsFeature,
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
  // Export Endpoint
  // ============================================================================

  /**
   * @swagger
   * /api/workflows/executions/{executionId}/export:
   *   get:
   *     summary: Export execution state as JSON
   *     description: |
   *       Downloads the complete workflow execution state as a JSON file.
   *       Useful for debugging and analysis of workflow execution.
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
   *         description: Execution state JSON file
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *       401:
   *         description: Authentication required
   *       404:
   *         description: Execution not found
   *       500:
   *         description: Internal server error
   */
  app.get(
    buildServerPath('/api/workflows/executions/:executionId/export', basePath),
    checkWorkflowsFeature,
    authRequired,
    async (req, res) => {
      try {
        const { executionId } = req.params;

        const state = await workflowEngine.getState(executionId);

        if (!state) {
          return sendNotFound(res, 'Execution');
        }

        // Build export object with all relevant state data
        const exportData = {
          executionId: state.executionId,
          workflowId: state.workflowId,
          status: state.status,
          data: state.data,
          history: state.history,
          completedNodes: state.completedNodes,
          currentNodes: state.currentNodes,
          failedNodes: state.failedNodes,
          errors: state.errors,
          checkpoints: state.checkpoints,
          timestamps: {
            created: state.createdAt,
            started: state.startedAt,
            completed: state.completedAt
          },
          exportedAt: new Date().toISOString()
        };

        // Set headers for file download
        res.setHeader('Content-Type', 'application/json');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="workflow-${executionId.slice(0, 8)}.json"`
        );

        res.json(exportData);

        logger.info({
          component: 'WorkflowRoutes',
          message: 'Workflow execution exported',
          executionId,
          userId: req.user?.id
        });
      } catch (error) {
        sendFailedOperationError(res, 'export execution state', error);
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
    buildServerPath('/api/workflows/executions/:executionId/stream'),
    checkWorkflowsFeature,
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
        'workflow.iteration',
        'workflow.node.start',
        'workflow.node.complete',
        'workflow.node.error',
        'workflow.paused',
        'workflow.human.required',
        'workflow.human.responded',
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

        // Log event details for debugging
        logger.debug({
          component: 'WorkflowRoutes',
          message: 'Sending SSE event to client',
          executionId,
          eventType,
          nodeId: eventData.nodeId,
          iteration: eventData.iteration
        });

        try {
          // Send event to client
          res.write(`event: ${eventType}\ndata: ${JSON.stringify(eventData)}\n\n`);

          // Log successful send for important events
          if (eventType === 'workflow.node.complete' || eventType === 'workflow.complete') {
            logger.info({
              component: 'WorkflowRoutes',
              message: `SSE event sent: ${eventType}`,
              executionId,
              nodeId: eventData.nodeId
            });
          }
        } catch (err) {
          logger.error({
            component: 'WorkflowRoutes',
            message: 'Error sending SSE event',
            executionId,
            eventType,
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
  // Human Checkpoint Response Endpoint
  // ============================================================================

  /**
   * @swagger
   * /api/workflows/executions/{executionId}/respond:
   *   post:
   *     summary: Respond to human checkpoint
   *     description: |
   *       Provides a response to a human checkpoint (approval/input) node.
   *       This will resume the paused workflow with the provided response.
   *
   *       **Response Object:**
   *       - checkpointId: ID of the checkpoint being responded to (required)
   *       - response: Selected option value (required)
   *       - data: Optional additional form data if the checkpoint has an inputSchema
   *     tags:
   *       - Workflows
   *       - Execution
   *       - Human Checkpoint
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
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - checkpointId
   *               - response
   *             properties:
   *               checkpointId:
   *                 type: string
   *                 description: ID of the checkpoint being responded to
   *               response:
   *                 type: string
   *                 description: Selected option value
   *               data:
   *                 type: object
   *                 description: Additional form data
   *     responses:
   *       200:
   *         description: Response accepted, workflow resumed
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 success:
   *                   type: boolean
   *                 newStatus:
   *                   type: string
   *       400:
   *         description: Invalid response or checkpoint not found
   *       401:
   *         description: Authentication required
   *       404:
   *         description: Execution not found
   *       500:
   *         description: Internal server error
   */
  app.post(
    buildServerPath('/api/workflows/executions/:executionId/respond', basePath),
    checkWorkflowsFeature,
    authRequired,
    async (req, res) => {
      try {
        const { executionId } = req.params;
        const { checkpointId, response, data } = req.body || {};

        // Validate required fields
        if (!checkpointId) {
          return sendBadRequest(res, 'checkpointId is required');
        }

        if (!response) {
          return sendBadRequest(res, 'response is required');
        }

        // Get current execution state
        const state = await workflowEngine.getState(executionId);

        if (!state) {
          return sendNotFound(res, 'Execution');
        }

        // Verify execution is paused with a pending checkpoint
        if (state.status !== 'paused') {
          return sendBadRequest(res, `Cannot respond to execution with status: ${state.status}`);
        }

        // Check if there's a pending checkpoint
        const pendingCheckpoint = state.data?.pendingCheckpoint;
        if (!pendingCheckpoint) {
          return sendBadRequest(res, 'No pending checkpoint for this execution');
        }

        // Verify checkpoint ID matches
        if (pendingCheckpoint.id !== checkpointId) {
          return sendBadRequest(res, 'Checkpoint ID does not match pending checkpoint');
        }

        // Get the workflow and node for resuming
        const workflow = state.data?._workflowDefinition;
        if (!workflow) {
          return sendBadRequest(res, 'Workflow definition not available for resume');
        }

        const humanNode = workflow.nodes.find(n => n.id === pendingCheckpoint.nodeId);
        if (!humanNode) {
          return sendBadRequest(res, 'Human node not found in workflow');
        }

        // Use HumanNodeExecutor to process the response
        const humanExecutor = new HumanNodeExecutor();
        const resumeResult = await humanExecutor.resume(
          humanNode,
          state,
          { checkpointId, response, data },
          { executionId, user: req.user }
        );

        if (resumeResult.status === 'failed') {
          return sendBadRequest(res, resumeResult.error || 'Failed to process response');
        }

        // Update execution registry
        const registry = getExecutionRegistry();
        registry.clearPendingCheckpoint(executionId);

        // Get the scheduler to determine next nodes based on branch
        const scheduler = workflowEngine.scheduler;
        const branch = resumeResult.branch;

        // Build a result object that the scheduler can use for routing
        const humanResult = {
          branch,
          response,
          ...resumeResult.output
        };

        // Get next nodes based on the human response branch
        const nextNodes = scheduler.getNextNodes(humanNode.id, humanResult, workflow, state);

        logger.info({
          component: 'WorkflowRoutes',
          message: 'Human checkpoint routing',
          executionId,
          humanNodeId: humanNode.id,
          response,
          branch,
          nextNodes
        });

        // Resume the workflow with the human response and routing info
        const resumeData = {
          ...resumeResult.stateUpdates,
          // Store the human response for edge condition evaluation
          [`_humanResult_${humanNode.id}`]: humanResult
        };

        // Update state to mark human node as completed and set next nodes
        await workflowEngine.stateManager.update(executionId, {
          completedNodes: [...(state.completedNodes || []), humanNode.id],
          currentNodes: nextNodes,
          data: {
            ...state.data,
            ...resumeData,
            nodeResults: {
              ...(state.data?.nodeResults || {}),
              [humanNode.id]: humanResult
            }
          }
        });

        const newState = await workflowEngine.resume(
          executionId,
          {},
          {
            user: req.user,
            workflow
          }
        );

        logger.info({
          component: 'WorkflowRoutes',
          message: 'Human checkpoint responded',
          executionId,
          checkpointId,
          response,
          userId: req.user?.id
        });

        res.json({
          success: true,
          newStatus: newState.status,
          executionId: newState.executionId
        });
      } catch (error) {
        if (error.code === 'EXECUTION_NOT_FOUND') {
          return sendNotFound(res, 'Execution');
        }
        if (error.code === 'INVALID_STATE_FOR_RESUME') {
          return sendBadRequest(res, error.message);
        }

        sendFailedOperationError(res, 'respond to checkpoint', error);
      }
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
  app.get(
    buildServerPath('/api/admin/workflows', basePath),
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
    buildServerPath('/api/admin/workflows/:id/toggle', basePath),
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
    buildServerPath('/api/admin/workflows/executions', basePath),
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
          if (status && status !== 'all') {
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

  return {
    workflowEngine,
    workflowClients
  };
}

// Export helper functions for testing
export { filterByPermissions, isAdmin, loadWorkflows, findWorkflowFile, validateWorkflow };
