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
import { setEnvelopeDelivery } from './services/loop/RunStream.js';
import logger from './utils/logger.js';

/** streamId → { response, lastActivity, appId? } for locally held SSE streams. */
export const clients = createPresenceMap('sse');

/** chatId → AbortController for model turns running in this worker. */
export const activeRequests = createPresenceMap('request');

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
    sendSSE(clientEntry.response, envelope.type, envelope);
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
      const controller = activeRequests.get(streamId);
      if (controller) {
        controller.abort();
        activeRequests.delete(streamId);
      }
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
});
