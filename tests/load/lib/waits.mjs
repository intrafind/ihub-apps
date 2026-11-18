// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "Waits and cluster bus" section of the report: where requests waited per
 * stage, from the cumulative `diagnostics` every server process reports in
 * GET /api/admin/system/resources (server/telemetry/waitDiagnostics.js).
 *
 * The sampler keeps the first and last snapshot per stage
 * (`metrics.diagnostics[stage] = { first, last }`). A stage's numbers are the
 * difference between the previous stage's last snapshot (or this stage's
 * first) and this stage's last one. Histograms are diffed bucket by bucket, so
 * percentiles are per stage too; they are bucket upper bounds (≤ value).
 */

import { round } from './metrics.mjs';

const TOP = 10;

const fmt = (v, d = 0) =>
  v === null || v === undefined || Number.isNaN(v) ? '–' : round(v, d).toLocaleString('en-US');

/** Element-wise / key-wise `b - a` of numbers, arrays and plain objects. */
function diff(a, b) {
  if (typeof b === 'number') return b - (typeof a === 'number' ? a : 0);
  if (Array.isArray(b)) return b.map((n, i) => n - (Array.isArray(a) ? a[i] || 0 : 0));
  if (b && typeof b === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(b)) out[k] = diff(a?.[k], v);
    return out;
  }
  return b;
}

/** Add `b` into `a` (same shapes as `diff`). */
function add(a, b) {
  if (typeof b === 'number') return (typeof a === 'number' ? a : 0) + b;
  if (Array.isArray(b)) return b.map((n, i) => n + (Array.isArray(a) ? a[i] || 0 : 0));
  if (b && typeof b === 'object') {
    const out = { ...(a || {}) };
    for (const [k, v] of Object.entries(b)) out[k] = add(a?.[k], v);
    return out;
  }
  return b;
}

/** Percentile of bucket counts as the bucket's upper bound; Infinity for the open bucket. */
export function bucketPercentile(buckets, q, bounds) {
  if (!Array.isArray(buckets)) return null;
  const total = buckets.reduce((s, n) => s + n, 0);
  if (total <= 0) return null;
  const rank = Math.max(1, Math.ceil(q * total));
  let seen = 0;
  for (let i = 0; i < buckets.length; i++) {
    seen += buckets[i];
    if (seen >= rank) return i < bounds.length ? bounds[i] : Infinity;
  }
  return null;
}

/**
 * Per-stage deltas, summed over all processes of the instance.
 *
 * @returns {Array<{index, seconds, groups, gauges, bounds, uvThreadpoolSize}|null>}
 *   One entry per timeline stage; null when the stage has fewer than two samples.
 */
export function waitStageDeltas(result) {
  const byStage = result.metrics.diagnostics || {};
  return result.meta.timeline.map(stage => {
    const own = byStage[stage.index];
    if (!own?.last) return null;
    const base = byStage[stage.index - 1]?.last ?? own.first;
    if (!base || base.t >= own.last.t) return null;
    const groups = {};
    const gauges = {};
    let bounds = null;
    let uvThreadpoolSize = null;
    for (const [id, proc] of Object.entries(own.last.procs || {})) {
      const before = base.procs?.[id];
      // A restarted process starts from zero: count everything it reports.
      const start = before && before.pid === proc.pid ? before.d : {};
      const { bucketBoundsMs, uvThreadpoolSize: uv, gauges: g = {}, ...rest } = proc.d || {};
      bounds ??= bucketBoundsMs;
      uvThreadpoolSize ??= uv;
      for (const [name, value] of Object.entries(g)) {
        if (typeof value === 'number') gauges[name] = (gauges[name] || 0) + value;
      }
      for (const [group, records] of Object.entries(rest)) {
        groups[group] = add(groups[group], diff(start[group], records));
        // Waiters is a gauge inside a lock record: take the current value.
        if (group === 'locks') {
          for (const [prefix, rec] of Object.entries(records)) {
            groups.locks[prefix].waitersNow =
              (groups.locks[prefix].waitersNow || 0) + (rec.waiters || 0);
          }
        }
      }
    }
    return {
      index: stage.index,
      seconds: (own.last.t - base.t) / 1000,
      groups,
      gauges,
      bounds: bounds || [],
      uvThreadpoolSize
    };
  });
}

const rows = obj => Object.entries(obj || {});
const highest = (buckets, bounds) => {
  if (!Array.isArray(buckets)) return null;
  for (let i = buckets.length - 1; i >= 0; i--) {
    if (buckets[i] > 0) return i < bounds.length ? bounds[i] : Infinity;
  }
  return null;
};

