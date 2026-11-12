// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Workflow run resume manager.
 *
 * Counterpart to the orphan sweeper: instead of marking every interrupted run
 * as failed on boot, this looks for runs left in a non-terminal state by a
 * crashed/restarted process and resumes them from their last checkpoint via
 * `WorkflowEngine.resume()`.
 *
 * State comes from {@link WorkflowStateRepository}.
 *
 * Definition reconstruction is delegated to a caller-supplied
 * `resolveDefinition(state)` because only a workflow *summary* is persisted in
 * state — the full definition lives in `contents/workflows/*.json` (plain
 * workflows) or is re-serialized from an agent profile (agent runs). The
 * resolver returns `{ definition, options }` (or null to skip).
 *
 * Guarded by the scheduler lock so that in a multi-instance deployment only
 * one instance resumes a given run.
 *
 * @module services/workflow/resumeManager
 */

import logger from '../../utils/logger.js';
import { getWorkflowStateRepository } from './WorkflowStateRepository.js';
import { isSchedulerOwner } from './triggers/schedulerLock.js';

/** Only these two statuses mean "was mid-flight when the process died". */
const RESUMABLE_STATUSES = new Set(['running', 'pending']);

/**
 * Execution ids this manager considers. Sub-workflow states (`wf-child-*`)
 * are deliberately excluded: they are driven by their parent's execution and
 * resuming one on its own would run half a workflow with no one to hand the
 * result to.
 */
const RESUMABLE_ID_PREFIX = 'wf-exec-';

/**
 * Find the runs that are eligible to resume (status `running` or `pending`).
 *
 * Only the unfinished executions are considered, from the repository's index
 * of them, and only their states are read — a finished run can never become
 * resumable, so the installation's workflow history is never opened. Each
 * candidate's own stored status decides, not the index; an entry whose state
 * turns out to be finished or gone is dropped from the index. A run paused for
 * approval is unfinished and stays indexed (and resumable through its
 * checkpoint) however old it is — it is just not resumed here.
 *
 * @param {import('./WorkflowStateRepository.js').WorkflowStateRepository} [repository]
 *   Store to scan; the shared, provider-backed one when omitted.
 * @returns {Promise<Array<{ executionId: string, state: Object }>>}
 */
export async function findResumableExecutions(repository = getWorkflowStateRepository()) {
  const { items, truncated } = await repository.listActive({ prefix: RESUMABLE_ID_PREFIX });
  if (truncated) {
    logger.warn({
      component: 'ResumeManager',
      message: `Stopped scanning for resumable runs at the cap; ${items.length} executions examined`
    });
  }
  const found = [];
  for (const { executionId } of items) {
    const state = await repository.read(executionId);
    if (!(await repository.confirmActive(executionId, state))) continue;
    if (RESUMABLE_STATUSES.has(state.status)) found.push({ executionId, state });
  }
  return found;
}

/**
 * Resume all interrupted runs found on disk.
 *
 * @param {Object} params
 * @param {import('./WorkflowEngine.js').WorkflowEngine} params.engine
 * @param {(state: Object) => Promise<{definition: Object, options?: Object}\|null>} params.resolveDefinition
 * @param {boolean} [params.requireSchedulerOwner=true] - Only resume if this instance owns the scheduler lock
 * @param {import('./WorkflowStateRepository.js').WorkflowStateRepository} [params.repository]
 * @returns {Promise<{ scanned: number, resumed: string[], skipped: string[] }>}
 */
export async function resumeInterruptedRuns({
  engine,
  resolveDefinition,
  requireSchedulerOwner = true,
  repository = null
} = {}) {
  if (!engine || typeof engine.resumeFromCheckpoint !== 'function') {
    throw new Error(
      'resumeInterruptedRuns requires an engine with a resumeFromCheckpoint() method'
    );
  }
  if (typeof resolveDefinition !== 'function') {
    throw new Error('resumeInterruptedRuns requires a resolveDefinition(state) function');
  }

  // In a multi-instance deployment, only the scheduler-lock owner resumes, so
  // two instances don't both pick up the same run.
  if (requireSchedulerOwner && !isSchedulerOwner()) {
    logger.info({
      component: 'ResumeManager',
      message: 'Not the scheduler-lock owner — leaving interrupted runs for the owner instance'
    });
    return { scanned: 0, resumed: [], skipped: [] };
  }

  const candidates = await findResumableExecutions(repository || getWorkflowStateRepository());
  const resumed = [];
  const skipped = [];

  for (const { executionId, state } of candidates) {
    let resolved = null;
    try {
      resolved = await resolveDefinition(state);
    } catch (error) {
      logger.warn({
        component: 'ResumeManager',
        message: `Could not resolve definition for ${executionId}: ${error.message}`,
        executionId
      });
    }

    if (!resolved || !resolved.definition) {
      skipped.push(executionId);
      continue;
    }

    try {
      await engine.resumeFromCheckpoint(resolved.definition, executionId, resolved.options || {});
      resumed.push(executionId);
      logger.info({
        component: 'ResumeManager',
        message: `Resumed interrupted run ${executionId}`,
        executionId,
        workflowId: state.workflowId
      });
    } catch (error) {
      skipped.push(executionId);
      logger.warn({
        component: 'ResumeManager',
        message: `Failed to resume ${executionId}: ${error.message}`,
        executionId
      });
    }
  }

  logger.info({
    component: 'ResumeManager',
    message: `Resume sweep: resumed ${resumed.length}, skipped ${skipped.length} of ${candidates.length}`
  });

  return { scanned: candidates.length, resumed, skipped };
}

export default { findResumableExecutions, resumeInterruptedRuns };
