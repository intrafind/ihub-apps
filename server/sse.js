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

import { createPresenceMap, hasRemote, publish, subscribe } from './clusterBus.js';
import { setEnvelopeDelivery, resetStream, stampSeq } from './services/loop/RunStream.js';
import logger from './utils/logger.js';

/** streamId → { response, lastActivity, appId? } for locally held SSE streams. */
export const clients = createPresenceMap('sse');

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
 */
const durableChats = createPresenceMap('chat-durable');

/** Bus channels. */
const EVENT_CHANNEL = 'sse:event';
const ABORT_CHANNEL = 'chat:abort';
const CLOSE_CHANNEL = 'chat:close';

/** Write one SSE frame. `data` is serialized as JSON unless it already is a string. */
export function sendSSE(res, event, data) {
  res.write(`event: ${event}\n`);
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
      abortChatRequestOnDisconnect(streamId);
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
 * Deliver locally or relay to the worker holding the stream. Installed as the
 * RunStream delivery function, so every producer in the process goes through
 * here without knowing about the cluster.
 */
export function routeEnvelope(streamId, envelope) {
  if (deliverEnvelope(streamId, envelope)) return true;
  // Not ours. If another worker registered this stream, hand the envelope
  // over; otherwise nobody is listening anywhere and dropping it is correct.
  if (hasRemote('sse', streamId)) {
    publish(EVENT_CHANNEL, { streamId, envelope }, { kind: 'sse', key: streamId });
    return true;
  }
  return false;
}

setEnvelopeDelivery(routeEnvelope);

// Envelopes relayed from another worker are written straight to the local
// client. They must not go back through routeEnvelope, which would bounce the
// frame around the cluster.
subscribe(EVENT_CHANNEL, ({ streamId, envelope }) => {
  const delivered = deliverEnvelope(streamId, envelope);
  logger.debug('Received relayed SSE envelope', {
    component: 'SSE',
    streamId,
    type: envelope?.type,
    delivered,
    pid: process.pid
  });
});

/**
 * Whether an SSE stream for this chat is open anywhere in the cluster.
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
  return hasRemote('sse', chatId);
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
 * @returns {boolean} True if the abort was applied locally or relayed.
 */
export function abortChatRequest(chatId) {
  if (activeRequests.has(chatId)) {
    try {
      activeRequests.get(chatId).abort();
      activeRequests.delete(chatId);
      logger.info('Aborted request', { component: 'SSE', chatId });
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
    publish(ABORT_CHANNEL, { chatId }, { kind: 'request', key: chatId });
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
 * @returns {boolean} True if an abort was applied locally or relayed.
 */
export function abortChatRequestOnDisconnect(chatId) {
  if (isChatDurable(chatId)) {
    logger.info('Client gone; durable chat turn keeps running', { component: 'SSE', chatId });
    return false;
  }
  return abortChatRequest(chatId);
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

subscribe(ABORT_CHANNEL, ({ chatId }) => {
  if (!activeRequests.has(chatId)) return;
  try {
    activeRequests.get(chatId).abort();
    activeRequests.delete(chatId);
    logger.info('Aborted request on behalf of another worker', { component: 'SSE', chatId });
  } catch (error) {
    logger.error('Error aborting relayed request', {
      component: 'SSE',
      chatId,
      error: error.message
    });
  }
});

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
