import cluster from 'node:cluster';
import { MemoryStore } from 'express-rate-limit';
import { isClusterBusActive, request, respondInPrimary } from '../clusterBus.js';
import logger from './logger.js';

/**
 * An express-rate-limit store whose counts are shared by every cluster worker.
 *
 * The default store counts in one process, so with `WORKERS=N` a client gets N
 * times the configured limit — for the authentication limiter, 200 credential
 * attempts per window on four workers instead of 50. Here the primary process
 * holds the counters and workers ask it over the cluster bus, the way the
 * login lockout does (`utils/loginLockout.js`). When the primary does not
 * answer in time, or outside cluster mode, the worker counts in its own
 * memory, which is exactly the old behaviour.
 *
 * Every hit is a round trip to the primary, so this is for the limiters that
 * guard credentials, not for the general API limiters on every request.
 *
 * @module utils/clusterRateLimitStore
 */

const INCREMENT_CHANNEL = 'rate-limit:increment';
const DECREMENT_CHANNEL = 'rate-limit:decrement';
const RESET_CHANNEL = 'rate-limit:reset';

/** How long a worker waits for the primary before counting on its own. */
const BUS_TIMEOUT_MS = 500;

/** Primary-side counters: `<storeId>\0<key>` → { hits, resetAt }. */
const counters = new Map();

const counterKey = (storeId, key) => `${storeId}\u0000${key}`;

function incrementInPrimary({ storeId, key, windowMs }, now = Date.now()) {
  const id = counterKey(storeId, key);
  let entry = counters.get(id);
  if (!entry || entry.resetAt <= now) {
    entry = { hits: 0, resetAt: now + windowMs };
    counters.set(id, entry);
  }
  entry.hits += 1;
  return { totalHits: entry.hits, resetAt: entry.resetAt };
}

if (cluster.isPrimary) {
  respondInPrimary(INCREMENT_CHANNEL, payload =>
    Number.isFinite(payload?.windowMs) ? incrementInPrimary(payload) : undefined
  );
  respondInPrimary(DECREMENT_CHANNEL, ({ storeId, key } = {}) => {
    const entry = counters.get(counterKey(storeId, key));
    if (entry && entry.hits > 0) entry.hits -= 1;
    return { ok: true };
  });
  respondInPrimary(RESET_CHANNEL, ({ storeId, key } = {}) => {
    counters.delete(counterKey(storeId, key));
    return { ok: true };
  });
  // Drop windows that have ended; unref so the sweep never holds the process.
  setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of counters) {
      if (entry.resetAt <= now) counters.delete(id);
    }
  }, 60 * 1000).unref();
}

export class ClusterRateLimitStore {
  /**
   * @param {string} storeId - Unique per limiter, so limiters never share counts.
   */
  constructor(storeId) {
    this.storeId = storeId;
    this.prefix = `${storeId}:`;
    // Counts reach other processes, so a key counted here is not local.
    this.localKeys = false;
    this.windowMs = 60 * 1000;
    this.fallback = new MemoryStore();
    this._warned = false;
  }

  init(options) {
    this.windowMs = options.windowMs;
    this.fallback.init(options);
  }

  _shared() {
    return !cluster.isPrimary && isClusterBusActive();
  }

  async _ask(channel, payload) {
    const reply = await request(channel, payload, { timeoutMs: BUS_TIMEOUT_MS });
    if (reply === null && !this._warned) {
      this._warned = true;
      logger.warn('Rate limit: no answer from the primary process; counting on this worker', {
        component: 'ClusterRateLimitStore',
        storeId: this.storeId
      });
    }
    return reply;
  }

  async increment(key) {
    if (this._shared()) {
      const reply = await this._ask(INCREMENT_CHANNEL, {
        storeId: this.storeId,
        key,
        windowMs: this.windowMs
      });
      if (reply && Number.isFinite(reply.totalHits)) {
        return { totalHits: reply.totalHits, resetTime: new Date(reply.resetAt) };
      }
    }
    return this.fallback.increment(key);
  }

  async decrement(key) {
    if (this._shared()) {
      const reply = await this._ask(DECREMENT_CHANNEL, { storeId: this.storeId, key });
      if (reply) return;
    }
    await this.fallback.decrement(key);
  }

  async resetKey(key) {
    if (this._shared()) await this._ask(RESET_CHANNEL, { storeId: this.storeId, key });
    await this.fallback.resetKey(key);
  }

  shutdown() {
    this.fallback.shutdown();
  }
}

/** Test seam: forget every primary-side count. */
export function resetClusterRateLimitCounters() {
  counters.clear();
}
