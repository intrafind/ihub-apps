/**
 * Sticky session cluster primary. Opt-in via `STICKY_SESSIONS=true`.
 *
 * Node.js's built-in cluster scheduler distributes incoming TCP connections
 * round-robin (or OS-scheduled) across workers. That used to break SSE-based
 * chat, because streaming state (`clients` and `activeRequests` maps in
 * `server/sse.js`, and the `actionTracker` EventEmitter) lives in the worker's
 * process memory: a client that opened an SSE stream on worker A and then
 * POSTed a prompt that landed on worker B would never receive tokens and could
 * not cancel.
 *
 * That is no longer true. `server/clusterBus.js` relays per-chat events to
 * whichever worker holds the stream, so the default scheduler is now both
 * correct and the default. This module remains for deployments that want
 * connection affinity anyway — iHub exposed directly to clients, with some
 * worker-local state outside the chat path that benefits from pinning.
 *
 * It replaces the default scheduler with a simple sticky router:
 *   - Primary owns the real listening socket (`net.createServer`).
 *   - Each incoming connection is hashed by `remoteAddress` to a worker index.
 *   - The paused socket handle is forwarded to that worker over IPC.
 *   - Workers re-emit the connection on their HTTP server and resume it.
 *
 * The same browser (same source IP) therefore always lands on the same worker
 * for the lifetime of a chat session, so all per-chat in-memory state remains
 * consistent without any cross-worker coordination.
 *
 * Tradeoff: the routing key is the TCP peer address, which is the only client
 * identity available before any HTTP byte is parsed — `X-Forwarded-For` is not
 * visible at this layer. Every caller that reaches iHub through the same hop
 * therefore hashes to the same worker:
 *
 *   - behind a reverse proxy / ingress (i.e. every typical production setup)
 *     that is ALL traffic, so one worker serves everything and the rest idle;
 *   - behind NAT or a corporate proxy it is every user on that egress IP.
 *
 * `logStickyRoutingCaveat` below reports the collapse once at startup so it is
 * visible rather than something to discover under load. The fix is to stop
 * asking for stickiness: unset `STICKY_SESSIONS` and let the cluster balance
 * connections, since the bus already carries chat state across workers.
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
 * Warn once that sticky routing keys on the TCP peer address, so a deployment
 * behind a reverse proxy concentrates all traffic on a single worker.
 *
 * Emitted at startup rather than per connection: by the time a worker is
 * saturated the symptom ("the server stopped responding, even the health
 * probes") gives no hint that the other workers were idle the whole time.
 *
 * @param {number} workerCount - Number of forked workers.
 */
export function logStickyRoutingCaveat(workerCount) {
  if (workerCount <= 1) return;
  logger.warn({
    component: 'StickyCluster',
    message:
      'STICKY_SESSIONS is on: routing hashes the TCP peer address, which a reverse proxy makes identical for every request — all traffic will land on one of the ' +
      workerCount +
      ' workers. Chat no longer needs stickiness (per-chat events are relayed across workers), so unset STICKY_SESSIONS unless something else in your deployment requires connection affinity.',
    workerCount
  });
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
