/**
 * Workflow state retention — the daily sweep that stops finished executions
 * accumulating forever.
 *
 * Nothing deleted workflow state on a timer before this. A completed run left
 * its `latest.json` — which carries the whole workflow definition and every
 * node result, so tens to hundreds of kilobytes each — plus its registry entry
 * behind until somebody pressed delete in the UI. Sub-workflow states
 * (`wf-child-*`) were worse: no route deletes them at all, so they were pure
 * accumulation.
 *
 * One rule, configured under `platform.workflowState` and switched off by a
 * `retentionDays` of zero or less: **a terminal execution older than
 * `retentionDays` goes**, together with
 *
 *   - its stored state (document *and* legacy `<id>/latest.json` directory),
 *   - its run summary in the `runs` namespace,
 *   - and, because the scan is not filtered by id prefix, its `wf-child-*`
 *     sub-workflow states.
 *
 * Terminal means `completed`, `failed` or `cancelled`. A `paused` execution is
 * waiting for a human to answer a checkpoint and is never swept, however old;
 * neither is a state whose age or status cannot be established, because with
 * a delete the safe direction is to do nothing.
 *
 * **Age is measured from when a state was last stored**, and a state is only
 * deleted when the store's timestamp *and* the timestamps inside the state
 * both fall before the cutoff. In the steady state the two are the same
 * moment — the last checkpoint of a run is written when the run finishes.
 * They differ in exactly two situations, and in both the store's timestamp is
 * the newer one, so the effect is a run kept longer rather than deleted early:
 * a state carried over by the one-time legacy import (its clock starts at the
 * import), and a state the orphan sweeper rewrote on boot. Reading every
 * state body to recover the original moment would mean pulling an
 * installation's entire workflow history — definitions and node results
 * included — through memory once a day, which is a far worse trade than
 * holding a handful of runs for one extra retention window.
 *
 * Scheduling: this must be started from the **existing** cluster-singleton
 * guard in `server.js`, next to `runLog.startCleanupScheduler()` and the chat
 * sweep. It deliberately does not introduce a second ownership mechanism —
 * two workers sweeping in parallel would only race each other's deletes.
 *
 * @module services/workflow/workflowRetention
 */
import configCache from '../../configCache.js';
import logger from '../../utils/logger.js';
import { getRunSummaryRepository } from '../runtime/RunSummaryRepository.js';
import { WorkflowStatus } from './StateManager.js';
import { getWorkflowStateRepository, MAX_SCAN_STATES } from './WorkflowStateRepository.js';

const COMPONENT = 'WorkflowRetention';

/** One day in milliseconds — the sweep interval and the age unit. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Retention window applied when `platform.workflowState` says nothing. */
export const DEFAULT_RETENTION_DAYS = 30;

/**
 * Statuses a run never leaves. Everything else — including `paused`, which is
 * an execution waiting on a person — is still live as far as this sweep is
 * concerned.
 */
const TERMINAL_STATUSES = new Set([
  WorkflowStatus.COMPLETED,
  WorkflowStatus.FAILED,
  WorkflowStatus.CANCELLED
]);

/** The running sweep timer, so starting twice does not sweep twice. */
let sweepTimer = null;

/** Guards against a tick starting while the previous one is still running. */
let sweeping = false;

/**
 * Retention settings as the sweep reads them.
 *
 * @param {Object} [platform] - Platform configuration.
 * @returns {{retentionDays: number, cleanupEnabled: boolean}} Effective
 *   settings; `retentionDays` of zero or less disables the age rule.
 */
export function workflowRetentionSettings(platform = {}) {
  const settings = platform?.workflowState || {};
  const retentionDays = Number(settings.retentionDays);
  return {
    retentionDays: Number.isFinite(retentionDays) ? retentionDays : DEFAULT_RETENTION_DAYS,
    cleanupEnabled: settings.cleanupEnabled !== false
  };
}

/**
 * The most recent timestamp a state itself claims.
 *
 * Checked on top of the store's own `updatedAt` so that a state whose stored
 * timestamp is older than its contents — a directory restored from a backup,
 * a file whose mtime was rewritten by a copy — is still judged by what the
 * run actually says about itself. Whichever of the two is newer decides.
 *
 * @param {Object} state - Execution state.
 * @returns {number} Milliseconds since the epoch, or `NaN` when unknown.
 */
