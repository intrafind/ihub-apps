// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Stage-aware metrics. Every sample is filed under the stage that was active
 * when it was recorded, so a step-ramp run yields one row per load level and
 * shards from several runner pods can be merged by concatenation.
 *
 * - trend(name, value): a latency/size sample (kept raw, percentiles at report time)
 * - count(name, n):     a counter
 * - error(scope, code): a counter named `error.<scope>.<code>`
 * - gauge(name, value): a server/runner resource sample (kept raw with timestamp)
 */

const BUCKET_MS = 10_000;

export class Metrics {
  constructor() {
    this.stage = -1;
    this.trends = {}; // name -> { [stage]: number[] }
    this.counts = {}; // name -> { [stage]: number }
    this.gauges = {}; // name -> [[t, stage, value]]
    this.timeline = {}; // bucketStartMs -> { name: count }
    this.diagnostics = {}; // stage -> { first, last }: server wait counters, see waits.mjs
  }

  setStage(index) {
    this.stage = index;
  }

  trend(name, value) {
    if (!Number.isFinite(value)) return;
    const byStage = (this.trends[name] ??= {});
    (byStage[this.stage] ??= []).push(Math.round(value * 10) / 10);
  }

  count(name, n = 1) {
    const byStage = (this.counts[name] ??= {});
    byStage[this.stage] = (byStage[this.stage] || 0) + n;
    const bucket = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS;
    const slot = (this.timeline[bucket] ??= {});
    slot[name] = (slot[name] || 0) + n;
  }

  error(scope, code) {
    this.count(`error.${scope}.${code || 'UNKNOWN'}`);
  }

  gauge(name, value) {
    if (!Number.isFinite(value)) return;
    (this.gauges[name] ??= []).push([Date.now(), this.stage, value]);
  }

  /**
   * Server wait counters (cumulative): only the first and last snapshot of a
   * stage are kept, which is all a per-stage difference needs.
   * @param {Object<string, {pid: number, d: object}>} procs - by process id (`w0`, `primary`)
   */
  diag(procs) {
    const sample = { t: Date.now(), procs };
    const byStage = (this.diagnostics[this.stage] ??= {});
    byStage.first ??= sample;
    byStage.last = sample;
  }

  toJSON() {
    return {
      trends: this.trends,
      counts: this.counts,
      gauges: this.gauges,
      timeline: this.timeline,
      diagnostics: this.diagnostics
    };
  }
}

/** Merge serialized metrics of several shards. */
export function mergeMetrics(list) {
  const out = { trends: {}, counts: {}, gauges: {}, timeline: {}, diagnostics: {} };
  for (const m of list) {
    for (const [name, byStage] of Object.entries(m.trends || {})) {
      const target = (out.trends[name] ??= {});
      for (const [stage, values] of Object.entries(byStage)) {
        (target[stage] ??= []).push(...values);
      }
    }
    for (const [name, byStage] of Object.entries(m.counts || {})) {
      const target = (out.counts[name] ??= {});
      for (const [stage, n] of Object.entries(byStage)) target[stage] = (target[stage] || 0) + n;
    }
    for (const [name, samples] of Object.entries(m.gauges || {})) {
      (out.gauges[name] ??= []).push(...samples);
    }
    // Only shard 0 samples them; should several, keep the widest window.
    for (const [stage, { first, last }] of Object.entries(m.diagnostics || {})) {
      const target = (out.diagnostics[stage] ??= { first, last });
      if (first.t < target.first.t) target.first = first;
      if (last.t > target.last.t) target.last = last;
    }
    for (const [bucket, slot] of Object.entries(m.timeline || {})) {
      const target = (out.timeline[bucket] ??= {});
      for (const [name, n] of Object.entries(slot)) target[name] = (target[name] || 0) + n;
    }
  }
  return out;
}

/** Percentile summary of raw samples. */
export function summarize(values = []) {
  if (!values.length) return null;
  const sorted = Float64Array.from(values).sort();
  const pick = p => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    n: sorted.length,
    avg: round(sum / sorted.length),
    min: sorted[0],
    p50: pick(50),
    p90: pick(90),
    p95: pick(95),
    p99: pick(99),
    max: sorted[sorted.length - 1]
  };
}

export function round(v, digits = 1) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
