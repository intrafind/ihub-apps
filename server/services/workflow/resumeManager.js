/**
 * Workflow run resume manager.
 *
 * Counterpart to the orphan sweeper: instead of marking every interrupted run
 * as failed on boot, this looks for runs left in a non-terminal state by a
 * crashed/restarted process and resumes them from their last checkpoint via
 * `WorkflowEngine.resume()`.
 *
 * State comes from {@link WorkflowStateRepository}, which reads both the
 * `workflow-state` documents and the legacy `<id>/latest.json` directories —
 * so an installation half way through the one-time import still has all of
 * its interrupted runs found, rather than looking empty and losing them.
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
import { DEFAULT_STATE_DIR, resolveWorkflowStateRepository } from './WorkflowStateRepository.js';
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
 * Scan for runs that are eligible to resume (status `running` or `pending`).
 *
 * @param {string} [stateDir] - Directory holding the legacy state layout.
 *   The installation's own directory resolves to the shared, provider-backed
 *   repository; anything else is read as a private directory.
 * @returns {Promise<Array<{ executionId: string, state: Object }>>}
 */
export async function findResumableExecutions(stateDir = DEFAULT_STATE_DIR) {
  const repository = resolveWorkflowStateRepository(stateDir);
  const { items, truncated } = await repository.list({ prefix: RESUMABLE_ID_PREFIX });
  if (truncated) {
    logger.warn({
      component: 'ResumeManager',
      message: `Stopped scanning for resumable runs at the cap; ${items.length} states examined`
    });
  }
  return items
    .filter(({ state }) => RESUMABLE_STATUSES.has(state.status))
    .map(({ executionId, state }) => ({ executionId, state }));
}

/**
 * Resume all interrupted runs found on disk.
 *
 * @param {Object} params
 * @param {import('./WorkflowEngine.js').WorkflowEngine} params.engine
 * @param {(state: Object) => Promise<{definition: Object, options?: Object}\|null>} params.resolveDefinition
 * @param {boolean} [params.requireSchedulerOwner=true] - Only resume if this instance owns the scheduler lock
 * @param {string} [params.stateDir]
 * @returns {Promise<{ scanned: number, resumed: string[], skipped: string[] }>}
 */
export async function resumeInterruptedRuns({
  engine,
  resolveDefinition,
  requireSchedulerOwner = true,
  stateDir = DEFAULT_STATE_DIR
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

  const candidates = await findResumableExecutions(stateDir);
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
