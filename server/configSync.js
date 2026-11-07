// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Cross-worker configuration invalidation.
 *
 * ## Why this exists
 *
 * `server/configCache.js` is per-process memory. An admin write goes through one
 * HTTP request, so it lands on exactly one worker: that worker writes the JSON
 * file under `contents/` and refreshes its own cache. Every other worker keeps
 * serving whatever it loaded earlier.
 *
 * With sticky routing that was invisible — an admin kept hitting the same worker
 * and saw their own change. Under round-robin (`server/server.js`) the next
 * request goes to the next worker, so the same edit appears to have been lost on
 * one refresh and applied on the next. Deletes behave the same way in reverse:
 * the app is gone on the worker that handled the delete and still listed
 * everywhere else. Both converge only when the 5-minute TTL timer in
 * `setCacheEntry` happens to fire, which is why the symptom reads as random.
 *
 * This module closes that gap by putting cache invalidation on the same IPC bus
 * the SSE relay uses (`server/clusterBus.js`).
 *
 * ## What travels over the bus
 *
 * Cache *keys*, never cache *contents*. A worker receiving `config/apps.json`
 * re-reads that file from disk itself. Shipping the loaded data instead would
 * mean serialising every app definition through the primary on each save, and
 * would let a worker's memory diverge from the file that is the actual source of
 * truth. Re-reading costs one file read per worker on an operation that happens
 * at human frequency.
 *
 * Announcements are only sent from *explicit* refresh calls — the ones admin
 * routes make after writing a file. The TTL timer uses the private reload path
 * (`ConfigCache#_reloadEntry`) and stays silent, so periodic refreshes do not
 * turn into an N×N storm of bus traffic and disk reads.
 *
 * ## Ordering and convergence
 *
 * `announceConfigChange` is fire-and-forget and eventually consistent: an
 * announcement takes one IPC hop to the primary and one back out, and the
 * receiving worker holds it for a short coalescing window before reloading. A
 * request racing it can read stale config. That is fine for a background
 * refresh, and wrong for an admin save: the browser's next request goes to
 * whichever worker the round-robin picks, so a read right after a save mostly
 * showed the old value, and a write that read a stale copy could undo the save.
 *
 * The admin routes therefore go through `announceConfigChangeAndWait`
 * (`ConfigCache#refreshCacheEntry` does). It asks every other worker to reload
 * at once, without the coalescing window, and returns when they have answered, so
 * the save is acknowledged to the browser only after the whole cluster has the
 * new data. The wait is bounded: a worker that is restarting or stuck costs the
 * save at most `APPLY_TIMEOUT_MS`, never the save itself, and the TTL timer
 * remains the backstop for a worker that missed it.
 *
 * Either way the reload re-reads the file, so concurrent announcements for the
 * same key converge on the file's final contents rather than on whichever
 * message arrived last.
 *
 * Inbound fire-and-forget announcements are coalesced over a short window because
 * one admin save frequently touches several entries (platform + groups, or a bulk
 * app import), and reloading each key once per burst beats reloading it once per
 * message.
 *
 * ## Runtime state beyond the cache
 *
 * Some subsystems derive live state from config — the logger's level, the
 * telemetry exporters, the MCP client connections. Refreshing the cache does not
 * touch those, and the route that wrote the file only fixes them up in its own
 * process. `registerConfigChangeHook` is how the rest of the cluster catches up;
 * `server/configReloadHooks.js` holds the concrete handlers.
 *
 * Outside cluster mode every export here is inert: `publish` is a no-op, nothing
 * is ever received, and a single process needs none of it.
 */

import { gather, isClusterBusActive, publish, respond, subscribe } from './clusterBus.js';
import config from './config.js';
import logger from './utils/logger.js';

/** Bus channel for invalidation announcements. */
const CHANNEL = 'config:changed';

/** Bus channel for "reload these entries now and tell me when you have", see announceConfigChangeAndWait. */
const APPLY_CHANNEL = 'config:apply';

/**
 * Longest an admin save waits for the other workers to confirm. A reload is a few
 * file reads, so this is far above a healthy answer and short enough that a worker
 * that is down does not make saving feel broken.
 */
