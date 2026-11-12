// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Workflow orphan sweeper.
 *
 * The in-memory engine instance is the only thing keeping a workflow alive — if
 * the Node process dies (crash, restart, deploy) mid-execution, the persisted
 * state is left with `status: "running"` and the execution registry shows the
 * workflow as still active forever.
 *
 * On every boot we walk the unfinished workflow states and rewrite any orphaned
 * executions to `status: "failed"` with `reason: "server_restart"` so users see
 * a final state in the UI and "My Executions" stops listing dead runs as
 * running.
 *
 * State is read and written through {@link WorkflowStateRepository}.
 *
 * @module services/workflow/orphanSweeper
 */

import logger from '../../utils/logger.js';
import { hasRemote } from '../../clusterBus.js';
import { RUN_PRESENCE_KIND } from '../loop/RunLog.js';
import { getExecutionRegistry } from './ExecutionRegistry.js';
import { getStateManager } from './StateManager.js';
import { getWorkflowStateRepository, workflowStateOwnerId } from './WorkflowStateRepository.js';
import { isSchedulerOwner } from './triggers/schedulerLock.js';

// Statuses that indicate the workflow was mid-execution when the process died.
const ORPHAN_STATUSES = new Set(['running', 'pending']);

/**
 * Execution ids this sweeper considers. Sub-workflow states (`wf-child-*`)
 * are excluded, as they always have been: they are not listed in the UI and
 * marking one failed on its own would contradict its parent.
 */
const ORPHAN_ID_PREFIXES = Object.freeze([
  'wf-exec-',
  // Workflows started by `@workflow` in a chat run under the chat's run id.
  // Nothing resumes them — the chat bridge that delivered their answer died
  // with the process — so one left running is as orphaned as any other, and
  // its chat is closed out when it is next read (`chat/chatRecovery.js`).
  'workflow-'
]);

/**
 * Whether another worker still runs a chat-launched execution: the chat's
 * workflow bridge or the execution's ledger run is present there.
 *
 * @param {string} executionId
 * @param {Object} state - Stored workflow state.
 * @returns {boolean}
 */
export function isHeldByAnotherWorker(executionId, state) {
  const chatId = state?.data?._chatId;
  return (
    hasRemote(RUN_PRESENCE_KIND, executionId) ||
    (typeof chatId === 'string' && chatId !== '' && hasRemote('workflow', chatId))
  );
}

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
 * @param {import('./WorkflowStateRepository.js').WorkflowStateRepository} [opts.repository]
 *   Store to sweep; the shared, provider-backed one when omitted.
 * @param {(executionId: string, state: Object) => boolean} [opts.heldByAnotherWorker]
 *   Whether another worker runs a chat-launched execution; the cluster's
 *   presence when omitted.
 * @returns {Promise<{ scanned: number, marked: number }>}
 */
export async function sweepOrphanedExecutions({
  requireSchedulerOwner = true,
  repository = null,
  heldByAnotherWorker = isHeldByAnotherWorker
} = {}) {
  if (requireSchedulerOwner && !isSchedulerOwner()) {
    logger.debug('Not the scheduler-lock owner — skipping orphan sweep', {
      component: 'OrphanSweeper'
    });
    return { scanned: 0, marked: 0 };
  }

  const store = repository || getWorkflowStateRepository();
  // Only the unfinished executions, from the repository's index of them: a
  // finished run can never be orphaned, so the workflow history — states that
  // can carry a whole workflow definition each — is never opened.
  const items = [];
  for (const prefix of ORPHAN_ID_PREFIXES) {
    const page = await store.listActive({ prefix });
    if (page.truncated) {
      logger.warn('Orphan sweep stopped scanning at the cap', {
        component: 'OrphanSweeper',
        prefix,
        scanned: page.items.length
      });
    }
    items.push(...page.items);
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
    if (!(await store.confirmActive(executionId, state))) continue;

    // `paused` is unfinished too — a run waiting for a person's approval —
    // and is left alone however old it is.
    if (!ORPHAN_STATUSES.has(state.status)) continue;

    // A chat's workflow runs on the worker that took the chat's request, not
    // on this one: `activeStates` above cannot see it. Its bridge announces
    // itself by chat id, and its ledger run by execution id.
    if (executionId.startsWith('workflow-') && heldByAnotherWorker(executionId, state)) {
      continue;
    }

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
