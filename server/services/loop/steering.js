/**
 * Steer — deliver a human message into a running loop at its next step
 * boundary (concept §5.5: human → agent on the same rails).
 *
 * `POST /api/runs/:runId/human-events { kind: 'steer' }` records the event on
 * the run's ledger and calls `steerRun`. The worker that owns the run (the one
 * that started it, per RunLog ownership) queues the message; `AgentLoop`
 * drains the queue before its next model call and appends it as a
 * `role: 'user'` message inside an explicit trust marker, so the model can
 * tell a mid-run instruction from the person running the task apart from tool
 * output. In a cluster the message is relayed to the owning worker over the
 * bus. A run without an active loop (ended, or nobody owns it) only keeps the
 * ledger record.
 *
 * @module services/loop/steering
 */
import { publish, subscribe, hasRemote } from '../../clusterBus.js';
import defaultRunLog, { RUN_PRESENCE_KIND } from './RunLog.js';

export const STEER_CHANNEL = 'run:steer';
/** Prefix every steer message carries so the model can recognise its origin. */
export const STEER_MARKER = '[steer]';
export const MAX_QUEUED_STEERS = 20;
/** A steer nobody drained within this window is dropped (the loop has moved on). */
export const STEER_TTL_MS = 10 * 60 * 1000;
const SWEEP_ABOVE = 1000;

/** @type {Map<string, Array<{message:string, by:string|null, at:string, expiresAt:number}>>} */
const queues = new Map();

function sweep(now) {
  if (queues.size < SWEEP_ABOVE) return;
  for (const [runId, queue] of queues) {
    const live = queue.filter(s => s.expiresAt > now);
    if (live.length === 0) queues.delete(runId);
    else queues.set(runId, live);
  }
}

/**
 * Queue a steer for a run whose loop runs in this process.
 * @returns {boolean} whether the message was queued
 */
export function enqueueSteer(runId, steer = {}, { now = Date.now() } = {}) {
  const message = typeof steer.message === 'string' ? steer.message.trim() : '';
  if (typeof runId !== 'string' || !runId || !message) return false;
  sweep(now);
  const live = (queues.get(runId) || []).filter(s => s.expiresAt > now);
  live.push({
    message,
    by: steer.by ?? null,
    at: steer.at || new Date(now).toISOString(),
    expiresAt: now + STEER_TTL_MS
  });
  while (live.length > MAX_QUEUED_STEERS) live.shift();
  queues.set(runId, live);
  return true;
}

/**
 * Take (and clear) the steers queued for a run, oldest first.
 * @returns {Array<{message:string, by:string|null, at:string}>}
 */
export function takeSteers(runId, { now = Date.now() } = {}) {
  if (!runId) return [];
  const queue = queues.get(runId);
  if (!queue) return [];
  queues.delete(runId);
  return queue.filter(s => s.expiresAt > now).map(({ expiresAt: _e, ...rest }) => rest);
}

/** The transcript message the loop appends for a steer (explicit trust marker). */
export function steerMessage(steer) {
  return {
    role: 'user',
    content: `${STEER_MARKER} Mid-run instruction from the person running this task: ${steer.message}`,
    _steer: true
  };
}

/**
 * Route a steer to the loop that owns `runId`.
 *
 * @param {string} runId
 * @param {{message:string, by?:string|null, at?:string}} steer
 * @param {Object} [deps] - test seams
 * @returns {'queued'|'relayed'|null} where it went; null when no loop is active for the run
 */
export function steerRun(
  runId,
  steer,
  { runLog = defaultRunLog, bus = { publish, hasRemote } } = {}
) {
  const meta = runLog.getRunMeta(runId);
  if (meta?.owned) {
    if (meta.ended) return null;
    return enqueueSteer(runId, steer) ? 'queued' : null;
  }
  if (bus.hasRemote(RUN_PRESENCE_KIND, runId)) {
    bus.publish(STEER_CHANNEL, { runId, steer }, { kind: RUN_PRESENCE_KIND, key: runId });
    return 'relayed';
  }
  return null;
}

// Steers relayed from other workers land in this worker's queue.
subscribe(STEER_CHANNEL, message => {
  if (message && typeof message.runId === 'string')
    enqueueSteer(message.runId, message.steer || {});
});

/** Test seam. */
export function resetSteersForTests() {
  queues.clear();
}
