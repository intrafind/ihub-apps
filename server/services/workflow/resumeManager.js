/**
 * Workflow run resume manager.
 *
 * Counterpart to the orphan sweeper: instead of marking every interrupted run
 * as failed on boot, this scans `contents/data/workflow-state/<id>/latest.json`
 * for runs left in a non-terminal state by a crashed/restarted process and
 * resumes them from their last checkpoint via `WorkflowEngine.resume()`.
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

import fs from 'fs/promises';
import path from 'path';
import config from '../../config.js';
import { getRootDir } from '../../pathUtils.js';
import logger from '../../utils/logger.js';
import { isSchedulerOwner } from './triggers/schedulerLock.js';

const DEFAULT_STATE_DIR = path.join(getRootDir(), config.CONTENTS_DIR, 'data', 'workflow-state');
const RESUMABLE_STATUSES = new Set(['running', 'pending']);

async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Scan the workflow state directory for runs that are eligible to resume
 * (status `running` or `pending`).
 *
 * @param {string} [stateDir]
 * @returns {Promise<Array<{ executionId: string, state: Object }>>}
 */
export async function findResumableExecutions(stateDir = DEFAULT_STATE_DIR) {
  let entries;
  try {
    entries = await fs.readdir(stateDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith('wf-exec-')) continue;
    const state = await readJsonSafe(path.join(stateDir, entry.name, 'latest.json'));
    if (!state) continue;
    if (!RESUMABLE_STATUSES.has(state.status)) continue;
    out.push({ executionId: entry.name, state });
  }
  return out;
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
    throw new Error('resumeInterruptedRuns requires an engine with a resumeFromCheckpoint() method');
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
