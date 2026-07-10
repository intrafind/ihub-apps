/**
 * Workflow Execution Routes
 *
 * Endpoints covering the execution lifecycle of a workflow run: start,
 * inspect, resume, restart, cancel, delete/archive, and export.
 *
 * @module routes/workflow/executionRoutes
 */

import { authRequired } from '../../middleware/authRequired.js';
import { buildServerPath } from '../../utils/basePath.js';
import { getExecutionRegistry } from '../../services/workflow/ExecutionRegistry.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import {
  sendNotFound,
  sendBadRequest,
  sendFailedOperationError,
  sendInsufficientPermissions
} from '../../utils/responseHelpers.js';
import logger from '../../utils/logger.js';
import {
  checkWorkflowsFeature,
  filterByPermissions,
  isAdmin,
  buildInputPreview,
  buildModelsList,
  loadWorkflows
} from './workflowRouteHelpers.js';

/**
 * Registers workflow execution lifecycle endpoints, and kicks off recovery
 * of persisted executions from disk on startup.
 *
 * @param {Express} app - Express application instance
 * @param {Object} deps - Dependencies
 * @param {WorkflowEngine} deps.workflowEngine - Shared workflow engine instance
 */
export default function registerExecutionRoutes(app, deps = {}) {
  const { workflowEngine } = deps;

  // Recover persisted executions from disk on startup
  const registry = getExecutionRegistry();
  (async () => {
    try {
      await registry.loadFromDisk();
      // Mark previously-running executions as failed (server process died)
      for (const exec of registry.getActive()) {
        if (exec.status === 'running') {
          registry.updateStatus(exec.executionId, 'failed', { currentNode: null });
        }
      }
    } catch (error) {
      logger.error('Failed to load execution registry from disk', {
        component: 'WorkflowRoutes',
        error: error.message
      });
    }
  })();

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
    buildServerPath('/api/workflows/:id/execute'),
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
          startedAt: state.createdAt,
          inputPreview: buildInputPreview(initialData),
          models: buildModelsList(workflow)
        });

        logger.info('Workflow execution started', {
          component: 'WorkflowRoutes',
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
    buildServerPath('/api/workflows/executions/:executionId'),
    checkWorkflowsFeature,
    authRequired,
    async (req, res) => {
      try {
        const { executionId } = req.params;

        if (!validateIdForPath(executionId, 'executionId')) {
          return sendBadRequest(res, 'Invalid executionId');
        }

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
    buildServerPath('/api/workflows/executions/:executionId/resume'),
    checkWorkflowsFeature,
    authRequired,
    async (req, res) => {
      try {
        const { executionId } = req.params;
        const { humanResponse, checkpointId, ...additionalData } = req.body || {};

        if (!validateIdForPath(executionId, 'executionId')) {
          return sendBadRequest(res, 'Invalid executionId');
        }

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

        logger.info('Workflow execution resumed', {
          component: 'WorkflowRoutes',
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
   * /api/workflows/executions/{executionId}/restart:
   *   post:
   *     summary: Restart a cancelled or failed execution
   *     description: |
   *       Resumes a workflow that was cancelled by timeout/server restart or
   *       failed mid-execution. Previously-completed nodes are not re-run;
   *       only the interrupted nodes (those in `currentNodes`) are picked up.
   *       User-cancelled executions are refused.
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
   */
  app.post(
    buildServerPath('/api/workflows/executions/:executionId/restart'),
    checkWorkflowsFeature,
    authRequired,
    async (req, res) => {
      try {
        const { executionId } = req.params;
        if (!validateIdForPath(executionId, 'executionId')) {
          return sendBadRequest(res, 'Invalid executionId');
        }

        const state = await workflowEngine.resumeFromTerminated(executionId, {
          user: req.user
        });

        logger.info('Workflow execution restarted from terminated state', {
          component: 'WorkflowRoutes',
          executionId,
          userId: req.user?.id
        });

        res.json({
          executionId: state.executionId,
          status: state.status,
          currentNodes: state.currentNodes
        });
      } catch (error) {
        if (error.code === 'EXECUTION_NOT_FOUND') {
          return sendNotFound(res, 'Execution');
        }
        if (
          error.code === 'INVALID_STATE_FOR_RESUME' ||
          error.code === 'WORKFLOW_NOT_AVAILABLE' ||
          error.code === 'NO_RESUME_POINT' ||
          error.code === 'USER_CANCELLED'
        ) {
          return sendBadRequest(res, error.message);
        }
        sendFailedOperationError(res, 'restart workflow execution', error);
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
    buildServerPath('/api/workflows/executions/:executionId/cancel'),
    checkWorkflowsFeature,
    authRequired,
    async (req, res) => {
      try {
        const { executionId } = req.params;
        const { reason = 'user_cancelled' } = req.body || {};

        if (!validateIdForPath(executionId, 'executionId')) {
          return sendBadRequest(res, 'Invalid executionId');
        }

        const state = await workflowEngine.cancel(executionId, reason);

        logger.info('Workflow execution cancelled', {
          component: 'WorkflowRoutes',
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

  /**
   * @swagger
   * /api/workflows/executions/{executionId}:
   *   delete:
   *     summary: Hard-delete an execution
   *     description: |
   *       Removes a workflow execution from the registry and deletes its
   *       checkpoint files on disk. Owner-only (or admin). Refuses to delete
   *       a running execution — cancel it first.
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
   *         description: Execution deleted
   *       403:
   *         description: Not the owner and not an admin
   *       404:
   *         description: Execution not found
   *       409:
   *         description: Execution is still running
   */
  app.delete(
    buildServerPath('/api/workflows/executions/:executionId'),
    checkWorkflowsFeature,
    authRequired,
    async (req, res) => {
      try {
        const { executionId } = req.params;

        if (!validateIdForPath(executionId, 'executionId')) {
          return sendBadRequest(res, 'Invalid executionId');
        }

        const registry = getExecutionRegistry();
        const execution = registry.get(executionId);

        if (!execution) {
          return sendNotFound(res, 'Execution');
        }

        const currentUserId = req.user?.id || req.user?.sub || req.user?.username || 'anonymous';
        if (execution.userId !== currentUserId && !isAdmin(req.user)) {
          return sendInsufficientPermissions(res, 'delete execution');
        }

        if (execution.status === 'running') {
          return res.status(409).json({
            error: 'cannot_delete_running',
            message: 'Cancel the workflow before deleting it.'
          });
        }

        try {
          await workflowEngine.deleteExecution(executionId);
        } catch (error) {
          if (error.code === 'EXECUTION_ACTIVE') {
            return res.status(409).json({
              error: 'cannot_delete_running',
              message: 'Cancel the workflow before deleting it.'
            });
          }
          throw error;
        }

        registry.remove(executionId);

        logger.info('Workflow execution deleted', {
          component: 'WorkflowRoutes',
          executionId,
          userId: currentUserId
        });

        res.json({ success: true });
      } catch (error) {
        sendFailedOperationError(res, 'delete execution', error);
      }
    }
  );

  /**
   * @swagger
   * /api/workflows/executions/{executionId}:
   *   patch:
   *     summary: Update execution metadata (currently archive/unarchive)
   *     description: |
   *       Toggle the archived flag on an execution. Owner-only (or admin).
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
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               archived:
   *                 type: boolean
   *     responses:
   *       200:
   *         description: Updated execution metadata
   *       403:
   *         description: Not the owner and not an admin
   *       404:
   *         description: Execution not found
   */
  app.patch(
    buildServerPath('/api/workflows/executions/:executionId'),
    checkWorkflowsFeature,
    authRequired,
    async (req, res) => {
      try {
        const { executionId } = req.params;
        const { archived } = req.body || {};

        if (!validateIdForPath(executionId, 'executionId')) {
          return sendBadRequest(res, 'Invalid executionId');
        }

        if (typeof archived !== 'boolean') {
          return sendBadRequest(res, 'archived must be a boolean');
        }

        const registry = getExecutionRegistry();
        const execution = registry.get(executionId);

        if (!execution) {
          return sendNotFound(res, 'Execution');
        }

        const currentUserId = req.user?.id || req.user?.sub || req.user?.username || 'anonymous';
        if (execution.userId !== currentUserId && !isAdmin(req.user)) {
          return sendInsufficientPermissions(res, 'update execution');
        }

        const updated = registry.setArchived(executionId, archived);

        logger.info('Workflow execution archive toggled', {
          component: 'WorkflowRoutes',
          executionId,
          archived,
          userId: currentUserId
        });

        res.json(updated);
      } catch (error) {
        sendFailedOperationError(res, 'update execution', error);
      }
    }
  );

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
    buildServerPath('/api/workflows/executions/:executionId/export'),
    checkWorkflowsFeature,
    authRequired,
    async (req, res) => {
      try {
        const { executionId } = req.params;

        if (!validateIdForPath(executionId, 'executionId')) {
          return sendBadRequest(res, 'Invalid executionId');
        }

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

        // Build a useful filename. Execution IDs are prefixed `wf-exec-`, so
        // strip the prefix before slicing — otherwise every run's filename
        // ends in the same literal `wf-exec-`.
        const shortId = executionId.replace(/^wf-exec-/, '').slice(0, 8) || executionId;
        const workflowSlug = (state.workflowId || 'workflow').replace(/[^a-zA-Z0-9._-]/g, '_');
        res.setHeader('Content-Type', 'application/json');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${workflowSlug}-${shortId}.json"`
        );

        res.json(exportData);

        logger.info('Workflow execution exported', {
          component: 'WorkflowRoutes',
          executionId,
          userId: req.user?.id
        });
      } catch (error) {
        sendFailedOperationError(res, 'export execution state', error);
      }
    }
  );
}
