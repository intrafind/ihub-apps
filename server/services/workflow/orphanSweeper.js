/**
 * Workflow orphan sweeper.
 *
 * The in-memory engine instance is the only thing keeping a workflow alive — if
 * the Node process dies (crash, restart, deploy) mid-execution, the persisted
 * state is left with `status: "running"` and the execution registry shows the
 * workflow as still active forever.
 *
 * On every boot we walk the stored workflow states and rewrite any orphaned
 * executions to `status: "failed"` with `reason: "server_restart"` so users see
 * a final state in the UI and "My Executions" stops listing dead runs as
 * running.
 *
 * State is read and written through {@link WorkflowStateRepository}, which
 * covers both the `workflow-state` documents and the legacy
 * `<id>/latest.json` directories. That union matters here more than anywhere
 * else: a half-imported installation that looked empty to this sweeper would
 * leave every interrupted run stuck at `running` forever.
 *
 * @module services/workflow/orphanSweeper
 */

import logger from '../../utils/logger.js';
import { getExecutionRegistry } from './ExecutionRegistry.js';
import { getStateManager } from './StateManager.js';
import {
  DEFAULT_STATE_DIR,
  resolveWorkflowStateRepository,
  workflowStateOwnerId
} from './WorkflowStateRepository.js';
import { isSchedulerOwner } from './triggers/schedulerLock.js';

// Statuses that indicate the workflow was mid-execution when the process died.
const ORPHAN_STATUSES = new Set(['running', 'pending']);

/**
 * Execution ids this sweeper considers. Sub-workflow states (`wf-child-*`)
 * are excluded, as they always have been: they are not listed in the UI and
 * marking one failed on its own would contradict its parent.
 */
const ORPHAN_ID_PREFIX = 'wf-exec-';

/**
 * Scan the stored workflow states and mark stuck `running`/`pending`
 * executions as failed.
 *
 * Safe to call on every server boot — entries already in a terminal state are
 * skipped.
 *
 * Guarded by the scheduler lock (like the resume manager) so that in a
 * multi-worker / multi-replica deployment only ONE instance sweeps. The
 * activeStates guard below only protects runs live in the CURRENT process; a
 * resumed run lives solely in the lock owner's in-memory state, so a non-owner
 * worker would otherwise mark the owner's just-resumed run as failed. Keeping
 * resume + sweep in the same (owner) process makes that guard authoritative.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.requireSchedulerOwner=true] - Only sweep if this
 *   instance owns the scheduler lock.
 * @param {string} [opts.stateDir] - Directory holding the legacy state layout;
 *   the installation's own directory resolves to the shared, provider-backed
 *   repository.
 * @param {import('./WorkflowStateRepository.js').WorkflowStateRepository} [opts.repository]
 *   Store to sweep. Resolved from `stateDir` when omitted.
 * @returns {Promise<{ scanned: number, marked: number }>}
 */
export async function sweepOrphanedExecutions({
  requireSchedulerOwner = true,
  stateDir = DEFAULT_STATE_DIR,
  repository = null
} = {}) {
  if (requireSchedulerOwner && !isSchedulerOwner()) {
    logger.debug('Not the scheduler-lock owner — skipping orphan sweep', {
      component: 'OrphanSweeper'
    });
    return { scanned: 0, marked: 0 };
  }

  const store = repository || resolveWorkflowStateRepository(stateDir);
  // Metadata only: the guard below rejects most candidates without ever
  // needing the state, and a state can carry a whole workflow definition.
  const { items, truncated } = await store.listSummaries({ prefix: ORPHAN_ID_PREFIX });
  if (truncated) {
    logger.warn('Orphan sweep stopped scanning at the cap', {
      component: 'OrphanSweeper',
      scanned: items.length
    });
  }

  let scanned = 0;
  let marked = 0;
  const registry = getExecutionRegistry();
  const stateManager = getStateManager();

  for (const { executionId } of items) {
    scanned++;

    // Skip executions that are live in memory — e.g. a run the resume manager
    // just picked up on boot. Failing those would clobber an active run.
    if (stateManager.activeStates?.has(executionId)) continue;

    const state = await store.read(executionId);
    if (!state) continue;

    if (!ORPHAN_STATUSES.has(state.status)) continue;

    const now = new Date().toISOString();
    state.status = 'failed';
    state.completedAt = state.completedAt || now;
    state.errors = state.errors || [];
    state.errors.push({
      type: 'server_restart',
      message:
        'Workflow was interrupted by a server restart. The runtime engine for this execution no longer exists.',
      timestamp: now
    });
    state.history = state.history || [];
    state.history.push({
      nodeId: null,
      type: 'workflow_failed',
      data: { reason: 'server_restart' },
      timestamp: now
    });

    try {
      await store.write(executionId, state, { ownerId: workflowStateOwnerId(state) });
      try {
        registry.updateStatus(executionId, 'failed', { reason: 'server_restart' });
      } catch (registryError) {
        // Registry may not have this execution loaded yet — non-fatal.
        logger.debug('Registry update skipped during orphan sweep', {
          component: 'OrphanSweeper',
          executionId,
          error: registryError.message
        });
      }
      marked++;
      logger.info('Marked orphaned workflow as failed', {
        component: 'OrphanSweeper',
        executionId
      });
    } catch (error) {
      logger.warn('Failed to rewrite orphaned workflow state', {
        component: 'OrphanSweeper',
        executionId,
        error: error.message
      });
    }
  }

  if (marked > 0) {
    logger.info(`Orphan sweeper marked ${marked} of ${scanned} executions as failed`, {
      component: 'OrphanSweeper'
    });
  } else {
    logger.debug(`Orphan sweeper scanned ${scanned} executions, no orphans found`, {
      component: 'OrphanSweeper'
    });
  }

  return { scanned, marked };
}
