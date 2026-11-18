// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Where requests wait: cluster-bus traffic, lock waits, request-throttle
 * slots and storage operations, counted per process.
 *
 * ## Why this exists
 *
 * Under load the limit is event-loop delay, not average CPU, and the log only
 * says *that* something waited ("Cross-worker request timed out", "Timed out
 * after 5000ms waiting for lock …"), never how often or how long. These
 * counters put numbers behind those lines. They are cumulative since process
 * start; a reader (the load-test harness) takes the difference between two
 * snapshots, which is also why histograms expose their raw bucket counts.
 *
 * ## Cost
 *
 * Always on. A count is one `Map.get` plus an integer increment; a timing adds
 * one `performance.now()` pair and a scan of 14 bucket bounds. Records are
 * created once per key (message type, lock prefix, …), never per call, so the
 * chat token relay pays one increment per chunk and allocates nothing.
 *
 * Read through `getWaitDiagnostics()`, which `services/systemResources.js`
 * attaches to every process of `GET /api/admin/system/resources`.
 *
 * @module telemetry/waitDiagnostics
 */

/**
 * Upper bounds, in ms, of the latency buckets. A sample lands in the first
 * bucket whose bound is >= the sample; one extra bucket holds everything
 * above the last bound.
 */
export const BUCKET_BOUNDS_MS = Object.freeze([
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000
]);

/** Fixed-bucket latency histogram. Never allocates after construction. */
export class Histogram {
  constructor() {
    this.buckets = new Array(BUCKET_BOUNDS_MS.length + 1).fill(0);
    this.count = 0;
    this.sumMs = 0;
    this.maxMs = 0;
  }

  /** @param {number} ms */
  record(ms) {
    let i = 0;
    while (i < BUCKET_BOUNDS_MS.length && ms > BUCKET_BOUNDS_MS[i]) i++;
    this.buckets[i] += 1;
    this.count += 1;
    this.sumMs += ms;
    if (ms > this.maxMs) this.maxMs = ms;
  }

  toJSON() {
    return {
      count: this.count,
      sumMs: Math.round(this.sumMs),
      maxMs: Math.round(this.maxMs * 10) / 10,
      p50: percentileFromBuckets(this.buckets, 0.5, this.maxMs),
      p95: percentileFromBuckets(this.buckets, 0.95, this.maxMs),
      buckets: this.buckets.slice()
    };
  }
}

/**
 * Percentile of a bucketed distribution, as the upper bound of the bucket it
 * falls in (capped at `maxMs` when known). Works on bucket *differences* too,
 * which is how the load-test report gets per-stage percentiles from
 * cumulative counters.
 *
 * @param {number[]} buckets - Counts per bucket, `BUCKET_BOUNDS_MS.length + 1` long
 * @param {number} q - Quantile, 0..1
 * @param {number|null} [maxMs] - Largest sample, if known; reported for the open bucket
 * @param {readonly number[]} [bounds=BUCKET_BOUNDS_MS]
 * @returns {number|null} Null when the distribution is empty
 */
export function percentileFromBuckets(buckets, q, maxMs = null, bounds = BUCKET_BOUNDS_MS) {
  let total = 0;
  for (const n of buckets) total += n;
  if (total === 0) return null;
  const rank = Math.max(1, Math.ceil(q * total));
  let seen = 0;
  for (let i = 0; i < buckets.length; i++) {
    seen += buckets[i];
    if (seen < rank) continue;
    const bound = i < bounds.length ? bounds[i] : Infinity;
    return maxMs !== null && maxMs > 0 ? Math.min(bound, Math.round(maxMs * 10) / 10) : bound;
  }
  return null;
}

/** group → Map<key, record>. */
const groups = new Map();
/** name → () => number, read at snapshot time. */
const gauges = new Map();

/**
 * The record for `key` in `group`, created by `create` on first use. Callers
 * on hot paths hold on to nothing; the lookup is the cost.
 *
 * @template T
 * @param {string} group
 * @param {string} key
 * @param {() => T} create
 * @returns {T}
 */
export function statRecord(group, key, create) {
  let bucket = groups.get(group);
  if (!bucket) {
    bucket = new Map();
    groups.set(group, bucket);
  }
  let record = bucket.get(key);
  if (!record) {
    record = create();
    bucket.set(key, record);
  }
  return record;
}

/** A timed operation: count, outcome counters and a latency histogram. */
export const timedRecord = () => ({ count: 0, errors: 0, timeouts: 0, latency: new Histogram() });

/** Record one timed operation of `group`/`key` that started at `startedAt`. */
export function recordTiming(group, key, startedAt, failed = false) {
  const record = statRecord(group, key, timedRecord);
  record.count += 1;
  if (failed) record.errors += 1;
  record.latency.record(performance.now() - startedAt);
}

/**
 * Run `fn` and record its duration under `group`/`key`, as an error when it
 * throws. For I/O-bound operations (storage), not for per-chunk paths.
 *
 * @template T
 * @param {string} group
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function timeAsync(group, key, fn) {
  const startedAt = performance.now();
  let failed = false;
  try {
    return await fn();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    recordTiming(group, key, startedAt, failed);
  }
}

/** Register a gauge read at snapshot time (queue lengths, pending maps). */
export function registerGauge(name, read) {
  gauges.set(name, read);
}

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

const lockRecord = () => ({
  acquisitions: 0,
  timeouts: 0,
  waiters: 0,
  wait: new Histogram(),
  hold: new Histogram()
});

/**
 * Prefix a lock is reported under: the part of its name before the first
 * `:` (`chat:<id>` → `chat`), or the component when the name has none
 * (`withFileLock` names are file names, one per locked file).
 */
export function lockPrefix(name, component) {
  const text = String(name);
  const colon = text.indexOf(':');
  return colon > 0 ? text.slice(0, colon) : String(component || 'unknown');
}

/** The lock record for a prefix; callers bump `waiters` around the wait. */
export function lockStats(prefix) {
  return statRecord('locks', prefix, lockRecord);
}

/** Record how long one lock was held, from acquisition to release. */
export function recordLockHold(prefix, acquiredAt) {
  lockStats(prefix).hold.record(performance.now() - acquiredAt);
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

function plain(value) {
  if (value instanceof Histogram) return value.toJSON();
  if (value instanceof Map) {
    const out = {};
    for (const [key, entry] of value) out[key] = plain(entry);
    return out;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = plain(entry);
    return out;
  }
  return value;
}

/**
 * This process's counters: `bucketBoundsMs`, `uvThreadpoolSize`, every group
 * (`busTypes`, `busRequests`, `busGathers`, `busLookups`, `locks`,
 * `throttle`, `storage`) as `{ key: record }`, and `gauges`.
 */
export function getWaitDiagnostics() {
  const out = {
    bucketBoundsMs: BUCKET_BOUNDS_MS,
    // libuv's default; every fs call queues on this pool.
    uvThreadpoolSize: Number.parseInt(process.env.UV_THREADPOOL_SIZE ?? '', 10) || 4,
    gauges: {}
  };
  for (const [name, bucket] of groups) out[name] = plain(bucket);
  for (const [name, read] of gauges) {
    try {
      out.gauges[name] = read();
    } catch {
      out.gauges[name] = null;
    }
  }
  return out;
}

/** Test seam: forget every counter (gauges stay registered). */
export function resetWaitDiagnosticsForTests() {
  groups.clear();
}
