/**
 * Request throttling utility supporting per-model and per-tool limits.
 * Keeps an in-memory queue for each identifier so provider rate limits are not exceeded.
 *
 * In cluster mode the limits are enforced across all workers: the primary
 * process holds one slot counter and queue per identifier, and workers acquire
 * and release slots over the cluster bus. Counting per worker turned a
 * configured concurrency of 1 into one request per worker, and the provider
 * answered with 429s. Identifiers without a limit never leave the worker.
 */
import cluster from 'node:cluster';
import configCache from './configCache.js';
import { httpFetch } from './utils/httpConfig.js';
import { recordRateLimitHit } from './telemetry/metrics.js';
import { isClusterBusActive, request, respondInPrimary } from './clusterBus.js';
import logger from './utils/logger.js';

const lastCompleted = new Map(); // id -> timestamp when last request finished

const queues = new Map(); // id -> array of pending tasks
const actives = new Map(); // id -> number of active requests

// Any configured value below 1 disables throttling (treated as unlimited)

function normalizeLimit(value) {
  return typeof value === 'number' && value >= 1 ? value : Infinity;
}

function getConcurrency(id = 'default') {
  const platform = configCache.getPlatform() || {};
  const { data: models = [] } = configCache.getModels() || {};
  const { data: tools } = configCache.getTools();
  const model = models.find(m => m.id === id);
  if (model && typeof model.concurrency === 'number') return normalizeLimit(model.concurrency);
  const tool = tools.find(t => t.id === id);
  if (tool && typeof tool.concurrency === 'number') return normalizeLimit(tool.concurrency);
  const limit = platform.requestConcurrency;
  return normalizeLimit(limit);
}

function getDelay(id = 'default') {
  const platform = configCache.getPlatform() || {};
  const { data: models = [] } = configCache.getModels() || {};
  const { data: tools } = configCache.getTools();
  const model = models.find(m => m.id === id);
  if (model && typeof model.requestDelayMs === 'number') return model.requestDelayMs;
  const tool = tools.find(t => t.id === id);
  if (tool && typeof tool.requestDelayMs === 'number') return tool.requestDelayMs;
  return typeof platform.requestDelayMs === 'number' ? platform.requestDelayMs : 0;
}

/**
 * Run an arbitrary async function through the per-id concurrency + delay queue.
 * This is the throttling primitive; `throttledFetch` is a thin wrapper around it.
 *
 * Use this (instead of `throttledFetch`) when the outbound call must go through
 * a different transport than `httpFetch` — e.g. the SSRF-guarded `safeFetch`
 * used by the OpenAPI tool runner — while still honoring per-tool
 * concurrency/requestDelayMs limits.
 *
 * @param {string} id - Resource identifier (model id, tool id, or 'default')
 * @param {() => Promise<any>} fn - Work to run inside the throttle slot
 * @returns {Promise<any>} Resolves/rejects with fn's result
 */
export function throttledRun(id = 'default', fn) {
  const limit = getConcurrency(id);
  const delayMs = getDelay(id);
  // Nothing to enforce: no queue, no bookkeeping, no round trip.
  if (limit === Infinity && !(delayMs > 0)) return Promise.resolve().then(fn);
  if (isClusterBusActive() && !cluster.isPrimary) {
    return clusterThrottledRun(id, limit, delayMs, fn);
  }
  return localThrottledRun(id, fn);
}

function localThrottledRun(id, fn) {
  if (!queues.has(id)) {
    queues.set(id, []);
    actives.set(id, 0);
  }

  const queue = queues.get(id);

  return new Promise((resolve, reject) => {
    const execute = async () => {
      actives.set(id, actives.get(id) + 1);
      try {
        const delay = getDelay(id);
        const lastTime = lastCompleted.get(id) || 0;
        const wait = Math.max(0, delay - (Date.now() - lastTime));
        if (wait > 0) {
          await new Promise(r => setTimeout(r, wait));
        }

        const res = await fn();
        resolve(res);
      } catch (error) {
        reject(error);
      } finally {
        actives.set(id, actives.get(id) - 1);
        lastCompleted.set(id, Date.now());
        if (queue.length > 0) {
          const next = queue.shift();
          next();
        }
      }
    };

    if (actives.get(id) < getConcurrency(id)) {
      void execute();
    } else {
      // The request had to wait for a slot - that's a throttler hit. We use
      // the "llm" scope because all current callers are LLM/tool calls.
      // Pass id as the "route" so dashboards can group by model id.
      recordRateLimitHit('llm', id);
      queue.push(execute);
    }
  });
}

// ---------------------------------------------------------------------------
// Cluster-wide slots, held by the primary
// ---------------------------------------------------------------------------

