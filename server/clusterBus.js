/**
 * Cross-worker message bus for cluster mode.
 *
 * ## Why this exists
 *
 * Chat streaming state is worker-local: `clients` and `activeRequests` in
 * `server/sse.js` are plain Maps in one process, and `actionTracker` is an
 * `EventEmitter` whose events never leave the process that emitted them. A
 * browser opens an SSE stream with `GET /api/apps/:appId/chat/:chatId` and then
 * POSTs prompts to the same path. If the GET lands on worker A and the POST on
 * worker B, worker B has no `clients` entry for that chat and the tokens go
 * nowhere.
 *
 * The original fix was to make sure that never happens — pin every connection
 * from one client to one worker (`server/clusterSticky.js`). That works only
 * when the primary can tell clients apart, and at the TCP layer the only
 * identity available is the peer address. Behind a reverse proxy or a
 * Kubernetes ingress every request shares one peer address, so all traffic
 * hashes to a single worker and the rest idle.
 *
 * This module removes the requirement instead of trying to satisfy it. Events
 * for a chat that this worker does not own are relayed to the worker that does,
 * so affinity becomes a performance detail rather than a correctness
 * precondition — which in turn lets the cluster distribute connections evenly.
 *
 * ## Shape
 *
 * Two primitives, both no-ops outside cluster mode so single-process runs
 * (`WORKERS=1`, tests, the binary build) behave exactly as before:
 *
 *  - **pub/sub** — `publish(type, payload)` fan-outs a message to every *other*
 *    worker; `subscribe(type, handler)` receives them. The primary is a dumb
 *    repeater and never interprets payloads.
 *
 *  - **presence** — `createPresenceMap(kind)` returns a `Map` that announces
 *    every `set`/`delete` to the primary, which mirrors the resulting
 *    key → workerId table into all other workers. That gives every worker a
 *    synchronous answer to "does some other worker hold the SSE stream for this
 *    chat?", which the request path needs before it decides to stream.
 *
 *  - **request/reply** — `request(type, payload, {route})` asks another worker a
 *    question and awaits its answer; `respond(type, handler)` answers. Built on
 *    pub/sub with correlation ids, so the primary stays a dumb repeater. Needed
 *    when the state cannot be replicated because reading it *mutates* it — a
 *    single-use OAuth authorization code has to be consumed on exactly one
 *    worker, so the worker holding it is asked to consume it rather than being
 *    told to hand out a copy (`server/utils/authorizationCodeStore.js`).
 *
 * Presence is eventually consistent: an announcement takes one IPC hop to the
 * primary and one back out. The paths that read it (a chat POST asking whether
 * an SSE stream exists) are separated from the registration (the SSE GET
 * completing) by a full browser round trip, which is orders of magnitude
 * longer, so the race is not reachable in practice. If it ever is, the reader
 * degrades to the non-streaming path rather than misbehaving.
 *
 * ## Cost
 *
 * Relayed events cross the process boundary twice (producer → primary →
 * owner) and are JSON-serialised each way. Chat chunks are small and the
 * primary has no other work in round-robin mode, but this does put token
 * traffic through a single process. `getBusStats()` exposes the relay counters
 * so a deployment can see how much of its traffic is crossing workers.
 *
 * Going cross-*pod* (Kubernetes replicas) needs the same interface backed by
 * Redis pub/sub instead of `process.send`. Keeping the transport behind
 * `publish`/`subscribe` is what makes that a drop-in later.
 */

import cluster from 'node:cluster';
import logger from './utils/logger.js';

/** Envelope marker so bus traffic never collides with other IPC messages. */
const ENVELOPE = '__ihubBus';

const MSG_PUBLISH = 'publish';
const MSG_PRESENCE_SET = 'presence:set';
const MSG_PRESENCE_SYNC = 'presence:sync';
const MSG_PRESENCE_BULK = 'presence:bulk';
const MSG_PRESENCE_REQUEST = 'presence:request';

/**
 * True when this process participates in a multi-worker cluster. Both the
 * primary and workers of a `WORKERS=1` run report false, so every export below
 * short-circuits into a no-op.
 */
let busActive = false;

/** type → Set<handler> for messages published by other workers. */
const subscribers = new Map();

/**
 * Mirror of ownership held by *other* workers: kind → Map<key, workerId>.
 * The local process never appears here — the primary does not echo a worker's
 * own announcements back to it — so `hasRemote()` means strictly "somewhere
 * else".
 */
const remoteOwnership = new Map();

/** Presence maps created in this worker, keyed by kind, for re-announcement. */
const presenceMaps = new Map();

const stats = { published: 0, received: 0, presenceAnnounced: 0 };

