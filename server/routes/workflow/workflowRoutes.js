// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Workflow API Routes
 *
 * Provides RESTful endpoints for managing and executing agentic workflows.
 * Includes support for workflow CRUD operations, execution control, and
 * real-time progress streaming via Server-Sent Events (SSE).
 *
 * @module routes/workflow/workflowRoutes
 */

import {
  translateInternalEvent,
  buildEnvelope,
  currentSeq,
  stampSeq
} from '../../services/loop/RunStream.js';
import { SSE_V2_EVENTS } from '../../../shared/runEvents.js';
import {
  appAccessRequired,
  authenticatedOnly,
  authRequired
} from '../../middleware/authRequired.js';
import { aiAcknowledgementRequired } from '../../middleware/aiAcknowledgementRequired.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { getWorkflowEngine } from '../../services/workflow/WorkflowEngine.js';
import { getExecutionRegistry } from '../../services/workflow/ExecutionRegistry.js';
import { isSchedulerOwner } from '../../services/workflow/triggers/schedulerLock.js';
import { hasRemote } from '../../clusterBus.js';
import { RUN_PRESENCE_KIND } from '../../services/loop/RunLog.js';
import { actionTracker } from '../../actionTracker.js';
import { createSseChannel, startInactiveClientSweep } from '../../utils/sseChannel.js';
import { workflowConfigSchema } from '../../validators/workflowConfigSchema.js';
import configStore from '../../services/config/ConfigStore.js';
import { assertValidId, isValidId } from '../../utils/pathSecurity.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { filterByPermissions } from '../../services/workflow/workflowAccess.js';
import { isAdmin } from '../../utils/authorization.js';
import { createExecutionChat } from '../../services/workflow/executionChat.js';
import { assertProjectInputs } from '../../services/workflow/projectNodes.js';
import { getChatRepository } from '../../services/chat/ChatRepository.js';
import { resolveChatStorage } from '../../services/chat/chatPersistence.js';
import runLog from '../../services/loop/RunLog.js';
import { isAnonymousUser, resolvePrincipal } from '../../services/loop/runIdentity.js';
import logger from '../../utils/logger.js';
import configCache from '../../configCache.js';
import { findByIdCaseInsensitive } from '../../utils/resourceLookup.js';
import { requireFeature } from '../../featureRegistry.js';
import { removeMarketplaceInstallation } from '../../utils/installationCleanup.js';
import {
  limitFrom,
  nextOffsetCursor,
  offsetFromCursor,
  pageOfList
} from '../../utils/pagination.js';
import { sendCreated, segment } from '../../utils/created.js';

const checkWorkflowsFeature = requireFeature('workflows');

/** Where workflow definitions live, relative to `contents/`. */
const WORKFLOWS_DIR = 'workflows';

/**
 * The file a workflow is created as, relative to `contents/`.
 *
 * @param {string} workflowId - Workflow id, already validated for path use
 * @returns {string} Path relative to `contents/`
 */
function workflowPathFor(workflowId) {
  return `${WORKFLOWS_DIR}/${workflowId}.json`;
}

/**
 * The directory holding a workflow's published snapshots, relative to
 * `contents/`.
 *
 * The snapshots sit inside the workflows directory but are not workflows: a
 * dotted directory holds no `*.json` file of its own, so nothing that lists
 * the directory ever loads a snapshot as a definition.
 *
 * @param {string} workflowId - Workflow id, already validated for path use
 * @returns {string} Path relative to `contents/`
 */
function historyDirFor(workflowId) {
  return `${WORKFLOWS_DIR}/.history/${workflowId}`;
}

/**
 * SSE clients map for workflow execution streaming
 * Maps executionId -> { response, lastActivity }
 * @type {Map<string, {response: object, lastActivity: Date}>}
 */
const workflowClients = new Map();
startInactiveClientSweep(workflowClients, { component: 'WorkflowRoutes' });

