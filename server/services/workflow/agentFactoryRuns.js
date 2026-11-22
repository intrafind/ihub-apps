// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Agent Factory runs that were not finished when the Agent Factory was removed
 * (#3773).
 *
 * An Agent Factory run is a workflow execution whose start data carries
 * `_agent` (the profile id and who started it). Its routes, its pages and its
 * flag are gone, so nothing can show, answer or resume such a run any more. A
 * starting server therefore settles every one of them that is not finished
 * (running, pending or paused at an approval) as cancelled with the reason
 * {@link AGENT_FACTORY_REMOVED}, before it resumes interrupted runs. None of
 * them is resumed, and none is left in the approvals queue. Finished runs and
 * every stored file of the Agent Factory stay as they are.
 *
 * The cancellation goes through `WorkflowEngine.cancel`, so the state, the
 * execution registry, the run ledger and the pending interactions of the run
 * end the way a cancel by its owner ends them.
 *
 * Listed for removal with the legacy workflow path (#3784).
 *
 * @module services/workflow/agentFactoryRuns
 */

import logger from '../../utils/logger.js';
import { getWorkflowStateRepository } from './WorkflowStateRepository.js';
import { isSchedulerOwner } from './triggers/schedulerLock.js';

/** The reason a removed Agent Factory run is cancelled with. */
export const AGENT_FACTORY_REMOVED = 'AGENT_FACTORY_REMOVED';

/**
 * Whether a stored execution is an Agent Factory run.
 *
 * @param {Object|null|undefined} state - Stored workflow state.
 * @returns {boolean}
 */
export function isAgentFactoryExecution(state) {
  const agent = state?.data?._agent;
  return Boolean(agent) && typeof agent === 'object';
}

/**
 * Cancel every unfinished Agent Factory run.
 *
 * Only the scheduler-lock owner does this, like the resume and the orphan
 * sweep it runs before: the execution records are shared by the workers.
 *
 * @param {Object} params
 * @param {import('./WorkflowEngine.js').WorkflowEngine} params.engine - The engine that resumes runs.
 * @param {import('./WorkflowStateRepository.js').WorkflowStateRepository} [params.repository]
 *   Store to scan; the shared, provider-backed one when omitted.
 * @param {boolean} [params.requireSchedulerOwner=true] - Only act when this process owns the scheduler lock.
 * @returns {Promise<{ scanned: number, cancelled: string[], failed: string[] }>}
 */
export async function cancelAgentFactoryExecutions({
  engine,
  repository = null,
  requireSchedulerOwner = true
} = {}) {
  if (!engine || typeof engine.cancel !== 'function') {
    throw new Error('cancelAgentFactoryExecutions requires an engine with a cancel() method');
  }
  if (requireSchedulerOwner && !isSchedulerOwner()) {
    return { scanned: 0, cancelled: [], failed: [] };
  }

  const store = repository || getWorkflowStateRepository();
  const { items, truncated } = await store.listActive();
  if (truncated) {
    logger.warn({
      component: 'AgentFactoryRuns',
      message: `Stopped scanning for Agent Factory runs at the cap; ${items.length} executions examined`
    });
  }

  const cancelled = [];
  const failed = [];
  for (const { executionId } of items) {
    const state = await store.read(executionId);
    if (!(await store.confirmActive(executionId, state))) continue;
    if (!isAgentFactoryExecution(state)) continue;
    try {
      await engine.cancel(executionId, AGENT_FACTORY_REMOVED);
      // `cancel` records the reason after its own checkpoint; store it too.
      await engine.stateManager?.checkpoint?.(executionId, AGENT_FACTORY_REMOVED);
      cancelled.push(executionId);
    } catch (error) {
      failed.push(executionId);
      logger.warn({
        component: 'AgentFactoryRuns',
        message: `Could not cancel the Agent Factory run ${executionId}: ${error.message}`,
        executionId
      });
    }
  }

  if (cancelled.length > 0 || failed.length > 0) {
    logger.info({
      component: 'AgentFactoryRuns',
      message: `The Agent Factory was removed: cancelled ${cancelled.length} unfinished Agent Factory run(s)`,
      cancelled,
      failed
    });
  }
  return { scanned: items.length, cancelled, failed };
}