function remoteBucket(kind) {
  let bucket = remoteOwnership.get(kind);
  if (!bucket) {
    bucket = new Map();
    remoteOwnership.set(kind, bucket);
  }
  return bucket;
}

function sendToPrimary(message) {
  if (!busActive || typeof process.send !== 'function') return false;
  try {
    return process.send({ [ENVELOPE]: true, ...message });
  } catch (error) {
    // A worker shutting down loses its IPC channel mid-flight. Losing a relayed
    // chunk at that point is the same outcome as the worker dying with the
    // stream open, so log and carry on rather than taking the request down.
    logger.warn({
      component: 'ClusterBus',
      message: 'Failed to send message to primary',
      error: error.message
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Primary side
// ---------------------------------------------------------------------------

/**
 * Start the repeater in the primary process.
 *
 * The primary holds the authoritative ownership table so that a worker forked
 * to replace a crashed one can ask for a snapshot instead of starting blind,
 * and so that a dead worker's entries can be retracted cluster-wide.
 *
 * @param {object} options
 * @param {() => Array} options.getWorkers - Current live workers.
 */
export function initPrimaryBus({ getWorkers }) {
  busActive = true;

  /** kind → Map<key, workerId> */
  const ownership = new Map();

  const broadcast = (message, exceptWorkerId = null) => {
    for (const worker of getWorkers()) {
      if (!worker || worker.isDead?.()) continue;
      if (exceptWorkerId !== null && worker.id === exceptWorkerId) continue;
      try {
        worker.send({ [ENVELOPE]: true, ...message });
      } catch (error) {
        logger.warn({
          component: 'ClusterBus',
          message: 'Failed to forward message to worker',
          workerPid: worker.process?.pid,
          error: error.message
        });
      }
    }
  };

  const snapshotFor = workerId => {
    const entries = [];
    for (const [kind, bucket] of ownership) {
      for (const [key, owner] of bucket) {
        if (owner === workerId) continue;
        entries.push([kind, key, owner]);
      }
    }
    return entries;
  };

  cluster.on('message', (worker, message) => {
    if (!message || message[ENVELOPE] !== true) return;

    switch (message.kind) {
      case MSG_PUBLISH: {
        // A directed message names the presence entry that should receive it.
        // The primary is the only process that knows who owns what, so it can
        // deliver straight to that worker; chat token streams are the hot path
        // here and broadcasting them would make every other worker deserialise
        // and discard each chunk.
        const route = message.route;
        if (route) {
          const owner = ownership.get(route.kind)?.get(route.key);
          if (owner !== undefined && owner !== worker.id) {
            const target = getWorkers().find(w => w && w.id === owner && !w.isDead?.());
            if (target) {
              try {
                target.send({ [ENVELOPE]: true, ...message });
              } catch (error) {
                logger.warn({
                  component: 'ClusterBus',
                  message: 'Failed to route message to owning worker',
                  workerPid: target.process?.pid,
                  error: error.message
                });
              }
              break;
            }
          }
          // Owner unknown or gone: fall through to a broadcast rather than
          // dropping the message. The sender's view of presence may simply be
          // newer than the primary's, and a wasted fan-out beats a lost event.
        }
        broadcast(message, worker.id);
        break;
      }

      case MSG_PRESENCE_SET: {
        const bucket = ownership.get(message.ownKind) || new Map();
        ownership.set(message.ownKind, bucket);
        if (message.owned) {
          bucket.set(message.key, worker.id);
        } else if (bucket.get(message.key) === worker.id) {
          // Only the current owner may retract. Without this guard a slow
          // delete from a superseded connection would erase the registration
          // of a client that has already reconnected onto another worker.
          bucket.delete(message.key);
        } else {
          // Stale retraction from a worker that no longer owns the key —
          // nothing to broadcast.
          break;
        }
        broadcast(
          {
            kind: MSG_PRESENCE_SYNC,
            ownKind: message.ownKind,
            key: message.key,
            owned: message.owned,
            owner: worker.id
          },
          worker.id
        );
        break;
      }

      case MSG_PRESENCE_REQUEST:
        try {
          worker.send({
            [ENVELOPE]: true,
            kind: MSG_PRESENCE_BULK,
            entries: snapshotFor(worker.id)
          });
        } catch (error) {
          logger.warn({
            component: 'ClusterBus',
            message: 'Failed to send presence snapshot to worker',
            workerPid: worker.process?.pid,
            error: error.message
          });
        }
        break;

      default:
        break;
    }
  });

  cluster.on('exit', worker => {
    // Retract everything the dead worker owned. Its SSE clients died with it;
    // leaving the entries in place would make other workers relay events into
    // a process that no longer exists, and the browser's reconnect would be
    // told a stream already exists somewhere.
    for (const [kind, bucket] of ownership) {
      for (const [key, owner] of bucket) {
        if (owner !== worker.id) continue;
        bucket.delete(key);
        broadcast({ kind: MSG_PRESENCE_SYNC, ownKind: kind, key, owned: false, owner: worker.id });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Worker side
// ---------------------------------------------------------------------------

/**
 * Join the bus from a worker process. Safe to call when not clustered; it
 * simply leaves the bus inactive and every other export stays a no-op.
 */
export function initWorkerBus() {
  if (!cluster.isWorker || typeof process.send !== 'function') return;
  busActive = true;

  process.on('message', message => {
    if (!message || message[ENVELOPE] !== true) return;

    switch (message.kind) {
      case MSG_PUBLISH: {
        stats.received += 1;
        const handlers = subscribers.get(message.type);
        if (!handlers) return;
        for (const handler of handlers) {
          try {
            handler(message.payload);
          } catch (error) {
            logger.error({
              component: 'ClusterBus',
              message: 'Bus subscriber threw',
              type: message.type,
              error: error.message
            });
          }
        }
        break;
      }

      case MSG_PRESENCE_SYNC: {
        const bucket = remoteBucket(message.ownKind);
        if (message.owned) bucket.set(message.key, message.owner);
        else if (bucket.get(message.key) === message.owner) bucket.delete(message.key);
        break;
      }

      case MSG_PRESENCE_BULK:
        for (const [kind, key, owner] of message.entries || []) {
          remoteBucket(kind).set(key, owner);
        }
        break;

      default:
        break;
    }
  });

  // A replacement worker forked after a crash starts with an empty mirror while
  // the rest of the cluster is mid-flight. Pull the current table so its first
  // requests route correctly instead of falling back to non-streaming.
  sendToPrimary({ kind: MSG_PRESENCE_REQUEST });

  // Re-announce anything already registered locally. Only reachable if a
  // presence map was populated before the bus came up (init order changes,
  // tests), but cheap insurance against a silently invisible worker.
  for (const [kind, map] of presenceMaps) {
    for (const key of map.keys()) {
      sendToPrimary({ kind: MSG_PRESENCE_SET, ownKind: kind, key, owned: true });
    }
  }
}

/** Whether cross-worker relaying is available in this process. */
export function isClusterBusActive() {
  return busActive;
}

/**
 * Send a message to the other workers. No-op outside cluster mode.
 *
 * @param {string} type - Subscriber channel.
 * @param {*} payload - Structured-cloneable payload.
 * @param {{kind: string, key: string}} [route] - Presence entry identifying the
 *   intended recipient. When given, the primary delivers only to the worker
 *   owning that entry, falling back to a broadcast if it does not know one.
 *   Omit to fan out to every other worker.
 * @returns {boolean} Whether the message was handed to the primary.
 */
export function publish(type, payload, route) {
  if (!busActive) return false;
  const sent = sendToPrimary({ kind: MSG_PUBLISH, type, payload, route });
  if (sent) stats.published += 1;
  return sent;
}

/**
 * Register a handler for messages published by other workers.
 *
 * @param {string} type
 * @param {(payload: *) => void} handler
 * @returns {() => void} Unsubscribe.
 */
export function subscribe(type, handler) {
  let handlers = subscribers.get(type);
  if (!handlers) {
    handlers = new Set();
    subscribers.set(type, handlers);
  }
  handlers.add(handler);
  return () => handlers.delete(handler);
}

// ---------------------------------------------------------------------------
// Request / reply
// ---------------------------------------------------------------------------

/** Reply traffic for channel `t` rides on `t:reply`. */
const REPLY_SUFFIX = ':reply';

/** Correlation id → settle callback, for requests this worker is awaiting. */
const pendingRequests = new Map();

/** Channels whose reply subscription has already been installed. */
const replyChannels = new Set();

let nextRequestId = 1;

/**
 * Correlation id. The pid makes it unique across the cluster, so a reply
 * broadcast can never settle a different worker's pending request.
 */
function newRequestId() {
  return `${process.pid}:${nextRequestId++}`;
}

function ensureReplyChannel(type) {
  if (replyChannels.has(type)) return;
  replyChannels.add(type);
  subscribe(type + REPLY_SUFFIX, message => {
    const id = message?.requestId;
    const settle = typeof id === 'string' ? pendingRequests.get(id) : undefined;
    // Replies fan out to every worker; only the originator holds the id.
    if (!settle) return;
    pendingRequests.delete(id);
    settle(message.reply);
  });
}

/**
 * Ask another worker a question and await its answer.
 *
 * Resolves with `null` rather than rejecting when no answer arrives — every
 * caller treats "nobody answered" the same as "the thing is not there", and a
 * rejection mid-request would need a try/catch at each call site just to avoid
 * turning a missing entry into a 500.
 *
 * @param {string} type - Channel; the responder must use the same one.
 * @param {*} payload - Structured-cloneable request payload.
 * @param {object} [options]
 * @param {{kind: string, key: string}} [options.route] - Presence entry naming
 *   the worker that should answer. Without it the question is broadcast and any
 *   worker may answer, so the first reply wins.
 * @param {number} [options.timeoutMs=1500] - How long to wait before giving up.
 * @returns {Promise<*|null>} The responder's reply, or null on timeout / outside
 *   cluster mode, where there is no other worker to ask.
 */
export function request(type, payload, { route, timeoutMs = 1500 } = {}) {
  if (!busActive) return Promise.resolve(null);

  ensureReplyChannel(type);
  const requestId = newRequestId();

  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      logger.warn({
        component: 'ClusterBus',
        message: 'Cross-worker request timed out',
        type,
        timeoutMs
      });
      resolve(null);
    }, timeoutMs);
    // A pending question must never hold the event loop open during shutdown.
    timer.unref?.();

    pendingRequests.set(requestId, reply => {
      clearTimeout(timer);
      resolve(reply === undefined ? null : reply);
    });

    if (!publish(type, { requestId, payload }, route)) {
      clearTimeout(timer);
      pendingRequests.delete(requestId);
      resolve(null);
    }
  });
}

/**
 * Answer `request()` calls on a channel.
 *
 * A handler returning `undefined` sends **no reply**. That is what makes a
 * broadcast question safe: when the primary does not know who owns the routed
 * key it falls back to a fan-out, and every worker that does not hold the thing
 * stays silent instead of racing a `null` ahead of the real owner's answer.
 * Return an explicit wrapper (e.g. `{ data: null }`) to say "I own this and the
 * answer is nothing".
 *
 * @param {string} type - Channel; must match the requester's.
 * @param {(payload: *) => *|Promise<*>} handler - Returns the reply, or
 *   `undefined` to stay silent.
 * @returns {() => void} Unsubscribe.
 */
export function respond(type, handler) {
  return subscribe(type, async message => {
    const requestId = message?.requestId;
    if (typeof requestId !== 'string') return;

    let reply;
    try {
      reply = await handler(message.payload);
    } catch (error) {
      logger.error({
        component: 'ClusterBus',
        message: 'Cross-worker request handler threw',
        type,
        error: error?.message || String(error)
      });
      return;
    }

    if (reply === undefined) return;
    publish(type + REPLY_SUFFIX, { requestId, reply });
  });
}

/**
 * A `Map` that publishes its membership to the rest of the cluster.
 *
 * Subclassing rather than hooking the call sites is deliberate: `clients` is
 * mutated from the SSE channel helper, the inactive-client sweep, the stop
 * route and the write-failure teardown in `sse.js`. Any of those missing an
 * announcement would leave a phantom registration, so ownership is derived
 * from the mutation itself and cannot drift.
 *
 * @param {string} kind - Namespace, e.g. `'sse'` or `'request'`.
 */
export function createPresenceMap(kind) {
  class PresenceMap extends Map {
    set(key, value) {
      const isNew = !super.has(key);
      const result = super.set(key, value);
      if (isNew && busActive) {
        stats.presenceAnnounced += 1;
        sendToPrimary({ kind: MSG_PRESENCE_SET, ownKind: kind, key, owned: true });
      }
      return result;
    }

    delete(key) {
      const existed = super.delete(key);
      if (existed && busActive) {
        sendToPrimary({ kind: MSG_PRESENCE_SET, ownKind: kind, key, owned: false });
      }
      return existed;
    }

    clear() {
      if (busActive) {
        for (const key of super.keys()) {
          sendToPrimary({ kind: MSG_PRESENCE_SET, ownKind: kind, key, owned: false });
        }
      }
      return super.clear();
    }
  }

  const map = new PresenceMap();
  presenceMaps.set(kind, map);
  return map;
}

/**
 * Whether another worker holds `key` for `kind`. Always false outside cluster
 * mode, where "another worker" does not exist.
 */
export function hasRemote(kind, key) {
  if (!busActive) return false;
  return remoteOwnership.get(kind)?.has(key) === true;
}

/** Relay counters, for diagnostics. */
export function getBusStats() {
  return { ...stats, active: busActive };
}

/** Test seam: drop all bus state so a suite can rebuild it. */
export function resetClusterBusForTests() {
  busActive = false;
  subscribers.clear();
  remoteOwnership.clear();
  presenceMaps.clear();
  pendingRequests.clear();
  replyChannels.clear();
  stats.published = 0;
  stats.received = 0;
  stats.presenceAnnounced = 0;
}
