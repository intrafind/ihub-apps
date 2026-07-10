/**
 * Workflow Streaming Routes
 *
 * SSE progress streaming for a running execution, and the endpoint used to
 * respond to a paused human-checkpoint node.
 *
 * @module routes/workflow/streamRoutes
 */

import { authRequired } from '../../middleware/authRequired.js';
import { buildServerPath } from '../../utils/basePath.js';
import { getExecutionRegistry } from '../../services/workflow/ExecutionRegistry.js';
import { HumanNodeExecutor } from '../../services/workflow/executors/HumanNodeExecutor.js';
import { actionTracker } from '../../actionTracker.js';
import { createSseChannel } from '../../utils/sseChannel.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import {
  sendNotFound,
  sendBadRequest,
  sendFailedOperationError
} from '../../utils/responseHelpers.js';
import logger from '../../utils/logger.js';
import { checkWorkflowsFeature, workflowClients } from './workflowRouteHelpers.js';

/**
 * Registers the SSE streaming endpoint and human-checkpoint response endpoint.
 *
 * @param {Express} app - Express application instance
 * @param {Object} deps - Dependencies
 * @param {WorkflowEngine} deps.workflowEngine - Shared workflow engine instance
 */
export default function registerStreamRoutes(app, deps = {}) {
  const { workflowEngine } = deps;

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

      const channel = createSseChannel({
        req,
        res,
        id: executionId,
        map: workflowClients,
        component: 'WorkflowRoutes',
        onClose: () => actionTracker.off('fire-sse', handleWorkflowEvent)
      });

      channel.send('connected', { executionId });

      logger.info('SSE connection established for workflow execution', {
        component: 'WorkflowRoutes',
        executionId
      });

      // Define event types to listen for. The handler matches by prefix,
      // so `workflow.node` covers `workflow.node.start/complete/error/retry`,
      // and `workflow.subworkflow` covers start/complete events emitted by
      // the planner executor.
      const workflowEventTypes = [
        'workflow.start',
        'workflow.iteration',
        'workflow.node',
        'workflow.paused',
        'workflow.human',
        'workflow.complete',
        'workflow.failed',
        'workflow.cancelled',
        'workflow.checkpoint',
        'workflow.plan',
        'workflow.subworkflow'
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

        // Check if this is a workflow event we care about. Compare with a
        // trailing dot so that allowing `workflow.node` does not also accept
        // a hypothetical `workflow.nodes` event.
        if (
          !workflowEventTypes.some(type => eventType === type || eventType.startsWith(`${type}.`))
        ) {
          return;
        }

        // Log event details for debugging
        logger.debug('Sending SSE event to client', {
          component: 'WorkflowRoutes',
          executionId,
          eventType,
          nodeId: eventData.nodeId,
          iteration: eventData.iteration
        });

        const sent = channel.send(eventType, eventData);

        // Log successful send for important events
        if (sent && (eventType === 'workflow.node.complete' || eventType === 'workflow.complete')) {
          logger.info('SSE event sent', {
            component: 'WorkflowRoutes',
            executionId,
            eventType,
            nodeId: eventData.nodeId
          });
        }
      };

      // Register event handler
      actionTracker.on('fire-sse', handleWorkflowEvent);
    }
  );

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
    buildServerPath('/api/workflows/executions/:executionId/respond'),
    checkWorkflowsFeature,
    authRequired,
    async (req, res) => {
      try {
        const { executionId } = req.params;
        const { checkpointId, response, data } = req.body || {};

        if (!validateIdForPath(executionId, 'executionId')) {
          return sendBadRequest(res, 'Invalid executionId');
        }

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

        logger.info('Human checkpoint routing', {
          component: 'WorkflowRoutes',
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

        logger.info('Human checkpoint responded', {
          component: 'WorkflowRoutes',
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
}
