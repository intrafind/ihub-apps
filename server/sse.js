// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Chat SSE sink — SSE v2 delivery.
 *
 * `clients` maps streamId (the chatId a browser subscribed with) → the open
 * SSE response; `activeRequests` maps chatId → the AbortController of the
 * model turn feeding it. Both are process-local, so in cluster mode the worker
 * handling a chat POST is frequently not the worker holding that chat's SSE
 * stream. Both maps are therefore presence maps (`server/clusterBus.js`):
 * membership is mirrored across workers, letting this module relay envelopes
 * to whichever worker owns the stream.
 *
 * Every frame written here is an SSE v2 envelope (`services/loop/RunStream.js`
 * builds them): `event: <type>` and `data: { v: 2, seq, runId, ts, type, data }`.
 */

import { createPresenceMap, hasRemote, lookupRemote, publish, subscribe } from './clusterBus.js';
import {
  setEnvelopeDelivery,
  resetStream,
  stampSeq,
  buildEnvelope,
  currentSeq,
  flushStream
} from './services/loop/RunStream.js';
import { SSE_V2_EVENTS } from '../shared/runEvents.js';
import { createSseChannel } from './utils/sseChannel.js';
import logger from './utils/logger.js';
import {
  abortCause,
  abortReason,
  describeCause,
  normalizeAbortCause
} from './services/chat/abortCause.js';

/** streamId → { response, lastActivity, appId? } for locally held SSE streams. */
export const clients = createPresenceMap('sse');

/**
 * chatId → `{ response, lastActivity, seq }` for chat turns streamed on their
 * own POST (`Accept: text/event-stream`).
 *
 * A plain Map, not a presence map: the frames of such a turn are produced in
 * the worker that holds its POST, so nobody else ever needs to know about it,
 * and registering one costs no bus traffic. {@link routeEnvelope} tries it
 * before the GET streams, which is what keeps the turn's frames off the bus.
 */
export const postStreams = new Map();

/** chatId → AbortController for model turns running in this worker. */
export const activeRequests = createPresenceMap('request');

/**
 * chatId → how many durable (persisted) turns are running for that chat.
 *
 * A durable turn outlives the browser that started it: its answer is written
 * to the chat store whether or not anyone is watching, so the paths that abort
 * a run because the client went away have to leave it alone. Presence-mapped
 * like the two maps above, because the worker that notices the disconnect is
 * frequently not the worker running the turn.
 *
 * A count rather than a flag because turns on one chat overlap by design:
 * `ChatService.runTurn` supersedes an in-flight turn instead of refusing the
 * new one, and the superseded turn's request handler then unwinds *while the
 * new one is still producing*. With a plain flag that unwind would drop the
 * mark the live turn depends on, leaving it one disconnect away from being
 * killed silently.
 *
 * `shared: true` is the same argument one level up. Presence is exclusive by
 * default — one SSE stream lives in one worker — but two overlapping turns on
 * one chat can sit in two workers, and under the exclusive rule the second
 * worker's retraction removed the cluster-wide mark while the first was still
 * generating. The local count is then right and the mirror is wrong, which is
 * worse than either: a third worker holding the browser's stream sees the chat
 * as ephemeral and relays an abort on disconnect.
 */
const durableChats = createPresenceMap('chat-durable', { shared: true });

/** Bus channels. */
const EVENT_CHANNEL = 'sse:event';
const ABORT_CHANNEL = 'chat:abort';
const CLOSE_CHANNEL = 'chat:close';

/**
 * Write one SSE frame. `data` is serialized as JSON unless it already is a
 * string. An envelope with a run frame counter also gets an `id:` line
 * (`{runId}:{rseq}`); the client does not rely on it, the resume does not need
 * it, but it names the frame for any SSE reader that wants to.
 */
