// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Cluster-wide view of a "who was active" set.
 *
 * Every worker only sees the users, chats or projects that its own requests
 * touched, so a per-process count under-reports in cluster mode, and summing the
 * workers' counts over-reports (the same project is active on several workers).
 * The right number is the **union**: each id counted once, with its most recent
 * activity across all workers.
 *
 * Observable-gauge callbacks are synchronous, while asking the other workers is
 * not. So a worker keeps a periodically refreshed copy of what the *other*
 * processes reported (`remote`) and merges its own live entries into it at read
 * time. Outside cluster mode `gather` returns nothing and the view is just the
 * local one.
 *
 * @module telemetry/clusterUnion
 */
import cluster from 'node:cluster';
import { gather, respond } from '../clusterBus.js';

/** How often a worker re-asks the others. The gauges are scraped about every 15 s. */
export const DEFAULT_REFRESH_MS = 10_000;

/** How long a gather waits for a silent worker. */
const GATHER_TIMEOUT_MS = 1500;

/**
 * Merge entry lists into one map, keeping the newest timestamp per id and the
 * value of that newest entry.
 *
 * @param {Array<Array<[string, number, *]>>} lists - `[id, timestamp, value]` entries
 * @returns {Map<string, {ts: number, value: *}>}
 */
export function mergeEntries(...lists) {
  const merged = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!Array.isArray(entry)) continue;
      const [id, ts, value] = entry;
      if (typeof id !== 'string' || !Number.isFinite(ts)) continue;
      const known = merged.get(id);
      if (!known || ts > known.ts) merged.set(id, { ts, value });
    }
  }
  return merged;
}

/**
 * @param {Object} options
 * @param {string} options.channel - Cluster-bus channel, unique per tracker.
 * @param {() => Array<[string, number, *]>} options.getLocalEntries - This
 *   process's own `[id, timestamp, value]` entries.
 * @param {number} [options.refreshMs]
 * @param {typeof gather} [options.gatherFn] - Test seam.
 * @param {() => number} [options.expectedPeers] - Replies to wait for.
 */
export function createClusterUnion({
  channel,
  getLocalEntries,
  refreshMs = DEFAULT_REFRESH_MS,
  gatherFn = gather,
  expectedPeers = () => undefined
}) {
  /** What the other processes reported at the last refresh. */
  let remoteEntries = [];
  let timer = null;
  let unregister = null;

  async function refresh() {
    try {
      const replies = await gatherFn(channel, null, {
        expected: expectedPeers(),
        timeoutMs: GATHER_TIMEOUT_MS
      });
      remoteEntries = replies.flatMap(reply => (Array.isArray(reply) ? reply : []));
    } catch {
      // Keep the previous copy: a missed refresh must not zero the gauge.
    }
  }

  return {
    /**
     * Answer the other workers and keep their numbers fresh. Idempotent. Only
     * does anything in a cluster worker; elsewhere there is nobody to ask.
     */
    start() {
      if (unregister || !cluster.isWorker) return;
      unregister = respond(channel, () => getLocalEntries());
      timer = setInterval(refresh, refreshMs);
      timer.unref?.();
      void refresh();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      unregister?.();
      unregister = null;
      remoteEntries = [];
    },
    refresh,
    /** Union of this process's live entries and the last copy of the others'. */
    entries() {
      return mergeEntries(remoteEntries, getLocalEntries());
    },
    /** Test seam. */
    setRemoteEntries(entries) {
      remoteEntries = entries;
    }
  };
}
