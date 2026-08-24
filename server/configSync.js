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
 * Delivery is best-effort and eventually consistent: an announcement takes one
 * IPC hop to the primary and one back out, so a request racing the announcement
 * can still read stale config for a few milliseconds. That is bounded by the
 * hop, not by the TTL, and the reload always re-reads the file — so concurrent
 * announcements for the same key converge on the file's final contents rather
 * than on whichever message arrived last.
 *
 * Inbound announcements are coalesced over a short window because one admin save
 * frequently touches several entries (platform + groups, or a bulk app import),
 * and reloading each key once per burst beats reloading it once per message.
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

import { publish, subscribe } from './clusterBus.js';
import logger from './utils/logger.js';

/** Bus channel for invalidation announcements. */
const CHANNEL = 'config:changed';

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
 * Tell the other workers to reload everything. For operations that rewrite
 * configuration wholesale — a backup import, an explicit cache flush — where
 * enumerating the affected keys is neither possible nor useful.
 *
 * @returns {boolean} Whether an announcement was sent.
 */
export function announceFullConfigReload() {
  return announceConfigChange(ALL_ENTRIES);
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
    logger.debug('Applied config change from another worker', {
      component: 'ConfigSync',
      entries,
      pid: process.pid
    });
    await runHooks(entries);
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
