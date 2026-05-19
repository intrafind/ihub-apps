/**
 * Workflow orphan sweeper.
 *
 * The in-memory engine instance is the only thing keeping a workflow alive — if
 * the Node process dies (crash, restart, deploy) mid-execution, the persisted
 * state file is left with `status: "running"` and the execution registry shows
 * the workflow as still active forever.
 *
 * On every boot we walk `contents/data/workflow-state/<id>/latest.json` and
 * rewrite any orphaned executions to `status: "failed"` with
 * `reason: "server_restart"` so users see a final state in the UI and "My
 * Executions" stops listing dead runs as running.
 */

import fs from 'fs/promises';
import path from 'path';
import config from '../../config.js';
import { getRootDir } from '../../pathUtils.js';
import logger from '../../utils/logger.js';
import { getExecutionRegistry } from './ExecutionRegistry.js';

const STATE_DIR = path.join(getRootDir(), config.CONTENTS_DIR, 'data', 'workflow-state');

// Statuses that indicate the workflow was mid-execution when the process died.
const ORPHAN_STATUSES = new Set(['running', 'pending']);

async function readJsonSafe(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    logger.warn('Failed to read workflow state file', {
      component: 'OrphanSweeper',
      filePath,
      error: error.message
    });
    return null;
  }
}

async function writeJsonSafe(filePath, data) {
  const json = JSON.stringify(data, null, 2);
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, json, 'utf8');
  await fs.rename(tmp, filePath);
}

/**
 * Scan the workflow state directory and mark stuck `running`/`pending`
 * executions as failed.
 *
 * Safe to call on every server boot — entries already in a terminal state are
 * skipped.
 */
export async function sweepOrphanedExecutions() {
  let entries;
  try {
    entries = await fs.readdir(STATE_DIR, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { scanned: 0, marked: 0 };
    logger.warn('Cannot read workflow state directory', {
      component: 'OrphanSweeper',
      stateDir: STATE_DIR,
      error: error.message
    });
    return { scanned: 0, marked: 0 };
  }

  let scanned = 0;
  let marked = 0;
  const registry = getExecutionRegistry();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith('wf-exec-')) continue;

    scanned++;

    const latestPath = path.join(STATE_DIR, entry.name, 'latest.json');
    const state = await readJsonSafe(latestPath);
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
      await writeJsonSafe(latestPath, state);
      try {
        registry.updateStatus(entry.name, 'failed', { reason: 'server_restart' });
      } catch (registryError) {
        // Registry may not have this execution loaded yet — non-fatal.
        logger.debug('Registry update skipped during orphan sweep', {
          component: 'OrphanSweeper',
          executionId: entry.name,
          error: registryError.message
        });
      }
      marked++;
      logger.info('Marked orphaned workflow as failed', {
        component: 'OrphanSweeper',
        executionId: entry.name
      });
    } catch (error) {
      logger.warn('Failed to rewrite orphaned workflow state', {
        component: 'OrphanSweeper',
        executionId: entry.name,
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
