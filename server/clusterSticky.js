/**
 * Sticky session cluster primary.
 *
 * Node.js's built-in cluster scheduler distributes incoming TCP connections
 * round-robin (or OS-scheduled) across workers. That breaks SSE-based chat
 * because our streaming state (`clients` and `activeRequests` maps in
 * `server/sse.js`, and the `actionTracker` EventEmitter) lives in the worker's
 * process memory. A client that opens an SSE stream on worker A and then POSTs
 * a prompt that lands on worker B will never receive tokens and cannot cancel.
 *
 * This module replaces the default scheduler with a simple sticky router:
 *   - Primary owns the real listening socket (`net.createServer`).
 *   - Each incoming connection is hashed by `remoteAddress` to a worker index.
 *   - The paused socket handle is forwarded to that worker over IPC.
 *   - Workers re-emit the connection on their HTTP server and resume it.
 *
 * The same browser (same source IP) therefore always lands on the same worker
 * for the lifetime of a chat session, so all per-chat in-memory state remains
 * consistent without any cross-worker coordination.
 *
 * Tradeoff: many users sharing one source IP (NAT, corporate proxy) will pile
 * on the same worker. For that case, deploy behind a reverse proxy that does
 * cookie or chatId-aware stickiness, or migrate to a Redis pub/sub fan-out.
 */

import net from 'node:net';
import { createHash } from 'node:crypto';
import logger from './utils/logger.js';

const STICKY_MESSAGE = 'sticky:connection';

function hashToIndex(key, size) {
  if (size <= 1) return 0;
  const digest = createHash('sha256').update(String(key)).digest();
  return digest.readUInt32LE(0) % size;
}

function pickWorker(workers, key) {
  if (!workers.length) return null;
  const idx = hashToIndex(key, workers.length);
  const candidate = workers[idx];
  if (candidate && !candidate.isDead?.()) return candidate;
  for (let offset = 1; offset < workers.length; offset++) {
    const fallback = workers[(idx + offset) % workers.length];
    if (fallback && !fallback.isDead?.()) return fallback;
  }
  return null;
}

/**
 * Start a sticky TCP listener on the primary process.
 *
 * @param {object} options
 * @param {() => Array} options.getWorkers - Returns the current list of live workers.
 *   Called for every connection so that replaced workers (after a crash
 *   restart) are picked up without restarting the primary.
 * @param {number} options.port
 * @param {string} options.host
 * @param {(server: net.Server) => void} [options.onListening]
 */
export function startStickyPrimary({ getWorkers, port, host, onListening }) {
  const server = net.createServer({ pauseOnConnect: true }, connection => {
    const workers = getWorkers();
    if (!workers.length) {
      connection.destroy();
      return;
    }
    const routingKey = connection.remoteAddress || String(connection.remotePort || Math.random());
    const worker = pickWorker(workers, routingKey);
    if (!worker) {
      connection.destroy();
      return;
    }
    try {
      worker.send(STICKY_MESSAGE, connection, err => {
        if (err) {
          logger.warn({
            component: 'StickyCluster',
            message: 'Failed to hand off connection to worker',
            workerPid: worker.process?.pid,
            error: err.message
          });
          connection.destroy();
        }
      });
    } catch (err) {
      logger.error({
        component: 'StickyCluster',
        message: 'Error forwarding connection to worker',
        workerPid: worker.process?.pid,
        error: err.message
      });
      connection.destroy();
    }
  });

  server.on('error', err => {
    logger.error({
      component: 'StickyCluster',
      message: 'Sticky primary listener error',
      error: err.message,
      code: err.code
    });
  });

  server.listen(port, host, () => {
    if (typeof onListening === 'function') onListening(server);
  });

  return server;
}

/**
 * Wire a worker's HTTP/HTTPS server to receive sticky connections from the
 * primary. The worker must NOT call `server.listen()` on the public port when
 * running inside a sticky cluster — connections arrive exclusively via IPC.
 */
export function attachStickyWorker(httpServer) {
  process.on('message', (msg, socket) => {
    if (msg !== STICKY_MESSAGE || !socket) return;
    httpServer.emit('connection', socket);
    socket.resume();
  });
}