export function sendSSE(res, event, data) {
  res.write(`event: ${event}\n`);
  if (data && typeof data === 'object' && data.rseq) res.write(`id: ${data.runId}:${data.rseq}\n`);
  res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

/**
 * Write one envelope to this worker's SSE client for the stream.
 *
 * @param {string} streamId
 * @param {object} envelope - SSE v2 envelope
 * @returns {boolean} True if it reached a live local client. False means either
 *   no local registration or a dead socket — in both cases the caller should
 *   consider relaying, because another worker may hold the real stream.
 */
export function deliverEnvelope(streamId, envelope) {
  if (!streamId || !envelope) return false;
  if (!clients.has(streamId)) return false;

  const clientEntry = clients.get(streamId);
  clientEntry.lastActivity = new Date(); // Keep connection marked as active
  // A stream being resumed holds live frames until its snapshot is written
  // (`writeStreamStart`).
  if (clientEntry.held) {
    clientEntry.held.push(envelope);
    return true;
  }
  try {
    // This worker owns the stream, so it owns the stream's sequence: frames
    // produced here and frames relayed from other workers get one counter.
    const stamped = stampSeq(streamId, envelope);
    sendSSE(clientEntry.response, stamped.type, stamped);
    return true;
  } catch (error) {
    // The socket is most likely dead (peer closed, write-after-end, etc.).
    // Without this cleanup, every subsequent frame would re-throw and the Map
    // entry would linger until the inactivity sweep evicts it — meanwhile the
    // model keeps streaming into a void and the activeRequests controller leaks.
    logger.error('Error writing SSE envelope; tearing down dead client', {
      component: 'SSE',
      streamId,
      type: envelope.type,
      error: error?.message || String(error)
    });
    try {
      abortChatRequestOnDisconnect(
        streamId,
        abortCause('client_disconnected', { via: 'SSE write failed' })
      );
    } catch (abortErr) {
      logger.error('Error aborting activeRequest after SSE write failure', {
        component: 'SSE',
        streamId,
        error: abortErr?.message || String(abortErr)
      });
    }
    // Only delete the entry if it's still the one we just wrote to — avoids
    // wiping out a freshly-reconnected entry on the same streamId.
    if (clients.get(streamId) === clientEntry) {
      clients.delete(streamId);
      // A durable turn is still producing frames under this stream's run:
      // dropping the seq counter would restart numbering mid-run, and dropping
      // the run binding would re-parent every later tool-progress frame to a
      // synthetic run. The LRU cap in RunStream bounds what we keep.
      if (!isChatDurable(streamId)) resetStream(streamId);
    }
    return false;
  }
}

/**
 * Write one envelope to a POST stream entry. The POST stream numbers its own
 * frames: it starts a sequence epoch with its `stream/connected`, and sharing
 * the GET counter would interleave two connections' numbers.
 *
 * @param {string} streamId
 * @param {object} entry - The `postStreams` entry
 * @param {object} envelope
 * @returns {boolean} True if written. False when its socket is dead (it is then
 *   torn down like a GET whose write failed).
 */
function writePostEntry(streamId, entry, envelope) {
  if (entry.response.destroyed) return false;
  try {
    entry.seq += 1;
    entry.lastActivity = new Date();
    sendSSE(entry.response, envelope.type, { ...envelope, seq: entry.seq });
    if (envelope.type === SSE_V2_EVENTS.RUN_ENDED) entry.endedRuns.add(envelope.runId);
    return true;
  } catch (error) {
    logger.error('Error writing to a chat POST stream; tearing it down', {
      component: 'SSE',
      streamId,
      type: envelope.type,
      error: error?.message || String(error)
    });
    if (postStreams.get(streamId) === entry) postStreams.delete(streamId);
    abortChatRequestOnDisconnect(
      streamId,
      abortCause('client_disconnected', { via: 'POST stream write failed' })
    );
    return false;
  }
}

/**
 * Write one envelope to the current POST stream of a turn on this chat, if
 * this worker holds one.
 *
 * @param {string} streamId
 * @param {object} envelope
 * @returns {boolean} True if written.
 */
export function deliverToPostStream(streamId, envelope) {
  const entry = postStreams.get(streamId);
  if (!entry || !envelope) return false;
  return writePostEntry(streamId, entry, envelope);
}

/**
 * Stream a chat turn on its own POST response (`Accept: text/event-stream`).
 *
 * Called at the turn's commit point: from here on the response is an SSE
 * stream, and a refusal can only be a `stream/error` frame. Registers the
 * response as this chat's POST stream, writes `stream/connected`, and on the
 * connection closing early aborts a temporary turn (a durable one keeps
 * running, as with the GET).
 *
 * The returned handle belongs to this request: `write` reaches this response
 * only, and does nothing once a newer POST on the same chat took its place, so
 * a late frame of one turn never lands on the next turn's stream.
 *
 * A POST's `req` emits `close` as soon as its body has been read, so the
 * disconnect is taken from `res`, which closes with the connection.
 *
 * @param {object} params
 * @param {import('express').Request} params.req
 * @param {import('express').Response} params.res
 * @param {string} params.chatId
 * @returns {{isOpen: () => boolean, write: (envelope: object) => boolean,
 *   hasEnded: (runId: string) => boolean, end: () => void}} `hasEnded`: whether
 *   this stream already carried that run's `run/ended`.
 */
export function openChatPostStream({ req, res, chatId }) {
  // Gone before the turn committed (the client gave up while the request was
  // being checked): never registered, so another POST's entry stays in place
  // and nothing is written to a dead socket.
  if (res.destroyed) {
    return { isOpen: () => false, write: () => false, hasEnded: () => false, end: () => {} };
  }
  const channel = createSseChannel({
    req,
    res,
    closeOn: res,
    id: chatId,
    map: postStreams,
    component: 'sessionRoutes',
    onClose: ({ isCurrent }) => {
      if (!isCurrent || res.writableFinished) return;
      abortChatRequestOnDisconnect(
        chatId,
        abortCause('client_disconnected', { via: 'POST stream closed' })
      );
    }
  });
  const entry = channel.entry;
  entry.seq = 0;
  entry.endedRuns = new Set();
  const isOpen = () => channel.isCurrent() && !res.destroyed;
  const write = envelope => isOpen() && writePostEntry(chatId, entry, envelope);
  write(
    buildEnvelope({
      streamId: chatId,
      runId: chatId,
      type: SSE_V2_EVENTS.STREAM_CONNECTED,
      data: { runId: chatId, lastSeq: 0 }
    })
  );
  return {
    isOpen,
    write,
    hasEnded: runId => entry.endedRuns.has(runId),
    end: () => {
      // What the turn's last delta window still holds goes out first.
      if (channel.isCurrent()) {
        flushStream(chatId);
        postStreams.delete(chatId);
      }
      if (!res.writableEnded) res.end();
    }
  };
}

/**
 * Start a GET stream: write `stream/connected`, then — for a resumed run — the
 * resume frames, then whatever arrived live meanwhile.
 *
 * Written straight to this connection rather than routed: a POST stream on the
 * same chat would otherwise get this connection's own first frames too.
 *
 * A resumed stream holds its live frames (`entry.held`, see
 * {@link deliverEnvelope}) while the snapshot is being fetched. Frames of the
 * resumed run numbered up to the snapshot's cursor (`rseq <= upTo`) are in the
 * snapshot already and are dropped; everything else is written after it.
 *
 * @param {string} streamId - The chat id
 * @param {object} entry - This connection's `clients` entry
 * @param {object} [resume]
 * @param {object[]} [resume.frames] - Snapshot and ledger frames, in order
 * @param {string} [resume.runId] - The resumed run
 * @param {number} [resume.upTo] - The run frame counter the frames cover
 * @returns {boolean} False when this connection is no longer the chat's stream.
 */
export function writeStreamStart(streamId, entry, { frames = [], runId = null, upTo = 0 } = {}) {
  const held = entry.held || [];
  delete entry.held;
  if (clients.get(streamId) !== entry) return false;
  deliverEnvelope(
    streamId,
    buildEnvelope({
      streamId,
      runId: streamId,
      type: SSE_V2_EVENTS.STREAM_CONNECTED,
      data: { runId: streamId, lastSeq: currentSeq(streamId) }
    })
  );
  for (const frame of frames) deliverEnvelope(streamId, frame);
  for (const frame of held) {
    if (runId && frame.runId === runId && frame.rseq && frame.rseq <= upTo) continue;
    deliverEnvelope(streamId, frame);
  }
  return true;
}

/**
 * Deliver locally or relay to the worker holding the stream. Installed as the
 * RunStream delivery function, so every producer in the process goes through
 * here without knowing about the cluster.
 */
export function routeEnvelope(streamId, envelope) {
  // A POST stream and a GET stream on the same chat both get every frame: a
  // second tab, or a client that re-attached on the GET while its old POST
  // socket is half-open and not yet detected as dead, must still see the
  // turn end. With only the POST (the usual case) nothing below matches and
  // the bus stays quiet.
  const toPost = deliverToPostStream(streamId, envelope);
  if (deliverEnvelope(streamId, envelope)) return true;
  // Not ours. If another worker registered this stream, hand the envelope
  // over; otherwise nobody else is listening.
  if (hasRemote('sse', streamId)) {
    publish(EVENT_CHANNEL, { streamId, envelope }, { kind: 'sse', key: streamId });
    return true;
  }
  return toPost;
}

setEnvelopeDelivery(routeEnvelope);

// Envelopes relayed from another worker are written straight to the local
// client. They must not go back through routeEnvelope, which would bounce the
// frame around the cluster.
subscribe(EVENT_CHANNEL, ({ streamId, envelope }) => {
  const delivered = deliverEnvelope(streamId, envelope);
  const logFields = {
    component: 'SSE',
    streamId,
    type: envelope?.type,
    delivered,
    pid: process.pid
  };
  if (delivered) {
    // One line per streamed delta: below debug so it only shows at `silly`.
    logger.silly('Relayed SSE envelope delivered', logFields);
  } else {
    // The client for this stream is gone from this worker (closed or moved),
    // which is the case worth seeing when debugging cross-worker streaming.
    logger.debug('Relayed SSE envelope had no local client', logFields);
  }
});

/**
 * Whether an SSE stream for this chat is open anywhere in the cluster: a GET
 * stream, or the POST of a turn streamed on its own response (held by this
 * worker, which produces that turn's frames).
 *
 * The request path uses this to choose between streaming and the synchronous
 * answer, so it has to account for streams held by other workers — a local
 * `clients.has()` would send every cross-worker chat down the non-streaming
 * path.
 */
export function hasChatClient(chatId) {
  if (clients.has(chatId)) {
    // Refresh the activity marker so a busy chat is never swept as idle.
    clients.get(chatId).lastActivity = new Date();
    return true;
  }
  return postStreams.has(chatId) || hasRemote('sse', chatId);
}

/**
 * Whether an SSE stream for this chat is open anywhere in the cluster, asking
 * the primary when this worker has not heard of one.
 *
 * For the start of a chat turn. The browser opens the stream and sends its
 * message right after; under load the message can reach a worker that has not
 * yet learnt of a stream another worker opened a moment ago. `hasChatClient`
 * would then say no and every frame of the turn would be dropped, leaving the
 * browser without an answer (#3674). A yes from the primary is mirrored
 * locally, so the turn's frames are relayed from the first one on.
 */
export async function locateChatClient(chatId) {
  return hasChatClient(chatId) || (await lookupRemote('sse', chatId));
}

/** Whether a model turn for this chat is in flight anywhere in the cluster. */
export function hasActiveChatRequest(chatId) {
  return activeRequests.has(chatId) || hasRemote('request', chatId);
}

/**
 * Mark a chat's in-flight turn as durable, so losing the client no longer
 * cancels it. Called when a persisted turn starts.
 *
 * Every call must be paired with exactly one {@link clearChatDurable}: the
 * mark is released when the last durable turn on the chat has ended, not when
 * the first one does.
 *
 * @param {string} chatId
 */
export function markChatDurable(chatId) {
  if (!chatId) return;
  durableChats.set(chatId, (durableChats.get(chatId) || 0) + 1);
}

/**
 * Release one durable turn's hold on a chat. Called when that turn ends,
 * whatever its outcome — once the last one has, a disconnect aborts again,
 * because there is nothing left to protect.
 *
 * @param {string} chatId
 */
export function clearChatDurable(chatId) {
  if (!chatId) return;
  const remaining = (durableChats.get(chatId) || 0) - 1;
  if (remaining > 0) durableChats.set(chatId, remaining);
  else durableChats.delete(chatId);
}

/**
 * Whether a durable turn is running for this chat anywhere in the cluster.
 *
 * @param {string} chatId
 * @returns {boolean}
 */
export function isChatDurable(chatId) {
  if (!chatId) return false;
  return durableChats.has(chatId) || hasRemote('chat-durable', chatId);
}

/**
 * Abort the in-flight model turn for a chat, wherever it is running.
 *
 * The cause is the abort reason: the turn reads it back and records who
 * stopped it, from where and when (`services/chat/abortCause.js`). A caller
 * that passes none is recorded as `unknown`.
 *
 * @param {string} chatId
 * @param {Object} [cause] - From `abortCause()` / `userAbortCause()`.
 * @param {Object} [options]
 * @param {number} [options.before] - Epoch ms. Only a turn that started at or before it is
 *   aborted, so an abort that arrives late never cancels a turn that began after it was
 *   decided (a superseding turn names the moment it started).
 * @returns {boolean} True if the abort was applied locally or relayed.
 */
export function abortChatRequest(chatId, cause, { before } = {}) {
  const normalized = normalizeAbortCause(cause);
  if (activeRequests.has(chatId)) {
    try {
      activeRequests.get(chatId).abort(abortReason(normalized));
      activeRequests.delete(chatId);
      logger.info('Aborted request', {
        component: 'SSE',
        chatId,
        ...describeCause(normalized)
      });
    } catch (error) {
      logger.error('Error aborting request', {
        component: 'SSE',
        chatId,
        error: error.message
      });
    }
    return true;
  }
  if (hasRemote('request', chatId)) {
    publish(
      ABORT_CHANNEL,
      { chatId, cause: normalized, ...(before ? { before } : {}) },
      { kind: 'request', key: chatId }
    );
    logger.info('Abort relayed to the worker running the request', {
      component: 'SSE',
      chatId,
      ...describeCause(normalized)
    });
    return true;
  }
  return false;
}

/**
 * Abort a chat's turn because its client went away — the SSE socket closed, a
 * write to it failed, or the inactivity sweep evicted it.
 *
 * The only difference from {@link abortChatRequest} is that a durable turn is
 * left running: it is being persisted, so the user gets the answer when they
 * come back. `abortChatRequest` itself stays unconditional, because the Stop
 * button has to work on a durable turn too.
 *
 * @param {string} chatId
 * @param {Object} [cause] - Defaults to `client_disconnected`.
 * @returns {boolean} True if an abort was applied locally or relayed.
 */
export function abortChatRequestOnDisconnect(chatId, cause) {
  if (isChatDurable(chatId)) {
    logger.info('Client gone; durable chat turn keeps running', { component: 'SSE', chatId });
    return false;
  }
  return abortChatRequest(
    chatId,
    cause || abortCause('client_disconnected', { via: 'SSE connection closed' })
  );
}

/**
 * End the SSE response for a chat, wherever it is held, and drop the entry.
 *
 * @returns {boolean} True if the close was applied locally or relayed.
 */
export function closeChatClient(chatId) {
  const client = clients.get(chatId);
  if (client) {
    try {
      client.response.end();
    } catch (error) {
      // The socket may already be dead (write-after-end on an already
      // destroyed stream). We're tearing it down anyway, so just log.
      logger.warn('Error ending client response', {
        component: 'SSE',
        chatId,
        error: error?.message || String(error)
      });
    }
    clients.delete(chatId);
    resetStream(chatId);
    return true;
  }
  if (hasRemote('sse', chatId)) {
    publish(CLOSE_CHANNEL, { chatId }, { kind: 'sse', key: chatId });
    return true;
  }
  return false;
}

/**
 * Apply an abort another worker relayed to the turn running here.
 *
 * @param {{chatId: string, cause?: Object, before?: number}} message
 * @returns {boolean} Whether a turn was aborted.
 */
export function applyRelayedAbort({ chatId, cause, before }) {
  if (!activeRequests.has(chatId)) return false;
  // A turn that began after the abort was decided is not the one it meant.
  if (before && activeRequests.get(chatId).startedAt > before) return false;
  try {
    const normalized = normalizeAbortCause(cause);
    activeRequests.get(chatId).abort(abortReason(normalized));
    activeRequests.delete(chatId);
    logger.info('Aborted request on behalf of another worker', {
      component: 'SSE',
      chatId,
      ...describeCause(normalized)
    });
    return true;
  } catch (error) {
    logger.error('Error aborting relayed request', {
      component: 'SSE',
      chatId,
      error: error.message
    });
    return false;
  }
}

subscribe(ABORT_CHANNEL, applyRelayedAbort);

subscribe(CLOSE_CHANNEL, ({ chatId }) => {
  const client = clients.get(chatId);
  if (!client) return;
  try {
    client.response.end();
  } catch (error) {
    logger.warn('Error ending client response on relayed close', {
      component: 'SSE',
      chatId,
      error: error?.message || String(error)
    });
  }
  clients.delete(chatId);
  resetStream(chatId);
});