/**
 * Authorizes the requesting user against a specific execution instance.
 * `filterByPermissions` only checks whether the caller may access the
 * *workflow definition* — this additionally verifies the caller owns the
 * specific *execution* (or is an admin), so per-execution endpoints don't
 * leak or accept control input from anyone who merely learns an executionId.
 *
 * Returns the execution record when access is allowed. When denied it throws a
 * `ServiceError` (404 if the execution doesn't exist, 403 otherwise).
 *
 * @param {import('express').Request} req
 * @param {string} executionId
 * @returns {Promise<object>}
 * @throws {ServiceError}
 */
async function loadOwnedExecution(req, executionId) {
  const registry = getExecutionRegistry();
  const execution = await registry.get(executionId);

  if (!execution) {
    throw new ServiceError('NOT_FOUND', 'Execution not found');
  }

  const currentUserId = req.user?.id || req.user?.sub || req.user?.username || 'anonymous';
  if (execution.userId !== currentUserId && !isAdmin(req.user)) {
    throw new ServiceError('FORBIDDEN', 'Insufficient permissions: access execution required');
  }

  return execution;
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
function buildInputPreview(initialData) {
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
function buildModelsList(workflow) {
  const set = new Set();
  for (const node of workflow?.nodes || []) {
    if (typeof node.model === 'string' && node.model) set.add(node.model);
  }
  return Array.from(set);
}

/**
 * Loads all workflow definitions.
 * Workflows are stored as individual JSON files in contents/workflows/
 *
 * @param {boolean} includeDisabled - Whether to include disabled workflows
 * @returns {Promise<Object[]>} Array of workflow definitions
 */
async function loadWorkflows(includeDisabled = false) {
  const documents = await configStore.listDocuments(WORKFLOWS_DIR);
  const workflows = [];

  for (const { data } of documents) {
    // A file holding something that is not an object is not a workflow; the
    // directory scan this replaced skipped those files too.
    if (!data || typeof data !== 'object') continue;
    if (!includeDisabled && data.enabled === false) continue;
    workflows.push(data);
  }

  return workflows;
}

/**
 * Finds the file a workflow ID is stored in.
 * Handles cases where the filename doesn't match the workflow ID.
 *
 * @param {string} workflowId - The workflow ID to search for
 * @returns {Promise<string|null>} Path relative to `contents/` if a file holds
 *   the workflow, null otherwise
 */
async function findWorkflowFile(workflowId) {
  const documents = await configStore.listDocuments(WORKFLOWS_DIR);

  // The expected file name wins, then the id inside a file: a workflow may be
  // stored under any name, and writing to `<id>.json` regardless would fork
  // such a workflow into two files.
  const match =
    documents.find(item => item.key === workflowId) ||
    documents.find(item => item.data?.id === workflowId);

  return match ? match.path : null;
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
      errors: result.error.issues.map(err => ({
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

/**
 * Recover executions that only exist as a checkpoint directory, then mark
 * whatever is still `running` as failed — the previous process died holding
 * it.
 *
 * Guarded by the scheduler lock, exactly like `resumeInterruptedRuns` and
 * `sweepOrphanedExecutions`. Execution records are shared across workers now,
 * so an ungated rescan is no longer merely wasteful: every worker would mark
 * as failed the very runs the lock owner is resuming from checkpoint, and the
 * result would be written to the record they all read.
 *
 * Called from `server.js`, not from route registration: the scheduler-lock
 * heartbeat is only started by `triggerManager.setEngine`, so at registration
 * time no process owns the lock and this would always skip. It runs in the
 * same owner-gated boot phase as the resume manager and the orphan sweeper,
 * and before both — a run that is resumable is set back to `running` by the
 * engine moments later, which is the ordering this rescan has always had.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.requireSchedulerOwner=true] - Only run if this
 *   instance owns the scheduler lock.
 * @param {(executionId: string) => boolean} [opts.heldByAnotherWorker] - Whether a
 *   sibling worker still runs the execution; those are left alone.
 * @returns {Promise<{recovered: boolean, marked: number}>}
 */
export async function markInterruptedExecutionsFailed({
  requireSchedulerOwner = true,
  heldByAnotherWorker = executionId => hasRemote(RUN_PRESENCE_KIND, executionId)
} = {}) {
  const registry = getExecutionRegistry();
  // The registry is shared state, and exactly one process should write it.
  const owned = !requireSchedulerOwner || isSchedulerOwner();
  if (!owned) {
    // Info, not debug: in a cluster this is the ordinary state of every worker
    // but one, so it is not a warning — but it is the one line that says why a
    // restart left executions marked `running`, and at debug it was invisible
    // under the default level.
    logger.info('Not the scheduler-lock owner — skipping the execution rescan', {
      component: 'WorkflowRoutes'
    });
    return { recovered: false, marked: 0 };
  }

  let marked = 0;
  try {
    await registry.loadFromDisk();
    // Marking a run failed is a claim about the whole installation, not about
    // this worker, so it stays owner-gated even when the rescan above did not.
    if (owned) {
      // Mark previously-running executions as failed (server process died)
      for (const exec of await registry.getActive()) {
        // A run a sibling worker still executes is not interrupted.
        if (exec.status === 'running' && !heldByAnotherWorker(exec.executionId)) {
          registry.updateStatus(exec.executionId, 'failed', { currentNode: null });
          marked += 1;
        }
      }
      await registry.flushWrites();
    }
  } catch (error) {
    logger.error('Failed to recover the execution registry on startup', {
      component: 'WorkflowRoutes',
      error: error.message
    });
  }
  return { recovered: true, marked };
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
  const workflowEngine = deps.workflowEngine || getWorkflowEngine();

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
    buildServerPath('/api/workflows'),
    checkWorkflowsFeature,
    authRequired,
    async (req, res) => {
      const workflows = await loadWorkflows();
      const filtered = filterByPermissions(workflows, req.user);

      res.json({ items: filtered });
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
   *         description: Maximum number of results (at most 200)
   *       - in: query
   *         name: cursor
   *         schema:
   *           type: string
   *         description: The `nextCursor` of the previous page
   *     responses:
   *       200:
   *         description: "`{ items, nextCursor }`: the user's executions, newest first"
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
      const userId = req.user?.id || req.user?.sub || req.user?.username || 'anonymous';
      const { status, limit, cursor, includeArchived } = req.query;

      const registry = getExecutionRegistry();
      const executions = await registry.getByUser(userId, {
        status,
        includeArchived: includeArchived === 'true' || includeArchived === '1'
      });

      res.json(
        pageOfList(executions, { limit: limitFrom(limit, { fallback: 20, max: 200 }), cursor })
      );
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
      const { id } = req.params;

      // Validate ID for security
      assertValidId(id, 'workflow');

      const workflows = await loadWorkflows(isAdmin(req.user));
      const workflow = findByIdCaseInsensitive(workflows, id);

      if (!workflow) {
        throw new ServiceError('NOT_FOUND', 'Workflow not found');
      }

      // Check if user has permission to access this workflow
      const accessible = filterByPermissions([workflow], req.user);
      if (accessible.length === 0) {
        throw new ServiceError('FORBIDDEN', 'Insufficient permissions: workflow access required');
      }

      res.json(workflow);
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
      const workflowData = req.body;

      // Validate workflow schema
      const validation = validateWorkflow(workflowData);
      if (!validation.success) {
        throw new ServiceError('VALIDATION_FAILED', 'Invalid workflow definition', {
          details: { issues: validation.errors }
        });
      }

      // Validate ID for security
      assertValidId(workflowData.id, 'workflow');

      // Check if workflow already exists
      const existingFile = await findWorkflowFile(workflowData.id);
      if (existingFile) {
        throw new ServiceError('CONFLICT', 'Workflow with this ID already exists');
      }

      // Write workflow file
      await configStore.writeJson(workflowPathFor(workflowData.id), validation.data);

      logger.info('Workflow created', {
        component: 'WorkflowRoutes',
        workflowId: workflowData.id
      });

      sendCreated(res, `/api/workflows/${segment(workflowData.id)}`, validation.data);

      // Refresh workflow cache after successful creation
      configCache.refreshWorkflowsCache?.();
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
      const { id } = req.params;
      const workflowData = req.body;

      // Validate ID for security
      assertValidId(id, 'workflow');

      // Validate workflow schema
      const validation = validateWorkflow(workflowData);
      if (!validation.success) {
        throw new ServiceError('VALIDATION_FAILED', 'Invalid workflow definition', {
          details: { issues: validation.errors }
        });
      }

      // Ensure ID cannot be changed
      if (workflowData.id !== id) {
        throw new ServiceError('BAD_REQUEST', 'Workflow ID cannot be changed');
      }

      // Find existing workflow file
      const workflowPath = await findWorkflowFile(id);

      if (!workflowPath) {
        throw new ServiceError('NOT_FOUND', 'Workflow not found');
      }

      // Update workflow file
      await configStore.writeJson(workflowPath, validation.data);

      logger.info('Workflow updated', {
        component: 'WorkflowRoutes',
        workflowId: id
      });

      res.json(validation.data);

      // Refresh workflow cache after successful update
      configCache.refreshWorkflowsCache?.();
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
      const { id } = req.params;

      // Validate ID for security
      assertValidId(id, 'workflow');

      // Find workflow file
      const workflowPath = await findWorkflowFile(id);

      if (!workflowPath) {
        throw new ServiceError('NOT_FOUND', 'Workflow not found');
      }

      // Delete workflow file
      await configStore.remove(workflowPath);

      logger.info('Workflow deleted', {
        component: 'WorkflowRoutes',
        workflowId: id
      });

      res.status(204).end();

      // Refresh workflow cache after successful deletion
      configCache.refreshWorkflowsCache?.();
      await removeMarketplaceInstallation('workflow', id);
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
    buildServerPath('/api/workflows/:id/execute'),
    checkWorkflowsFeature,
    authRequired,
    aiAcknowledgementRequired,
    async (req, res) => {
      try {
        const { id } = req.params;
        const { initialData = {}, options = {} } = req.body || {};

        // Validate ID for security
        assertValidId(id, 'workflow');

        // Load and validate workflow access
        const workflows = await loadWorkflows();
        const workflow = findByIdCaseInsensitive(workflows, id);

        if (!workflow) {
          throw new ServiceError('NOT_FOUND', 'Workflow not found');
        }

        // Check if user has permission to execute this workflow. Executions
        // are keyed by the caller's id, which every anonymous visitor shares,
        // so the anonymous principal cannot start one here.
        const accessible = isAnonymousUser(req.user)
          ? []
          : filterByPermissions([workflow], req.user);
        if (accessible.length === 0) {
          throw new ServiceError(
            'FORBIDDEN',
            'Insufficient permissions: workflow execution required'
          );
        }

        // A project input must name a project the caller may use (#1036).
        try {
          await assertProjectInputs(workflow, initialData, req.user);
        } catch (error) {
          if (error?.code === 'PROJECT_NOT_FOUND') {
            throw new ServiceError('NOT_FOUND', 'Project not found', { cause: error });
          }
          if (error?.code === 'INVALID_REF') {
            throw new ServiceError('BAD_REQUEST', error.message, {
              details: error.details,
              cause: error
            });
          }
          throw error;
        }

        // Store workflow definition in initial data for resume support
        const enrichedInitialData = {
          ...initialData,
          _workflowDefinition: workflow
        };

        // Start workflow execution. `chat` is the server's option for the
        // chat's workflow bridge (`WorkflowEngine.start`): an API caller does
        // not get to say which chat its execution belongs to.
        const { chat: _chat, ...requestOptions } =
          options && typeof options === 'object' ? options : {};
        const state = await workflowEngine.start(workflow, enrichedInitialData, {
          ...requestOptions,
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
          throw new ServiceError('BAD_REQUEST', error.message, { cause: error });
        }
        throw error;
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
      const { executionId } = req.params;

      if (!isValidId(executionId)) throw new ServiceError('BAD_REQUEST', 'Invalid executionId');

      await loadOwnedExecution(req, executionId);

      const state = await workflowEngine.getState(executionId);

      if (!state) {
        throw new ServiceError('NOT_FOUND', 'Execution not found');
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
    }
  );

  /**
   * @swagger
   * /api/workflows/executions/{executionId}/chat/{appId}:
   *   post:
   *     summary: Start a stored chat about an execution's results
   *     description: |
   *       Creates a chat in the app that opens with the execution's input as the
   *       question and its output as the answer ("Chat with Results"). The answer
   *       is read from the execution, never taken from the request, and names the
   *       execution it came from. The chat is temporary (not listed in the history)
   *       for an `ephemeral` app or an installation without chat history.
   *     tags:
   *       - Workflows
   *     parameters:
   *       - in: path
   *         name: executionId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: appId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               contextMessage:
   *                 type: string
   *                 description: The opening question when the execution had no text input
   *     responses:
   *       201:
   *         description: The chat was created — `{ chatId, appId }`
   *       400:
   *         description: The execution has no output
   *       404:
   *         description: Execution or app not found
   *       409:
   *         description: The execution has not finished (`EXECUTION_NOT_FINISHED`)
   *       503:
   *         description: Chat storage is unavailable (`CHAT_STORAGE_UNAVAILABLE`)
   */
  app.post(
    buildServerPath('/api/workflows/executions/:executionId/chat/:appId'),
    checkWorkflowsFeature,
    authRequired,
    authenticatedOnly,
    appAccessRequired,
    aiAcknowledgementRequired,
    async (req, res) => {
      const { executionId, appId } = req.params;
      if (!isValidId(executionId)) throw new ServiceError('BAD_REQUEST', 'Invalid executionId');
      assertValidId(appId, 'app');
      await loadOwnedExecution(req, executionId);

      // Ids match regardless of case, as `appAccessRequired` matched it.
      const chatApp = findByIdCaseInsensitive(configCache.getApps().data || [], appId);
      if (!chatApp || chatApp.enabled === false)
        throw new ServiceError('NOT_FOUND', 'App not found');

      // Always a stored chat: a temporary one for an `ephemeral` app or an
      // installation without chat history, listed in the history otherwise.
      const storage = resolveChatStorage({
        features: configCache.getFeatures(),
        platformConfig: configCache.getPlatform(),
        user: req.user,
        ephemeral: chatApp.ephemeral === true
      });
      if (!storage.stored) {
        throw new ServiceError('CHAT_STORAGE_UNAVAILABLE', 'Chat storage is unavailable');
      }

      const state = await workflowEngine.getState(executionId);
      if (!state) throw new ServiceError('NOT_FOUND', 'Execution not found');
      const identityMode = runLog.identityMode();
      const principal = await resolvePrincipal(req.user, { mode: identityMode });
      const created = await createExecutionChat({
        repository: getChatRepository(),
        state,
        executionId,
        appId: chatApp.id,
        ownerId: principal.id,
        identityMode: principal.mode || identityMode,
        temporary: storage.temporary,
        language: req.headers['accept-language']?.split(',')[0]?.split('-')[0] || 'en',
        contextMessage: req.body?.contextMessage
      });
      if (created.error === 'NOT_FINISHED') {
        throw new ServiceError('EXECUTION_NOT_FINISHED', 'The execution has not finished');
      }
      if (created.error === 'NO_RESULTS') {
        throw new ServiceError('BAD_REQUEST', 'The execution has no results to chat about');
      }
      if (created.error) {
        throw new ServiceError('STORAGE_UNAVAILABLE', 'The chat could not be stored');
      }
      const { chatId } = created;

      logger.info('Chat started from workflow results', {
        component: 'WorkflowRoutes',
        executionId,
        chatId,
        appId: chatApp.id
      });
      sendCreated(res, `/api/chats/${segment(chatId)}`, { chatId, appId: chatApp.id });
    }
  );

  /**
   * @swagger
   * /api/workflows/executions/{executionId}/_restart:
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
    buildServerPath('/api/workflows/executions/:executionId/_restart'),
    checkWorkflowsFeature,
    authRequired,
    aiAcknowledgementRequired,
    async (req, res) => {
      try {
        const { executionId } = req.params;
        if (!isValidId(executionId)) throw new ServiceError('BAD_REQUEST', 'Invalid executionId');

        await loadOwnedExecution(req, executionId);

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
          throw new ServiceError('NOT_FOUND', 'Execution not found', { cause: error });
        }
        if (
          error.code === 'INVALID_STATE_FOR_RESUME' ||
          error.code === 'WORKFLOW_NOT_AVAILABLE' ||
          error.code === 'NO_RESUME_POINT' ||
          error.code === 'USER_CANCELLED'
        ) {
          throw new ServiceError('BAD_REQUEST', error.message, { cause: error });
        }
        throw error;
      }
    }
  );

  /**
   * @swagger
   * /api/workflows/executions/{executionId}/_cancel:
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
    buildServerPath('/api/workflows/executions/:executionId/_cancel'),
    checkWorkflowsFeature,
    authRequired,
    async (req, res) => {
      try {
        const { executionId } = req.params;
        const { reason = 'user_cancelled' } = req.body || {};

        if (!isValidId(executionId)) throw new ServiceError('BAD_REQUEST', 'Invalid executionId');

        await loadOwnedExecution(req, executionId);

        // The execution may run on another worker: the engine relays the cancel.
        const state = await workflowEngine.cancelAnywhere(executionId, reason);

        logger.info('Workflow execution cancelled', {
          component: 'WorkflowRoutes',
          executionId,
          reason,
          userId: req.user?.id
        });

        res.json({ executionId: state.executionId, status: state.status });
      } catch (error) {
        if (error.code === 'EXECUTION_NOT_FOUND') {
          throw new ServiceError('NOT_FOUND', 'Execution not found', { cause: error });
        }
        throw error;
      }
    }
  );

  // ============================================================================
  // Delete & Archive Endpoints
  // ============================================================================

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
      const { executionId } = req.params;

      if (!isValidId(executionId)) throw new ServiceError('BAD_REQUEST', 'Invalid executionId');

      const execution = await loadOwnedExecution(req, executionId);

      const registry = getExecutionRegistry();

      if (execution.status === 'running') {
        throw new ServiceError('EXECUTION_ACTIVE', 'Cancel the workflow before deleting it.');
      }

      try {
        await workflowEngine.deleteExecution(executionId);
      } catch (error) {
        if (error.code === 'EXECUTION_ACTIVE') {
          throw new ServiceError('EXECUTION_ACTIVE', 'Cancel the workflow before deleting it.', {
            cause: error
          });
        }
        throw error;
      }

      // Awaited: the client reloads its execution list straight after this
      // responds, and that list now reads the shared record rather than
      // this worker's memory.
      await registry.remove(executionId);

      logger.info('Workflow execution deleted', {
        component: 'WorkflowRoutes',
        executionId,
        userId: execution.userId
      });

      res.status(204).end();
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
      const { executionId } = req.params;
      const { archived } = req.body || {};

      if (!isValidId(executionId)) throw new ServiceError('BAD_REQUEST', 'Invalid executionId');

      if (typeof archived !== 'boolean') {
        throw new ServiceError('BAD_REQUEST', 'archived must be a boolean');
      }

      const execution = await loadOwnedExecution(req, executionId);

      const registry = getExecutionRegistry();
      const updated = await registry.setArchived(executionId, archived);

      logger.info('Workflow execution archive toggled', {
        component: 'WorkflowRoutes',
        executionId,
        archived,
        userId: execution.userId
      });

      res.json(updated);
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
    buildServerPath('/api/workflows/executions/:executionId/export'),
    checkWorkflowsFeature,
    authRequired,
    async (req, res) => {
      const { executionId } = req.params;

      if (!isValidId(executionId)) throw new ServiceError('BAD_REQUEST', 'Invalid executionId');

      await loadOwnedExecution(req, executionId);

      const state = await workflowEngine.getState(executionId);

      if (!state) {
        throw new ServiceError('NOT_FOUND', 'Execution not found');
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
   *         description: SSE stream established (SSE v2 envelopes, see docs/sse-v2.md)
   *         content:
   *           text/event-stream:
   *             schema:
   *               type: string
   *               description: |
   *                 `event: <type>` frames with a JSON envelope `{ v: 2, seq, runId, ts, type, data }`:
   *                 `run/started`, `progress/node`, `interaction/raised`, `run/paused`,
   *                 `run/resumed`, `tool/progress`, `meta`, `run/ended`.
   *       401:
   *         description: Authentication required
   *       500:
   *         description: Internal server error
   */
  app.get(
    buildServerPath('/api/workflows/executions/:executionId/stream'),
    checkWorkflowsFeature,
    authRequired,
    // Async only because the ownership check reads the shared execution
    // record; the SSE channel is still set up in the same tick afterwards.
    async (req, res) => {
      const { executionId } = req.params;

      await loadOwnedExecution(req, executionId);

      // The execution may run on another cluster worker; watching relays its
      // events here.
      const stopWatching = actionTracker.watchRun(executionId);
      const channel = createSseChannel({
        req,
        res,
        id: executionId,
        map: workflowClients,
        component: 'WorkflowRoutes',
        onClose: () => {
          actionTracker.off('fire-sse', handleWorkflowEvent);
          stopWatching();
        }
      });

      const connected = buildEnvelope({
        streamId: executionId,
        runId: executionId,
        type: SSE_V2_EVENTS.STREAM_CONNECTED,
        data: { runId: executionId, lastSeq: currentSeq(executionId) }
      });
      // This route writes to the channel directly (no `sse.js` delivery), so it
      // stamps the stream sequence itself — on every frame it sends.
      channel.send(connected.type, stampSeq(executionId, connected));

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

        // Project the internal event onto SSE v2 envelopes for this stream.
        let sent = false;
        for (const frame of translateInternalEvent(eventData)) {
          try {
            const envelope = buildEnvelope({
              streamId: executionId,
              runId: frame.runId || executionId,
              type: frame.type,
              data: frame.data
            });
            sent = channel.send(envelope.type, stampSeq(executionId, envelope)) || sent;
          } catch (err) {
            logger.warn('Dropped workflow event that does not fit the SSE v2 contract', {
              component: 'WorkflowRoutes',
              executionId,
              eventType,
              error: err.message
            });
          }
        }

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
    buildServerPath('/api/admin/workflows'),
    checkWorkflowsFeature,
    adminAuth,
    async (req, res) => {
      const workflows = await loadWorkflows(true); // Include disabled
      res.json(workflows);
    }
  );

  /**
   * @swagger
   * /api/admin/workflows/{id}/_toggle:
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
    buildServerPath('/api/admin/workflows/:id/_toggle'),
    checkWorkflowsFeature,
    adminAuth,
    async (req, res) => {
      const { id } = req.params;

      // Validate ID for security
      assertValidId(id, 'workflow');

      // Find workflow file
      const workflowPath = await findWorkflowFile(id);

      if (!workflowPath) {
        throw new ServiceError('NOT_FOUND', 'Workflow not found');
      }

      // Read current workflow. It was readable a moment ago, so null here
      // means it has just been removed.
      const workflow = await configStore.readJson(workflowPath);
      if (!workflow) {
        throw new ServiceError('NOT_FOUND', 'Workflow not found');
      }

      // Toggle enabled status
      const newEnabledState = workflow.enabled === false;
      workflow.enabled = newEnabledState;

      // Save updated workflow
      await configStore.writeJson(workflowPath, workflow);

      logger.info('Workflow toggled', {
        component: 'WorkflowRoutes',
        workflowId: id,
        enabled: newEnabledState
      });

      res.json({
        workflow,
        enabled: newEnabledState
      });

      // Refresh workflow cache after successful toggle
      configCache.refreshWorkflowsCache?.();
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
   *         description: Maximum number of results (at most 500)
   *       - in: query
   *         name: cursor
   *         schema:
   *           type: string
   *         description: The `nextCursor` of the previous page
   *     responses:
   *       200:
   *         description: "`{ items, nextCursor, total, stats }`: execution summaries"
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
      const { status, search, limit, cursor } = req.query;
      const registry = getExecutionRegistry();

      if (status === 'all' || status) {
        const parsedOffset = offsetFromCursor(cursor);
        const parsedLimit = limitFrom(limit, { fallback: 100, max: 500 });

        // One listing call: the registry filters, searches, orders and
        // pages the shared execution records, and reports the statistics
        // over all of them rather than over the page.
        const { executions, total, stats } = await registry.list({
          status,
          search,
          limit: parsedLimit,
          offset: parsedOffset
        });

        res.json({
          items: executions,
          nextCursor: nextOffsetCursor({ offset: parsedOffset, limit: parsedLimit, total }),
          total,
          stats
        });
      } else {
        // Default behavior: return only active executions from WorkflowEngine
        const activeExecutions = await workflowEngine.listActiveExecutions();
        const stats = await registry.getStats();

        res.json({
          items: activeExecutions,
          nextCursor: null,
          total: activeExecutions.length,
          stats
        });
      }
    }
  );

  // ============================================================================
  // Version Control Endpoints
  // ============================================================================

  /**
   * @swagger
   * /api/workflows/{id}/publish:
   *   post:
   *     summary: Publish a workflow version (admin only)
   *     description: |
   *       Creates a published snapshot of the current workflow state.
   *       The snapshot is saved to the version history directory and the
   *       workflow status is set to 'published'.
   *     tags:
   *       - Workflows
   *       - Versions
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
   *         description: Workflow published successfully
   *       400:
   *         description: Invalid workflow ID
   *       404:
   *         description: Workflow not found
   *       500:
   *         description: Internal server error
   */
  app.post(
    buildServerPath('/api/workflows/:id/publish'),
    adminAuth,
    checkWorkflowsFeature,
    async (req, res) => {
      const { id } = req.params;
      assertValidId(id, 'workflow');

      // Load current workflow
      const workflowPath = await findWorkflowFile(id);
      if (!workflowPath) {
        throw new ServiceError('NOT_FOUND', 'Workflow not found');
      }

      const workflow = await configStore.readJson(workflowPath);
      if (!workflow) {
        throw new ServiceError('NOT_FOUND', 'Workflow not found');
      }

      // Create snapshot
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const version = workflow.version || '1.0.0';
      const snapshot = {
        ...workflow,
        status: 'published',
        _publishedAt: new Date().toISOString(),
        _publishedBy: req.user?.name || req.user?.id || 'unknown'
      };

      // Save to history. version comes from workflow.version which is
      // schema-validated as semver, so it's a safe filename component;
      // timestamp is generated above and id was checked by
      // assertValidId. The store creates the directory on first write.
      await configStore.writeJson(`${historyDirFor(id)}/${version}-${timestamp}.json`, snapshot);

      // Update workflow status
      workflow.status = 'published';
      await configStore.writeJson(workflowPath, workflow);

      logger.info({
        component: 'workflowRoutes',
        message: `Published workflow '${id}' version ${version}`,
        workflowId: id,
        version
      });

      res.json({ version, publishedAt: snapshot._publishedAt });
    }
  );

  return {
    workflowEngine,
    workflowClients
  };
}

// Export helper functions for testing
export { filterByPermissions, loadWorkflows, findWorkflowFile, validateWorkflow };
