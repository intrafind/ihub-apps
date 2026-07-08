/**
 * Shared SSE connection lifecycle helper.
 *
 * Every long-lived SSE endpoint in this codebase (chat, agent runs, workflow
 * executions) needs the same four things: the event-stream headers, a
 * Map<id, entry> registration that "pins" the entry so a stale close handler
 * from a superseded connection can't delete a fresh reconnect, a heartbeat
 * that self-evicts on write failure, and close teardown. This used to be
 * hand-rolled (with copy-pasted comments) in three separate route files.
 *
 *   const channel = createSseChannel({
 *     req, res, id: chatId, map: clients, component: 'sessionRoutes',
 *     onClose: ({ isCurrent }) => { if (isCurrent) abortActiveRequest(chatId); }
 *   });
 *   channel.send('connected', { chatId });
 */

import logger from './logger.js';

/**
 * Set up an SSE connection registered under `id` in `map`, with a heartbeat
 * and pinned-entry close teardown. Returns helpers for sending events and
 * checking whether this connection is still the current one for `id`.
 */
export function createSseChannel({ req, res, id, map, component, heartbeatMs = 30000, onClose }) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  const myEntry = { response: res, lastActivity: new Date() };
  map.set(id, myEntry);

  // Pin this registration so a stale close/heartbeat handler from a previous
  // SSE connection on the same id can't delete a fresh entry after the
  // client reconnects.
  const isCurrent = () => map.get(id) === myEntry;

  const send = (event, data) => {
    const client = map.get(id);
    if (client) client.lastActivity = new Date();
    try {
      res.write(
        `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`
      );
      return true;
    } catch (error) {
      logger.error('Error sending SSE event', { component, id, event, error: error.message });
      return false;
    }
  };

  const heartbeatInterval = setInterval(() => {
    if (!isCurrent()) {
      clearInterval(heartbeatInterval);
      return;
    }
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeatInterval);
      if (isCurrent()) map.delete(id);
    }
  }, heartbeatMs);

  req.on('close', () => {
    clearInterval(heartbeatInterval);
    const wasCurrent = isCurrent();
    if (wasCurrent) map.delete(id);
    onClose?.({ isCurrent: wasCurrent });
    logger.info('SSE connection closed', { component, id });
  });

  return { send, isCurrent, entry: myEntry };
}

/**
 * Sweep entries whose `lastActivity` is older than `timeoutMs`, ending the
 * response and removing them from `map`. Generalizes the chat-only
 * cleanupInactiveClients so agent/workflow SSE maps can get the same
 * dead-client sweeping.
 */
export function sweepInactiveClients(map, { timeoutMs = 5 * 60 * 1000, component, onEvict } = {}) {
  const now = new Date();
  for (const [id, client] of map.entries()) {
    if (now - client.lastActivity <= timeoutMs) continue;
    try {
      client.response.end();
    } catch (endErr) {
      // The socket may already be dead — end() can throw on an already
      // destroyed stream. We're cleaning up anyway, so just log and continue.
      logger.warn('Error ending inactive client response', {
        component,
        id,
        error: endErr?.message || String(endErr)
      });
    }
    map.delete(id);
    onEvict?.(id);
    logger.info('Removed inactive client', { component, id });
  }
}

/**
 * Start a periodic sweep of `map` for inactive clients. Returns the interval
 * handle (currently unused by callers — the process lives as long as the
 * server does — but returned for symmetry/testability).
 */
export function startInactiveClientSweep(map, { intervalMs = 60 * 1000, ...sweepOptions } = {}) {
  return setInterval(() => sweepInactiveClients(map, sweepOptions), intervalMs);
}
