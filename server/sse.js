/**
 * Chat SSE sink.
 *
 * `clients` maps chatId → the open SSE response; `activeRequests` maps chatId →
 * the AbortController for the LLM call feeding it. Both are process-local, so
 * in cluster mode the worker handling a chat POST is frequently not the worker
 * holding that chat's SSE stream. Both maps are therefore presence maps
 * (`server/clusterBus.js`): membership is mirrored across workers, letting this
 * module relay events to whichever worker owns the stream instead of requiring
 * the connections to have landed together.
 */

import { actionTracker } from './actionTracker.js';
import { createPresenceMap, hasRemote, publish, subscribe } from './clusterBus.js';
import logger from './utils/logger.js';

/** chatId → { response, lastActivity, appId? } for locally held SSE streams. */
export const clients = createPresenceMap('sse');

/** chatId → AbortController for LLM calls running in this worker. */
export const activeRequests = createPresenceMap('request');

/** Bus channels. */
const EVENT_CHANNEL = 'sse:event';
const RAW_CHANNEL = 'sse:raw';
const ABORT_CHANNEL = 'chat:abort';
const CLOSE_CHANNEL = 'chat:close';

export function sendSSE(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

/**
 * Write an action-tracker step to this worker's SSE client for the chat.
 *
 * @param {object} step - `fire-sse` payload; must carry `chatId` and `event`.
 * @returns {boolean} True if it reached a live local client. False means either
 *   no local registration or a dead socket — in both cases the caller should
 *   consider relaying, because another worker may hold the real stream.
 */
export function deliverSSEEvent(step) {
  const { chatId, event } = step;
  if (!chatId) return false;
  if (!clients.has(chatId)) return false;

  const clientEntry = clients.get(chatId);
  clientEntry.lastActivity = new Date(); // Keep connection marked as active
  try {
    sendSSE(clientEntry.response, event, step);
    return true;
  } catch (error) {
    // The socket is most likely dead (peer closed, write-after-end, etc.).
    // Without this cleanup, every subsequent fire-sse event would re-throw
    // and the Map entry would linger until cleanupInactiveClients evicts it
    // 5 minutes later — meanwhile the LLM keeps streaming into a void and
    // the activeRequests controller leaks.
    logger.error('Error sending SSE action event; tearing down dead client', {
      component: 'SSE',
      chatId,
      error: error?.message || String(error)
    });
    try {
      const controller = activeRequests.get(chatId);
      if (controller) {
        controller.abort();
        activeRequests.delete(chatId);
      }
    } catch (abortErr) {
      logger.error('Error aborting activeRequest after SSE write failure', {
        component: 'SSE',
        chatId,
        error: abortErr?.message || String(abortErr)
      });
    }
    // Only delete the entry if it's still the one we just wrote to — avoids
    // wiping out a freshly-reconnected entry on the same chatId.
    if (clients.get(chatId) === clientEntry) {
      clients.delete(chatId);
    }
    return false;
  }
}

actionTracker.on('fire-sse', step => {
  const { chatId } = step;
  if (!chatId) return;
  if (deliverSSEEvent(step)) return;
  // Not ours. If another worker registered this chat's stream, hand the event
  // over; otherwise nobody is listening anywhere and dropping it is correct.
  if (hasRemote('sse', chatId)) {
    logger.debug('Relaying SSE event to the worker holding this chat', {
      component: 'SSE',
      chatId,
      event: step.event,
      pid: process.pid
    });
    publish(EVENT_CHANNEL, step, { kind: 'sse', key: chatId });
  }
});

// Events relayed from another worker are written straight to the local client.
// They must not go back through actionTracker, which would re-enter the
// fire-sse handler above and bounce the event around the cluster.
subscribe(EVENT_CHANNEL, step => {
  const delivered = deliverSSEEvent(step);
  logger.debug('Received relayed SSE event', {
    component: 'SSE',
    chatId: step.chatId,
    event: step.event,
    delivered,
    pid: process.pid
  });
});

/**
 * A minimal stand-in for the SSE `response` of a chat held by another worker.
 *
 * Most streaming output reaches the browser through `actionTracker`, which the
 * relay above already handles. A few callers still take the raw response object
 * — `RequestBuilder` uses its presence to decide `stream: true`, and
 * `ApiKeyVerifier` writes an error frame straight to it. Handing those a null
 * would silently downgrade a cross-worker chat to non-streaming, so they get
 * this shim instead: same `write`/`end` surface, forwarded over the bus.
 *
 * @param {string} chatId
 * @returns {{ write: (chunk: string) => boolean, end: () => void, remote: true }}
 */
export function createRemoteChatResponse(chatId) {
  return {
    remote: true,
    write(chunk) {
      publish(RAW_CHANNEL, { chatId, chunk: String(chunk) }, { kind: 'sse', key: chatId });
      return true;
    },
    end() {
      publish(CLOSE_CHANNEL, { chatId }, { kind: 'sse', key: chatId });
    }
  };
}

subscribe(RAW_CHANNEL, ({ chatId, chunk }) => {
  const client = clients.get(chatId);
  if (!client) return;
  client.lastActivity = new Date();
  try {
    client.response.write(chunk);
  } catch (error) {
    logger.warn('Error writing relayed raw SSE chunk', {
      component: 'SSE',
      chatId,
      error: error?.message || String(error)
    });
  }
});

/**
 * Resolve the SSE response to stream this chat into, local or remote.
 *
 * @param {string} chatId
 * @returns {object|null} A writable response-like object, or null when no SSE
 *   stream for this chat exists anywhere in the cluster.
 */
export function getChatResponseSink(chatId) {
  const local = clients.get(chatId);
  if (local) {
    local.lastActivity = new Date();
    return local.response;
  }
  if (hasRemote('sse', chatId)) return createRemoteChatResponse(chatId);
  return null;
}

/**
 * Whether an SSE stream for this chat is open anywhere in the cluster.
 *
 * The request path uses this to choose between streaming and the synchronous
 * fallback, so it has to account for streams held by other workers — a local
 * `clients.has()` would send every cross-worker chat down the non-streaming
 * path.
 */
export function hasChatClient(chatId) {
  return clients.has(chatId) || hasRemote('sse', chatId);
}

/** Whether an LLM call for this chat is in flight anywhere in the cluster. */
export function hasActiveChatRequest(chatId) {
  return activeRequests.has(chatId) || hasRemote('request', chatId);
}

/**
 * Abort the in-flight LLM call for a chat, wherever it is running.
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