export const APPLY_TIMEOUT_MS = 1000;

/** Sentinel entry meaning "reload every entry you hold". */
export const ALL_ENTRIES = '*';

/**
 * How long inbound announcements accumulate before being applied. Long enough to
 * collapse the burst a single admin save produces, short enough that it stays
 * well inside one browser round trip.
 */
const COALESCE_MS = 25;

/** Injected by configCache so this module does not import it (and cycle). */
let reloadEntry = null;
let reloadAll = null;

/** Handlers for config-derived runtime state, see registerConfigChangeHook. */
const hooks = new Set();

/** Entries announced by other workers and not yet applied. */
const pending = new Set();
let drainTimer = null;
let draining = false;

const stats = { announced: 0, received: 0, reloaded: 0, failed: 0 };

/**
 * Wire the reload implementation. Called once by `configCache` at module load.
 *
 * @param {object} reloaders
 * @param {(key: string) => Promise<void>} reloaders.entry - Reload one cache
 *   entry from disk without re-announcing it.
 * @param {() => Promise<void>} reloaders.all - Reload every held entry.
 */
export function setConfigReloader({ entry, all }) {
  reloadEntry = entry;
  reloadAll = all;
}

/**
 * Register a handler for config-derived runtime state.
 *
 * Handlers run on the workers that *received* an announcement, not on the one
 * that produced it — the originating request already applied its own side
 * effects inline. They must therefore be idempotent and must not write config
 * files, or an announcement would ping-pong across the cluster.
 *
 * @param {(change: {entries: string[]}) => void|Promise<void>} handler
 * @returns {() => void} Unregister.
 */
export function registerConfigChangeHook(handler) {
  hooks.add(handler);
  return () => hooks.delete(handler);
}

/**
 * Tell the other workers that these cache entries changed on disk.
 *
 * @param {string|string[]} entries - Cache keys, e.g. `'config/apps.json'`.
 * @returns {boolean} Whether an announcement was sent (false outside cluster
 *   mode, where there is nobody to tell).
 */
export function announceConfigChange(entries) {
  const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
  if (!list.length) return false;

  const sent = publish(CHANNEL, { entries: list, origin: process.pid });
  if (sent) {
    stats.announced += 1;
    logger.debug('Announced config change to cluster', {
      component: 'ConfigSync',
      entries: list,
      pid: process.pid
    });
  }
  return sent;
}

/**
 * Tell the other workers that these cache entries changed on disk, and wait until
 * they have reloaded them.
 *
 * For the admin save paths: the browser's next request may land on any worker, so
 * the save must not be acknowledged while some of them still hold the old data.
 * Each worker reloads immediately (no coalescing window) and answers; this resolves
 * when all have, or after `timeoutMs`. It never rejects, and a worker that does not
 * answer in time is logged and left to the TTL refresh.
 *
 * Outside cluster mode there is nobody to wait for and it resolves at once.
 *
 * @param {string|string[]} entries - Cache keys, e.g. `'config/models.json'`.
 * @param {object} [options]
 * @param {number} [options.expected] - Workers expected to answer; defaults to
 *   the configured worker count minus this one.
 * @param {number} [options.timeoutMs=APPLY_TIMEOUT_MS] - Longest wait.
 * @returns {Promise<{expected: number, replied: number}>} How many answered.
 */
export async function announceConfigChangeAndWait(
  entries,
  { expected = Math.max(0, (Number(config.WORKERS) || 1) - 1), timeoutMs = APPLY_TIMEOUT_MS } = {}
) {
  const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
  if (!list.length || expected <= 0) return { expected: 0, replied: 0 };

  const replies = await gather(
    APPLY_CHANNEL,
    { entries: list, origin: process.pid },
    { expected, timeoutMs }
  );
  // Outside cluster mode `gather` answers [] without asking anyone.
  if (!isClusterBusActive()) return { expected: 0, replied: 0 };

  stats.announced += 1;
  if (replies.length < expected) {
    logger.warn('Not every worker confirmed a config change in time', {
      component: 'ConfigSync',
      entries: list,
      expected,
      replied: replies.length,
      timeoutMs
    });
  }
  return { expected, replied: replies.length };
}

