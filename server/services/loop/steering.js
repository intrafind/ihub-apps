// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Messages a person sends into a running answer (concept §5.5: human → agent
 * on the same rails), and what becomes of each one.
 *
 * `POST /api/runs/:runId/human-events { kind: 'steer' }` mints the message's
 * id, records the event on the run's ledger and calls {@link steerRun}. The
 * worker that owns the run (the one that started it, per RunLog ownership)
 * queues the message; in a cluster it is asked over the bus
 * (`clusterBus.request`), so the route knows whether the message was taken.
 * A message is one of two kinds (`mode`):
 *
 * - `steer` — read at the next step of the running answer: `AgentLoop`
 *   drains the queue before its next model call ({@link takeSteers}) and
 *   appends the message as a `role: 'user'` message that starts with the
 *   marker ({@link steerMessage}).
 * - `afterwards` — held until the answer ends, then sent as the next message.
 *
 * When the answer ends, whatever is still queued (a steer that came after the
 * last model call, every `afterwards` message) is the leftover: the chat turn
 * takes it in one step under the chat lock ({@link closeSteering}) and sends
 * it as the next turn, or drops it (`services/chat/chatSteering.js`). A run
 * that is not a chat turn has no next turn: its leftover is dropped when its
 * `run/end` is recorded ({@link dropLeftoverAtRunEnd}). A queued
 * message is removed with {@link cancelSteer} until it is read; once read, or
 * sent as the next turn, it is settled and cannot be removed any more.
 *
 * Each step happens synchronously on the owning worker's event loop, so of a
 * read, a removal and the end of the answer exactly one gets a message.
 *
 * Who sent a message is metadata (`_origin: 'person'`, `_steerId`); the marker
 * the model reads is rendered from it, and the same characters in a tool
 * result, a file or a report are neutralised (`shared/steerMarker.js`). A
 * workflow answer (`services/workflow/questionPause.js`) carries `_steer` but
 * never `_steerId`, so it is never reported as a message the person sent.
 *
 * The queue is in memory: a restart of the worker loses what it holds, and
 * the chat read model then lists nothing (#3197 makes it durable).
 *
 * The frames the person's client is sent (`steer/queued`, `steer/dropped`)
 * are emitted here, on the chat stream of the run, by the worker that holds
 * the queue; `steer/applied` of a message read at a step is emitted by the
 * chat turn that read it (`chatSteering.js`).
 *
 * @module services/loop/steering
 */
import crypto from 'node:crypto';
import { request, respond, hasRemote } from '../../clusterBus.js';
import defaultRunLog, { RUN_PRESENCE_KIND } from './RunLog.js';
import { RunStreamEmitter } from './RunStream.js';
import { SSE_V2_EVENTS } from '../../../shared/runEvents.js';
import { STEER_MARKER, neutraliseSteerMarker } from '../../../shared/steerMarker.js';
import logger from '../../utils/logger.js';

export { STEER_MARKER };

/** Asks the owning worker to queue a message (`{ runId, steer }` → `{ queued }`). */
export const STEER_CHANNEL = 'run:steer';
/** Asks the owning worker to remove a queued message (`{ runId, id, by }` → `{ result }`). */
export const STEER_CANCEL_CHANNEL = 'run:steer:cancel';
/** Asks the owning worker for the queued messages of a run (`{ runId }` → `{ items }`). */
export const STEER_PENDING_CHANNEL = 'run:steer:pending';

export const MAX_QUEUED_STEERS = 20;
/** A steer nobody drained within this window is dropped (the loop has moved on). */
export const STEER_TTL_MS = 10 * 60 * 1000;
/**
 * An `afterwards` message waits for the end of the answer, which can take an
 * hour (`DURABLE_TURN_WALL_CLOCK_MS`); past this it is dropped all the same, so
 * the queue of a run nobody closed does not stay forever.
 */
export const SEND_AFTER_TTL_MS = 2 * 60 * 60 * 1000;
/** How long a read or sent message still answers a removal with "already read". */
const SETTLED_TTL_MS = 2 * 60 * 60 * 1000;
/** How long a closed run refuses new messages (a continued run opens it again). */
const CLOSED_TTL_MS = 2 * 60 * 60 * 1000;
const SWEEP_ABOVE = 1000;

/**
 * A queued message.
 *
 * @typedef {Object} QueuedSteer
 * @property {string} id - Minted by the route.
 * @property {'steer'|'afterwards'} mode
 * @property {string} message - What the person wrote.
 * @property {string|null} by - The sender's actor id, in the run's identity mode.
 * @property {string} at - When it was sent.
 * @property {string|null} chatId - The chat whose stream is told about it.
 * @property {string|null} [originRunId] - The run it was sent to, when it moved to the
 *   next turn's run since ({@link moveSteers}): the run the caller removes it under.
 * @property {number} expiresAt
 */

/** @type {Map<string, QueuedSteer[]>} run id → queued messages, oldest first */
const queues = new Map();
/**
 * What became of a message that left its run's queue. `taken`: the answer ended
 * and its leftover is being decided (settled again as `sent`, `moved` or
 * `dropped` a moment later); `moved`: it waits in the queue of the next turn's
 * run `to`.
 *
 * @type {Map<string, {outcome: 'applied'|'sent'|'removed'|'dropped'|'taken'|'moved', at: number, to?: string}>}
 *   `<runId>:<id>`
 */
const settled = new Map();
/** How many moves a removal follows; each move is to a new run, so a few suffice. */
const MAX_MOVES_FOLLOWED = 8;
/** @type {Map<string, number>} run id → when its leftover was taken */
const closed = new Map();

/**
 * The kind a queued message has in the chat read model and in the frames.
 *
 * @param {'steer'|'afterwards'} mode
 * @returns {'steer'|'send_after'}
 */
export function pendingKindOf(mode) {
  return mode === 'afterwards' ? 'send_after' : 'steer';
}

/** A new message id. */
export function newSteerId() {
  return crypto.randomUUID();
}

const settledKey = (runId, id) => `${runId}:${id}`;

function settle(runId, id, outcome, now, to = undefined) {
  settled.set(settledKey(runId, id), { outcome, at: now, ...(to ? { to } : {}) });
}

/**
 * Tell the run's chat stream about a message. A run without a chat (an API
 * run) has no stream; nothing is told.
 *
 * @param {string} runId
 * @param {QueuedSteer} entry
 * @param {string} type - `steer/queued`, `steer/applied` or `steer/dropped`
 * @param {Object} data
 */
function tell(runId, entry, type, data) {
  if (!entry.chatId) return;
  new RunStreamEmitter({ streamId: entry.chatId, runId }).emit(type, {
    id: entry.id,
    kind: pendingKindOf(entry.mode),
    text: entry.message,
    ...data
  });
}

/**
 * Settle a message as dropped and tell its stream why.
 *
 * @param {string} runId
 * @param {QueuedSteer} entry
 * @param {string} reason - one of `STEER_DROP_REASONS`
 * @param {number} now
 */
function drop(runId, entry, reason, now) {
  settle(runId, entry.id, reason === 'removed' ? 'removed' : 'dropped', now);
  tell(runId, entry, SSE_V2_EVENTS.STEER_DROPPED, { reason });
}

/**
 * The live messages of a run; the expired ones are dropped (and told).
 *
 * @param {string} runId
 * @param {number} now
 * @returns {QueuedSteer[]}
 */
function pruneExpired(runId, now) {
  const queue = queues.get(runId);
  if (!queue) return [];
  const live = [];
  for (const entry of queue) {
    if (entry.expiresAt > now) live.push(entry);
    else drop(runId, entry, 'expired', now);
  }
  if (live.length > 0) queues.set(runId, live);
  else queues.delete(runId);
  return live;
}

function sweepTimes(map, olderThan, timeOf) {
  for (const [key, value] of map) {
    if (timeOf(value) < olderThan) map.delete(key);
  }
}

function sweep(now) {
  if (queues.size >= SWEEP_ABOVE) {
    for (const runId of [...queues.keys()]) pruneExpired(runId, now);
  }
  if (settled.size >= SWEEP_ABOVE) sweepTimes(settled, now - SETTLED_TTL_MS, v => v.at);
  if (closed.size >= SWEEP_ABOVE) sweepTimes(closed, now - CLOSED_TTL_MS, v => v);
}

function isClosed(runId, now) {
  const at = closed.get(runId);
  if (at === undefined) return false;
  if (now - at < CLOSED_TTL_MS) return true;
  closed.delete(runId);
  return false;
}

/**
 * Queue a message for a run whose loop runs in this process, and tell the
 * run's stream (`steer/queued`). Above {@link MAX_QUEUED_STEERS} the oldest
 * message is dropped (`queue_full`).
 *
 * @param {string|null|undefined} runId - Anything but a non-empty string queues nothing.
 * @param {Object} steer
 * @param {string} [steer.id] - The id the route minted; a new one when absent.
 * @param {'steer'|'afterwards'} [steer.mode='steer']
 * @param {*} steer.message - What the person wrote; anything but a non-blank string queues nothing.
 * @param {string|null} [steer.by]
 * @param {string} [steer.at]
 * @param {string|null} [steer.chatId]
 * @param {string|null} [steer.originRunId] - see {@link QueuedSteer}
 * @param {Object} [options]
 * @param {number} [options.now]
 * @returns {boolean} whether the message was queued: false for a blank one, an
 *   id already used for this run, or a run whose answer has ended
 */
export function enqueueSteer(runId, steer = {}, { now = Date.now() } = {}) {
  const message = typeof steer.message === 'string' ? steer.message.trim() : '';
  if (typeof runId !== 'string' || !runId || !message) return false;
  if (isClosed(runId, now)) return false;
  sweep(now);
  const live = pruneExpired(runId, now);
  const mode = steer.mode === 'afterwards' ? 'afterwards' : 'steer';
  const id = typeof steer.id === 'string' && steer.id ? steer.id : newSteerId();
  if (live.some(entry => entry.id === id) || settled.has(settledKey(runId, id))) return false;
  const entry = {
    id,
    mode,
    message,
    by: steer.by ?? null,
    at: steer.at || new Date(now).toISOString(),
    chatId: typeof steer.chatId === 'string' && steer.chatId ? steer.chatId : null,
    ...(typeof steer.originRunId === 'string' && steer.originRunId
      ? { originRunId: steer.originRunId }
      : {}),
    expiresAt: now + (mode === 'afterwards' ? SEND_AFTER_TTL_MS : STEER_TTL_MS)
  };
  live.push(entry);
  while (live.length > MAX_QUEUED_STEERS) drop(runId, live.shift(), 'queue_full', now);
  queues.set(runId, live);
  tell(runId, entry, SSE_V2_EVENTS.STEER_QUEUED, { at: entry.at });
  return true;
}

/**
 * Take the steers queued for a run, oldest first, and settle them as read.
 * `afterwards` messages stay queued for the end of the answer.
 *
 * @param {string} runId
 * @param {Object} [options]
 * @param {number} [options.now]
 * @returns {Array<{id: string, message: string, by: string|null, at: string}>}
 */
export function takeSteers(runId, { now = Date.now() } = {}) {
  if (!runId) return [];
  const live = pruneExpired(runId, now);
  const taken = live.filter(entry => entry.mode === 'steer');
  if (taken.length === 0) return [];
  const kept = live.filter(entry => entry.mode !== 'steer');
  if (kept.length > 0) queues.set(runId, kept);
  else queues.delete(runId);
  for (const entry of taken) settle(runId, entry.id, 'applied', now);
  return taken.map(({ id, message, by, at }) => ({ id, message, by, at }));
}

/**
 * The messages still queued for a run in this process, oldest first. `runId`
 * of an item is the run a removal names: the one it was sent to, also after it
 * moved to the next turn's run.
 *
 * @param {string} runId
 * @param {Object} [options]
 * @param {number} [options.now]
 * @returns {Array<{id: string, runId: string, kind: 'steer'|'send_after', text: string,
 *   at: string, chatId: string|null}>}
 */
export function pendingSteers(runId, { now = Date.now() } = {}) {
  if (!runId) return [];
  return pruneExpired(runId, now).map(entry => ({
    id: entry.id,
    runId: entry.originRunId || runId,
    kind: pendingKindOf(entry.mode),
    text: entry.message,
    at: entry.at,
    chatId: entry.chatId
  }));
}

/**
 * Remove a queued message of a run in this process.
 *
 * Only the queue of `runId` is searched, and the queue of the next turn's run a
 * message of it moved to: an id of another run is unknown here. A message
 * somebody else sent is unknown too (`by` differs).
 *
 * @param {string} runId
 * @param {string} id
 * @param {Object} [options]
 * @param {string|null} [options.by] - The caller's actor id; compared when given.
 * @param {number} [options.now]
 * @returns {'removed'|'applied'|'unavailable'|'unknown'} `applied`: read at a
 *   step or sent as the next turn, too late to remove; `unavailable`: the answer
 *   is ending and what becomes of the message is being decided, ask again
 */
export function cancelQueuedSteer(runId, id, { by, now = Date.now() } = {}) {
  let current = runId;
  for (let moves = 0; moves <= MAX_MOVES_FOLLOWED; moves++) {
    const result = cancelInQueue(current, id, by, now);
    if (result !== 'moved') return result;
    current = settled.get(settledKey(current, id)).to;
  }
  return 'unknown';
}

/**
 * {@link cancelQueuedSteer} on one run's queue; `moved` when the message moved
 * on to the next turn's run.
 *
 * @returns {'removed'|'applied'|'unavailable'|'unknown'|'moved'}
 */
function cancelInQueue(runId, id, by, now) {
  const live = pruneExpired(runId, now);
  const entry = live.find(candidate => candidate.id === id);
  if (entry) {
    if (by !== undefined && entry.by !== by) return 'unknown';
    const rest = live.filter(candidate => candidate !== entry);
    if (rest.length > 0) queues.set(runId, rest);
    else queues.delete(runId);
    drop(runId, entry, 'removed', now);
    return 'removed';
  }
  const outcome = settled.get(settledKey(runId, id))?.outcome;
  if (outcome === 'applied' || outcome === 'sent') return 'applied';
  if (outcome === 'taken') return 'unavailable';
  if (outcome === 'moved') return 'moved';
  return 'unknown';
}

/**
 * The end of an answer: take every message still queued for the run and
 * refuse new ones until the run is opened again ({@link openSteering}).
 * Synchronous, so of a message queued and the end of the answer exactly one
 * comes first. The caller settles what it took ({@link settleSent},
 * {@link moveSteers}, {@link dropSteers}); until then a removal of a taken
 * message is answered `unavailable` (ask again), never `unknown`: it is not
 * gone, it may still be sent.
 *
 * @param {string} runId
 * @param {Object} [options]
 * @param {number} [options.now]
 * @returns {QueuedSteer[]} oldest first
 */
export function closeSteering(runId, { now = Date.now() } = {}) {
  if (!runId) return [];
  const live = pruneExpired(runId, now);
  queues.delete(runId);
  closed.set(runId, now);
  for (const entry of live) settle(runId, entry.id, 'taken', now);
  return live;
}

/**
 * A run starts (or continues after a pause) on this worker: it takes
 * messages again.
 *
 * @param {string} runId
 */
export function openSteering(runId) {
  if (runId) closed.delete(runId);
}

/**
 * Settle messages taken at the end of an answer as sent with the next turn,
 * and tell the stream of the run they were sent to (`steer/applied` with
 * `nextRunId`).
 *
 * @param {string} runId - The run whose answer ended.
 * @param {QueuedSteer[]} entries
 * @param {string} nextRunId - The run of the next turn.
 * @param {Object} [options]
 * @param {number} [options.now]
 */
export function settleSent(runId, entries, nextRunId, { now = Date.now() } = {}) {
  for (const entry of entries) {
    settle(runId, entry.id, 'sent', now);
    tell(runId, entry, SSE_V2_EVENTS.STEER_APPLIED, { nextRunId });
  }
}

/**
 * Move messages taken at the end of an answer into the queue of the next
 * turn's run, where a steer is read at its first step. Each stays removable
 * under the run it was sent to: a removal there follows it
 * ({@link cancelQueuedSteer}), and the chat read model names that run.
 *
 * @param {string} runId - The run whose answer ended.
 * @param {QueuedSteer[]} entries
 * @param {string} nextRunId - The run of the next turn.
 * @param {Object} [options]
 * @param {number} [options.now]
 */
export function moveSteers(runId, entries, nextRunId, { now = Date.now() } = {}) {
  for (const entry of entries) {
    settle(runId, entry.id, 'moved', now, nextRunId);
    enqueueSteer(nextRunId, { ...entry, originRunId: entry.originRunId || runId }, { now });
  }
}

/**
 * Settle messages taken at the end of an answer as dropped, and tell the
 * stream why (`steer/dropped`), so the client can give the text back.
 *
 * @param {string} runId
 * @param {QueuedSteer[]} entries
 * @param {string} reason - one of `STEER_DROP_REASONS`
 * @param {Object} [options]
 * @param {number} [options.now]
 */
export function dropSteers(runId, entries, reason, { now = Date.now() } = {}) {
  for (const entry of entries) drop(runId, entry, reason, now);
}

/** The transcript message the loop appends for a steer (explicit trust marker). */
export function steerMessage(steer) {
  return {
    role: 'user',
    content: `${STEER_MARKER} Mid-run instruction from the person running this task: ${neutraliseSteerMarker(steer.message)}`,
    // Kept for the readers that tell the person's own question from what the
    // loop or a person added mid-run (toolChoice, findingsDigest).
    _steer: true,
    _origin: 'person',
    ...(steer.id ? { _steerId: steer.id } : {})
  };
}

const defaultBus = { request, hasRemote };
const routeOf = runId => ({ route: { kind: RUN_PRESENCE_KIND, key: runId } });

/**
 * Route a message to the loop that owns `runId`.
 *
 * @param {string} runId
 * @param {Object} steer - see {@link enqueueSteer}
 * @param {Object} [deps] - test seams
 * @returns {Promise<'queued'|'relayed'|null>} where it went; null when no loop
 *   takes it: the run ended or is not running anywhere
 */
export async function steerRun(runId, steer, { runLog = defaultRunLog, bus = defaultBus } = {}) {
  const meta = runLog.getRunMeta(runId);
  if (meta?.owned) {
    if (meta.ended) return null;
    return enqueueSteer(runId, steer) ? 'queued' : null;
  }
  if (bus.hasRemote(RUN_PRESENCE_KIND, runId)) {
    const reply = await bus.request(STEER_CHANNEL, { runId, steer }, routeOf(runId));
    return reply?.queued === true ? 'relayed' : null;
  }
  return null;
}

/**
 * Remove a queued message, wherever its run is.
 *
 * @param {string} runId
 * @param {string} id
 * @param {Object} [options]
 * @param {string|null} [options.by] - The caller's actor id.
 * @param {Object} [options.runLog]
 * @param {Object} [options.bus]
 * @returns {Promise<'removed'|'applied'|'unknown'|'unavailable'>} `unavailable`:
 *   the worker that holds the run did not answer, or the answer is ending and
 *   what becomes of the message is being decided
 */
export async function cancelSteer(
  runId,
  id,
  { by, runLog = defaultRunLog, bus = defaultBus } = {}
) {
  const local = cancelQueuedSteer(runId, id, { by });
  if (local !== 'unknown') return local;
  if (runLog.getRunMeta(runId)?.owned) return 'unknown';
  if (!bus.hasRemote(RUN_PRESENCE_KIND, runId)) return 'unknown';
  const reply = await bus.request(STEER_CANCEL_CHANNEL, { runId, id, by }, routeOf(runId));
  if (!reply) return 'unavailable';
  return ['removed', 'applied', 'unavailable'].includes(reply.result) ? reply.result : 'unknown';
}

/**
 * The messages queued for a run, wherever its run is.
 *
 * @param {string|null|undefined} runId - Anything but a non-empty string lists nothing.
 * @param {Object} [options]
 * @param {Object} [options.runLog]
 * @param {Object} [options.bus]
 * @returns {Promise<Array<{id: string, runId: string, kind: string, text: string, at: string,
 *   chatId: string|null}>>} `runId`: see {@link pendingSteers}
 */
export async function listPendingSteers(runId, { runLog = defaultRunLog, bus = defaultBus } = {}) {
  if (typeof runId !== 'string' || !runId) return [];
  if (runLog.getRunMeta(runId)?.owned || queues.has(runId)) return pendingSteers(runId);
  if (!bus.hasRemote(RUN_PRESENCE_KIND, runId)) return [];
  const reply = await bus.request(STEER_PENDING_CHANNEL, { runId }, routeOf(runId));
  return Array.isArray(reply?.items) ? reply.items : [];
}

const isRunPayload = payload => typeof payload?.runId === 'string' && payload.runId.length > 0;

// The owning worker answers; any other worker stays silent (`undefined`), so a
// question the primary broadcasts is answered by the owner alone.
respond(STEER_CHANNEL, payload => {
  if (!isRunPayload(payload)) return undefined;
  const meta = defaultRunLog.getRunMeta(payload.runId);
  if (!meta?.owned) return undefined;
  if (meta.ended) return { queued: false };
  return { queued: enqueueSteer(payload.runId, payload.steer || {}) };
});

respond(STEER_CANCEL_CHANNEL, payload => {
  if (!isRunPayload(payload) || typeof payload.id !== 'string') return undefined;
  const result = cancelQueuedSteer(payload.runId, payload.id, { by: payload.by });
  if (result === 'unknown' && !defaultRunLog.getRunMeta(payload.runId)?.owned) return undefined;
  logger.debug('Queued message removal answered', {
    component: 'steering',
    runId: payload.runId,
    result
  });
  return { result };
});

/**
 * Why the messages a run did not read are dropped when it ends.
 *
 * @param {string} status - The run's `run/end` status (`RUN_STATUSES`).
 * @returns {string} one of `STEER_DROP_REASONS`
 */
export function endDropReasonOf(status) {
  if (status === 'paused') return 'run_paused';
  if (status === 'aborted') return 'run_stopped';
  if (status === 'error') return 'run_failed';
  return 'run_ended';
}

/**
 * A run that is not a chat turn (a workflow, an agent, an API run) has no next
 * turn its leftover could become: what it did not read when it ends is dropped
 * with a reason, never left to expire unseen. A chat turn decides its leftover
 * where it lets go of its chat (`services/chat/chatSteering.js`).
 *
 * @param {{runId: string, kind: string, status: string}} end
 */
export function dropLeftoverAtRunEnd({ runId, kind, status }) {
  if (kind === 'chat' || !queues.has(runId)) return;
  dropSteers(runId, closeSteering(runId), endDropReasonOf(status));
}

defaultRunLog.onRunEnd(dropLeftoverAtRunEnd);

respond(STEER_PENDING_CHANNEL, payload => {
  if (!isRunPayload(payload) || !defaultRunLog.getRunMeta(payload.runId)?.owned) return undefined;
  return { items: pendingSteers(payload.runId) };
});

/** Test seam. */
export function resetSteersForTests() {
  queues.clear();
  settled.clear();
  closed.clear();
}