function renderStage(L, stage, d) {
  const ms = v => (v === Infinity ? `>${fmt(d.bounds.at(-1))}` : fmt(v));
  const p95 = h => ms(bucketPercentile(h?.buckets, 0.95, d.bounds));
  const perSec = n => fmt(n / d.seconds, 1);
  L.push(`### ${stage.name} (${stage.vus} VUs, ${fmt(d.seconds)} s)`);
  L.push('');

  const bus = rows(d.groups.busTypes)
    .filter(([, r]) => r.published + r.received + r.relayed > 0)
    .sort(([, x], [, y]) => Math.max(y.published, y.relayed) - Math.max(x.published, x.relayed))
    .slice(0, TOP);
  if (bus.length) {
    L.push(
      '| Bus type | Published/s (workers) | Received/s (workers) | Relayed/s (primary) | Broadcast |'
    );
    L.push('|---|---:|---:|---:|---:|');
    for (const [type, r] of bus) {
      const bc = r.relayed ? `${fmt((r.broadcasts / r.relayed) * 100)}%` : '–';
      L.push(
        `| \`${type}\` | ${perSec(r.published)} | ${perSec(r.received)} | ${perSec(r.relayed)} | ${bc} |`
      );
    }
    L.push('');
  }

  const asks = [
    ...rows(d.groups.busRequests).map(([t, r]) => ({
      kind: 'request',
      t,
      r,
      other: `${r.nullReplies} null, ${r.unsent} unsent`
    })),
    ...rows(d.groups.busGathers).map(([t, r]) => ({
      kind: 'gather',
      t,
      r,
      other: `${r.fullTimeouts} full timeout`
    })),
    ...rows(d.groups.busLookups).map(([t, r]) => ({
      kind: 'lookup',
      t,
      r,
      other: `${r.misses} miss, ${r.mirrorHits} mirror hit`
    }))
  ]
    .filter(({ r }) => r.count > 0)
    .sort((x, y) => (y.r.timeouts || 0) - (x.r.timeouts || 0) || y.r.count - x.r.count)
    .slice(0, TOP);
  if (asks.length) {
    L.push('| Cross-worker wait | Type | Count | p95 (ms) | Timeouts | Other |');
    L.push('|---|---|---:|---:|---:|---|');
    for (const { kind, t, r, other } of asks) {
      L.push(
        `| ${kind} | \`${t}\` | ${fmt(r.count)} | ${p95(r.latency)} | ${fmt(r.timeouts || 0)} | ${other} |`
      );
    }
    L.push('');
    L.push(
      `Pending at stage end: ${fmt(d.gauges.busPendingRequests)} requests, ${fmt(d.gauges.busPendingGathers)} gathers, ${fmt(d.gauges.busPendingLookups)} lookups.`
    );
    L.push('');
  }

  const locks = rows(d.groups.locks)
    .filter(([, r]) => r.acquisitions + r.timeouts > 0)
    .sort(
      ([, x], [, y]) =>
        y.timeouts - x.timeouts ||
        (bucketPercentile(y.wait?.buckets, 0.95, d.bounds) ?? 0) -
          (bucketPercentile(x.wait?.buckets, 0.95, d.bounds) ?? 0) ||
        y.acquisitions - x.acquisitions
    )
    .slice(0, TOP);
  if (locks.length) {
    L.push(
      '| Lock prefix | Acquired | Wait p95 / max (ms) | Hold p95 (ms) | Timeouts | Waiters now |'
    );
    L.push('|---|---:|---|---:|---:|---:|');
    for (const [prefix, r] of locks) {
      L.push(
        `| \`${prefix}\` | ${fmt(r.acquisitions)} | ${p95(r.wait)} / ${ms(highest(r.wait?.buckets, d.bounds))} | ${p95(r.hold)} | ${fmt(r.timeouts)} | ${fmt(r.waitersNow)} |`
      );
    }
    L.push('');
  }

  const throttle = rows(d.groups.throttle)
    .filter(([, r]) => r.requests + r.fallbacks > 0)
    .sort(([, x], [, y]) => y.fallbacks - x.fallbacks || y.requests - x.requests)
    .slice(0, TOP);
  if (throttle.length) {
    L.push('| Throttle id | Requests | Queued | Wait p95 (ms) | No-slot fallbacks |');
    L.push('|---|---:|---:|---:|---:|');
    for (const [id, r] of throttle) {
      L.push(
        `| \`${id}\` | ${fmt(r.requests)} | ${fmt(r.queued)} | ${p95(r.wait)} | ${fmt(r.fallbacks)} |`
      );
    }
    L.push('');
    L.push(
      `Primary queue at stage end: ${fmt(d.gauges.throttlePrimaryQueued)} waiting, ${fmt(d.gauges.throttlePrimaryActive)} slots in use.`
    );
    L.push('');
  }

  const storage = rows(d.groups.storage)
    .filter(([, r]) => r.count > 0)
    .sort(([, x], [, y]) => y.count - x.count)
    .slice(0, TOP);
  if (storage.length) {
    L.push(
      `| Storage op (UV_THREADPOOL_SIZE=${fmt(d.uvThreadpoolSize)}) | Ops/s | p95 (ms) | Errors |`
    );
    L.push('|---|---:|---:|---:|');
    for (const [op, r] of storage) {
      L.push(`| \`${op}\` | ${perSec(r.count)} | ${p95(r.latency)} | ${fmt(r.errors)} |`);
    }
    L.push('');
  }
}

/** Markdown lines of the section; empty when the server reported no diagnostics. */
export function renderWaits(result) {
  const deltas = waitStageDeltas(result);
  if (!deltas.some(Boolean)) return [];
  const L = ['## Waits and cluster bus', ''];
  L.push(
    'Summed over all server processes, per stage (from the previous stage end). Percentiles are histogram bucket upper bounds. Top 10 per table.'
  );
  L.push('');
  result.meta.timeline.forEach((stage, i) => {
    if (deltas[i]) renderStage(L, stage, deltas[i]);
  });
  return L;
}