/**
 * Tell the other workers to reload everything. For operations that rewrite
 * configuration wholesale — a backup import, an explicit cache flush — where
 * enumerating the affected keys is neither possible nor useful.
 *
 * @returns {boolean} Whether an announcement was sent.
 */
export function announceFullConfigReload() {
  return announceConfigChange(ALL_ENTRIES);
}

/**
 * Reload what another worker announced, then let the config-derived runtime
 * state catch up. Shared by the coalesced drain and the acknowledged apply.
 *
 * @param {string[]} entries - Cache keys, or the {@link ALL_ENTRIES} sentinel
 */
async function applyEntries(entries) {
  if (entries.includes(ALL_ENTRIES)) {
    await reloadAll?.();
    stats.reloaded += 1;
  } else {
    for (const entry of entries) {
      // Sequential: a burst is a handful of keys, and reloading them one at a
      // time keeps a config save from competing with request traffic for I/O.
      await reloadEntry?.(entry);
      stats.reloaded += 1;
    }
  }
  await runHooks(entries);
}

function scheduleDrain() {
  if (drainTimer) return;
  drainTimer = setTimeout(drain, COALESCE_MS);
  // Never hold the event loop open for a pending invalidation during shutdown.
  drainTimer.unref?.();
}

async function drain() {
  drainTimer = null;

  // A drain already in flight will pick up whatever arrived meanwhile via the
  // tail check below; re-arming here would run two reloads of the same key
  // concurrently.
  if (draining) {
    scheduleDrain();
    return;
  }

  const entries = [...pending];
  pending.clear();
  if (!entries.length) return;

  draining = true;
  try {
    await applyEntries(entries);
    logger.debug('Applied config change from another worker', {
      component: 'ConfigSync',
      entries,
      pid: process.pid
    });
  } catch (error) {
    stats.failed += 1;
    // Keep the previously cached data rather than taking the worker down; the
    // TTL refresh remains as a backstop for whatever failed here.
    logger.error('Failed to apply relayed config change', {
      component: 'ConfigSync',
      entries,
      error: error?.message || String(error)
    });
  } finally {
    draining = false;
    if (pending.size) scheduleDrain();
  }
}

async function runHooks(entries) {
  for (const hook of hooks) {
    try {
      await hook({ entries });
    } catch (error) {
      logger.error('Config change hook threw', {
        component: 'ConfigSync',
        entries,
        error: error?.message || String(error)
      });
    }
  }
}

// The other half of announceConfigChangeAndWait: reload now, then answer. The answer
// is sent whether or not the reload worked, so the asker waits for the work and not
// for the timeout; a failure is logged and left to the TTL refresh, as in drain().
respond(APPLY_CHANNEL, async payload => {
  const entries = Array.isArray(payload?.entries)
    ? payload.entries.filter(entry => typeof entry === 'string' && entry)
    : [];
  if (!entries.length) return { ok: false, pid: process.pid };
  stats.received += 1;
  try {
    await applyEntries(entries);
    logger.debug('Applied config change for an acknowledged save', {
      component: 'ConfigSync',
      entries,
      pid: process.pid
    });
    return { ok: true, pid: process.pid };
  } catch (error) {
    stats.failed += 1;
    logger.error('Failed to apply relayed config change', {
      component: 'ConfigSync',
      entries,
      error: error?.message || String(error)
    });
    return { ok: false, pid: process.pid };
  }
});

subscribe(CHANNEL, payload => {
  const entries = payload?.entries;
  if (!Array.isArray(entries) || !entries.length) return;
  stats.received += 1;
  for (const entry of entries) {
    if (typeof entry === 'string' && entry) pending.add(entry);
  }
  if (pending.size) scheduleDrain();
});

/** Invalidation counters, for diagnostics. */
export function getConfigSyncStats() {
  return { ...stats, pending: pending.size };
}

/** Test seam: drop queued work and registered hooks. */
export function resetConfigSyncForTests() {
  if (drainTimer) clearTimeout(drainTimer);
  drainTimer = null;
  draining = false;
  pending.clear();
  hooks.clear();
  stats.announced = 0;
  stats.received = 0;
  stats.reloaded = 0;
  stats.failed = 0;
}
