// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Counters of this process's knowledge search-index cache, kept apart from the
 * cache itself so the system-resources snapshot can read them without loading
 * the knowledge layer (#3652).
 *
 * @module services/knowledge/indexCacheStats
 */
import {
  recordIndexBuildDuration,
  recordIndexCacheEvent,
  registerIndexCacheObservers
} from '../../telemetry/metrics.js';

const stats = {
  hits: 0,
  misses: 0,
  evictions: 0,
  builds: 0,
  buildSecondsTotal: 0,
  buildSecondsMax: 0
};

/** Where the cache reports its current size and limits; set by the cache. */
let sizeProbe = () => ({ entries: 0, chars: 0, maxEntries: 0, maxChars: 0 });
let observersRegistered = false;

/** The cache registers how to read its size; also attaches the size gauges. */
export function setIndexCacheSizeProbe(probe) {
  sizeProbe = probe;
  if (!observersRegistered) {
    observersRegistered = true;
    registerIndexCacheObservers({ getStats: () => sizeProbe() });
  }
}

export function countIndexCacheHit() {
  stats.hits += 1;
  recordIndexCacheEvent('hit');
}

export function countIndexCacheMiss() {
  stats.misses += 1;
  recordIndexCacheEvent('miss');
}

export function countIndexCacheEvictions(count) {
  if (!(count > 0)) return;
  stats.evictions += count;
  recordIndexCacheEvent('eviction', count);
}

/** @param {number} seconds - How long one index build took. */
export function countIndexBuild(seconds) {
  stats.builds += 1;
  stats.buildSecondsTotal += seconds;
  stats.buildSecondsMax = Math.max(stats.buildSecondsMax, seconds);
  recordIndexBuildDuration(seconds);
}

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * This process's index-cache numbers, JSON-ready. `hitRate` is null until the
 * first lookup.
 */
export function getIndexCacheStats() {
  const lookups = stats.hits + stats.misses;
  return {
    ...sizeProbe(),
    hits: stats.hits,
    misses: stats.misses,
    evictions: stats.evictions,
    hitRate: lookups > 0 ? round(stats.hits / lookups, 4) : null,
    builds: stats.builds,
    buildSecondsAvg: stats.builds > 0 ? round(stats.buildSecondsTotal / stats.builds, 4) : null,
    buildSecondsMax: round(stats.buildSecondsMax, 4)
  };
}

/** Test seam. */
export function resetIndexCacheStats() {
  for (const key of Object.keys(stats)) stats[key] = 0;
}