const ACQUIRE_CHANNEL = 'throttle:acquire';
const RELEASE_CHANNEL = 'throttle:release';
const CANCEL_CHANNEL = 'throttle:cancel';

/**
 * How long a worker waits in the cluster queue before running on its own
 * worker's limits instead. Generous: a queue behind slow LLM calls is normal.
 */
const CLUSTER_ACQUIRE_TIMEOUT_MS = 10 * 60 * 1000;
const RELEASE_TIMEOUT_MS = 1500;

let nextTicket = 1;

async function clusterThrottledRun(id, limit, delayMs, fn) {
  const ticket = `${process.pid}:${nextTicket++}`;
  const grant = await request(
    ACQUIRE_CHANNEL,
    { id, limit, delayMs, ticket, pid: process.pid },
    { timeoutMs: CLUSTER_ACQUIRE_TIMEOUT_MS }
  );
  if (!grant?.granted) {
    // No answer from the primary. Withdraw the ticket, in case a slot is
    // granted to it after all, and fall back to this worker's own limits.
    void request(CANCEL_CHANNEL, { id, ticket }, { timeoutMs: RELEASE_TIMEOUT_MS });
    logger.warn('Request throttle: no slot from the primary process; using this worker only', {
      component: 'RequestThrottler',
      id
    });
    return localThrottledRun(id, fn);
  }
  if (grant.queued) recordRateLimitHit('llm', id);
  try {
    if (grant.waitMs > 0) await new Promise(r => setTimeout(r, grant.waitMs));
    return await fn();
  } finally {
    void request(RELEASE_CHANNEL, { id, ticket }, { timeoutMs: RELEASE_TIMEOUT_MS });
  }
}

/** Primary-side state: id → { active: Map<ticket, pid>, queue, lastCompleted }. */
const slots = new Map();

function slotsFor(id) {
  let entry = slots.get(id);
  if (!entry) {
    entry = { active: new Map(), queue: [], lastCompleted: 0 };
    slots.set(id, entry);
  }
  return entry;
}

function grantWaiting(id) {
  const entry = slots.get(id);
  if (!entry) return;
  while (entry.queue.length > 0 && entry.active.size < entry.queue[0].limit) {
    const next = entry.queue.shift();
    entry.active.set(next.ticket, next.pid);
    const waitMs = Math.max(0, next.delayMs - (Date.now() - entry.lastCompleted));
    next.resolve({ granted: true, waitMs, queued: next.queued });
  }
  if (entry.active.size === 0 && entry.queue.length === 0 && !entry.lastCompleted) {
    slots.delete(id);
  }
}

function releaseSlot(id, ticket) {
  const entry = slots.get(id);
  if (!entry || !entry.active.delete(ticket)) return false;
  entry.lastCompleted = Date.now();
  grantWaiting(id);
  return true;
}

if (cluster.isPrimary) {
  respondInPrimary(ACQUIRE_CHANNEL, ({ id, limit, delayMs, ticket, pid } = {}) => {
    if (typeof id !== 'string' || typeof ticket !== 'string') return undefined;
    const entry = slotsFor(id);
    const effectiveLimit = Number.isFinite(limit) && limit >= 1 ? limit : Infinity;
    const queued = entry.queue.length > 0 || entry.active.size >= effectiveLimit;
    return new Promise(resolve => {
      entry.queue.push({
        ticket,
        pid,
        limit: effectiveLimit,
        delayMs: Number(delayMs) || 0,
        queued,
        resolve
      });
      grantWaiting(id);
    });
  });
  respondInPrimary(RELEASE_CHANNEL, ({ id, ticket } = {}) => ({
    released: releaseSlot(id, ticket)
  }));
  respondInPrimary(CANCEL_CHANNEL, ({ id, ticket } = {}) => {
    const entry = slots.get(id);
    if (!entry) return { cancelled: false };
    const index = entry.queue.findIndex(waiting => waiting.ticket === ticket);
    if (index >= 0) {
      const [waiting] = entry.queue.splice(index, 1);
      waiting.resolve({ granted: false });
      return { cancelled: true };
    }
    return { cancelled: releaseSlot(id, ticket) };
  });
  // A worker that died holding slots never releases them.
  cluster.on('exit', worker => {
    const pid = worker.process?.pid;
    for (const [id, entry] of slots) {
      entry.queue = entry.queue.filter(waiting => waiting.pid !== pid);
      for (const [ticket, holder] of entry.active) {
        if (holder === pid) entry.active.delete(ticket);
      }
      grantWaiting(id);
    }
  });
}

export function throttledFetch(id, url, options = {}) {
  if (typeof url === 'undefined') {
    // called as throttledFetch(url)
    url = id;
    id = 'default';
  }
  return throttledRun(id, () => httpFetch(url, options));
}