function stateTime(state) {
  for (const candidate of [state?.completedAt, state?.updatedAt, state?.createdAt]) {
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return NaN;
}

/**
 * Apply the retention rule once.
 *
 * The scan is two-phase on purpose: metadata for every execution, then the
 * state itself only for the ones already old enough to be candidates. Reading
 * every state to decide that most of them are recent would pull the entire
 * history of an installation through memory once a day.
 *
 * @param {Object} [options]
 * @param {import('./WorkflowStateRepository.js').WorkflowStateRepository} [options.repository]
 *   State store to sweep; defaults to the process-wide one.
 * @param {import('../runtime/RunSummaryRepository.js').RunSummaryRepository} [options.runSummaries]
 *   Run summary store the deleted executions are also removed from.
 * @param {number} options.retentionDays - Age limit in days; zero or less
 *   keeps terminal states forever.
 * @param {number} [options.maxStates] - Hard bound on one sweep's scan.
 * @param {() => number} [options.now] - Clock, for tests.
 * @returns {Promise<{removed: number, scanned: number, summariesRemoved: number}>}
 */
export async function sweepWorkflowStates({
  repository,
  runSummaries,
  retentionDays,
  maxStates = MAX_SCAN_STATES,
  now = Date.now
} = {}) {
  const idle = { removed: 0, scanned: 0, summariesRemoved: 0 };
  if (!(retentionDays > 0)) return idle;

  const store = repository || getWorkflowStateRepository();
  const summaries = runSummaries || getRunSummaryRepository();

  const { items, truncated } = await store.listSummaries({ max: maxStates });
  if (truncated) {
    logger.warn('Workflow state retention stopped scanning at the per-sweep cap', {
      component: COMPONENT,
      scanned: items.length,
      cap: maxStates
    });
  }

  const cutoff = now() - retentionDays * DAY_MS;
  let removed = 0;
  let summariesRemoved = 0;

  for (const entry of items) {
    // An execution whose age cannot be established is never deleted: the
    // timestamp is the only evidence that it is finished with. This is also
    // the cheap half of the two-phase scan — it rejects every recent run
    // without reading a single state body.
    if (!Number.isFinite(entry.updatedAt) || entry.updatedAt >= cutoff) continue;

    let state;
    try {
      state = await store.read(entry.executionId);
    } catch (error) {
      logger.warn('Workflow state retention could not read a candidate', {
        component: COMPONENT,
        executionId: entry.executionId,
        error: error.message
      });
      continue;
    }
    if (!state || !TERMINAL_STATUSES.has(state.status)) continue;

    const claimed = stateTime(state);
    if (Number.isFinite(claimed) && claimed >= cutoff) continue;

    try {
      if (await store.remove(entry.executionId)) removed += 1;
    } catch (error) {
      logger.error('Workflow state retention failed to remove a state', {
        component: COMPONENT,
        executionId: entry.executionId,
        error: error.message
      });
      // The summary is deliberately left alone when the state survives: a run
      // that still has state but no summary is invisible in "my executions"
      // while continuing to take up space.
      continue;
    }

    try {
      // The execution id is the run id, so a workflow's summary and its state
      // share a key.
      if (await summaries.remove(entry.executionId)) summariesRemoved += 1;
    } catch (error) {
      logger.error('Workflow state retention failed to remove a run summary', {
        component: COMPONENT,
        executionId: entry.executionId,
        error: error.message
      });
    }
  }

  if (removed > 0) {
    logger.info('Workflow state retention removed terminal executions', {
      component: COMPONENT,
      removed,
      summariesRemoved,
      scanned: items.length,
      retentionDays
    });
  }

  return { removed, scanned: items.length, summariesRemoved };
}

/**
 * Start the daily workflow state retention sweep.
 *
 * Idempotent, and must be started from the cluster singleton that already owns
 * `runLog.startCleanupScheduler()`. Runs once immediately so a misconfigured
 * retention is visible in the logs at boot rather than a day later, then every
 * `intervalMs`. The timer is `unref()`d: a pending sweep never keeps the
 * process alive.
 *
 * @param {Object} [options]
 * @param {import('./WorkflowStateRepository.js').WorkflowStateRepository} [options.repository]
 *   State store to sweep. Resolved per tick from the bootstrapped storage
 *   provider when omitted, so a sweep started before storage came up (or after
 *   a provider swap) still sees the live one.
 * @param {import('../runtime/RunSummaryRepository.js').RunSummaryRepository} [options.runSummaries]
 *   Run summary store, resolved per tick the same way.
 * @param {() => Object} [options.getPlatformConfig] - Reads the platform
 *   config each tick, so an admin's change to `platform.workflowState` takes
 *   effect without a restart.
 * @param {number} [options.intervalMs=86400000] - Sweep interval.
 * @returns {() => void} Stops the sweep.
 */
export function startWorkflowStateRetention({
  repository = null,
  runSummaries = null,
  getPlatformConfig = () => configCache.getPlatform?.() || {},
  intervalMs = DAY_MS
} = {}) {
  if (sweepTimer) return stopWorkflowStateRetention;

  const tick = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const { retentionDays, cleanupEnabled } = workflowRetentionSettings(
        getPlatformConfig() || {}
      );
      if (!cleanupEnabled) return;
      await sweepWorkflowStates({ repository, runSummaries, retentionDays });
    } catch (error) {
      logger.error('Workflow state retention sweep failed', {
        component: COMPONENT,
        error: error.message
      });
    } finally {
      sweeping = false;
    }
  };

  sweepTimer = setInterval(tick, intervalMs);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
  tick();
  return stopWorkflowStateRetention;
}

/**
 * Stop the daily sweep. A sweep already in flight runs to completion.
 *
 * @returns {void}
 */
export function stopWorkflowStateRetention() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
