// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Usage rollups: pre-aggregated counters over a set of v2 records. Pure
 * functions — the files live in UsageAggregator.js, the range queries in
 * usageQuery.js.
 *
 * A rollup holds totals, 24 hourly buckets (UTC), and one entry per user,
 * group, app, model, provider and surface. Each entry carries requests,
 * tokens by kind, errors, tool calls, the time it was last used, latency as
 * a sum/count plus a fixed-bucket histogram (enough for p50/p95 without raw
 * data), and — except per model — the same counters per model for
 * drill-down rows. Rollups of any number of days merge into one.
 *
 * @module services/usage/rollup
 */

export const ROLLUP_VERSION = 2;

/** Upper bounds (ms) of the latency histogram buckets; the last is open. */
export const LATENCY_BUCKETS_MS = Object.freeze([
  250,
  500,
  1000,
  2000,
  4000,
  8000,
  15000,
  30000,
  60000,
  120000,
  Infinity
]);

/** Dimension → record key. */
export const DIMENSIONS = Object.freeze({
  user: 'uid',
  group: 'grp',
  app: 'app',
  model: 'model',
  provider: 'prov',
  surface: 'surf'
});

const DIM_KEYS = Object.keys(DIMENSIONS);

/** Token and request counters (also the shape of hourly buckets and model sub-rows). */
const COUNTERS = [
  'requests',
  'promptTokens',
  'completionTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'webSearchRequests',
  'errors',
  'toolCalls'
];

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

/** Outcomes that count as errors in the error rate. */
export function isErrorOutcome(st) {
  return st === 'error' || st === 'rate_limited';
}

function emptyCounters() {
  return Object.fromEntries(COUNTERS.map(k => [k, 0]));
}

/** Empty full entry. */
export function emptyStats() {
  return {
    ...emptyCounters(),
    estimated: 0,
    latencySum: 0,
    latencyCount: 0,
    latencyHist: LATENCY_BUCKETS_MS.map(() => 0),
    ttftSum: 0,
    ttftCount: 0,
    lastTs: null
  };
}

function eventCounters(event) {
  return {
    requests: 1,
    promptTokens: event.pt || 0,
    completionTokens: event.ct || 0,
    cacheReadTokens: event.cr || 0,
    cacheWriteTokens: event.cw || 0,
    reasoningTokens: event.rt || 0,
    webSearchRequests: event.ws || 0,
    errors: isErrorOutcome(event.st) ? 1 : 0,
    toolCalls: event.tc || 0
  };
}

function addCounters(target, source) {
  for (const k of COUNTERS) target[k] = (target[k] || 0) + (source[k] || 0);
}

function latencyBucket(ms) {
  return LATENCY_BUCKETS_MS.findIndex(bound => ms <= bound);
}

/** Add one record to a full entry. */
function addEvent(stats, event, counters = eventCounters(event)) {
  addCounters(stats, counters);
  if (event.src === 'estimate') stats.estimated += 1;
  if (Number.isFinite(event.lat) && event.lat >= 0 && event.st !== 'quota') {
    stats.latencySum += event.lat;
    stats.latencyCount += 1;
    stats.latencyHist[latencyBucket(event.lat)] += 1;
  }
  if (Number.isFinite(event.ttft) && event.ttft >= 0) {
    stats.ttftSum += event.ttft;
    stats.ttftCount += 1;
  }
  if (!stats.lastTs || event.ts > stats.lastTs) stats.lastTs = event.ts;
}

/** Merge one full entry into another. */
export function mergeStats(target, source) {
  if (!source) return target;
  addCounters(target, source);
  target.estimated += source.estimated || 0;
  target.latencySum += source.latencySum || 0;
  target.latencyCount += source.latencyCount || 0;
  target.ttftSum += source.ttftSum || 0;
  target.ttftCount += source.ttftCount || 0;
  (source.latencyHist || []).forEach((n, i) => {
    if (i < target.latencyHist.length) target.latencyHist[i] += n || 0;
  });
  if (source.lastTs && (!target.lastTs || source.lastTs > target.lastTs)) {
    target.lastTs = source.lastTs;
  }
  return target;
}

/**
 * Approximate percentile (0..1) from a latency histogram: linear within the
 * bucket it falls in. Null without data.
 */
export function percentileFromHist(hist, p) {
  const total = (hist || []).reduce((a, b) => a + b, 0);
  if (!total) return null;
  const target = Math.max(1, Math.ceil(total * p));
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    const n = hist[i] || 0;
    if (seen + n >= target) {
      const lower = i === 0 ? 0 : LATENCY_BUCKETS_MS[i - 1];
      const upper = Number.isFinite(LATENCY_BUCKETS_MS[i]) ? LATENCY_BUCKETS_MS[i] : lower * 2;
      return Math.round(lower + ((target - seen) / n) * (upper - lower));
    }
    seen += n;
  }
  return null;
}

/** Derived figures of a full entry: averages, p50/p95, error rate, cache hit. */
export function summarizeStats(stats) {
  const s = stats || emptyStats();
  return {
    requests: s.requests,
    promptTokens: s.promptTokens,
    completionTokens: s.completionTokens,
    cacheReadTokens: s.cacheReadTokens,
    cacheWriteTokens: s.cacheWriteTokens,
    reasoningTokens: s.reasoningTokens,
    webSearchRequests: s.webSearchRequests,
    totalTokens: s.promptTokens + s.completionTokens,
    errors: s.errors,
    errorRate: s.requests ? s.errors / s.requests : 0,
    toolCalls: s.toolCalls,
    estimated: s.estimated,
    cacheHitRate: s.promptTokens ? s.cacheReadTokens / s.promptTokens : 0,
    latencyAvg: s.latencyCount ? Math.round(s.latencySum / s.latencyCount) : null,
    latencyP50: percentileFromHist(s.latencyHist, 0.5),
    latencyP95: percentileFromHist(s.latencyHist, 0.95),
    ttftAvg: s.ttftCount ? Math.round(s.ttftSum / s.ttftCount) : null,
    lastTs: s.lastTs
  };
}

function emptyFeedback() {
  return {
    count: 0,
    ratings: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    byUser: {},
    byApp: {},
    byModel: {}
  };
}

function ratingKey(rating) {
  if (typeof rating === 'number' && Number.isFinite(rating)) {
    const key = Math.ceil(Math.round(rating * 2) / 2);
    return key >= 1 && key <= 5 ? key : null;
  }
  if (rating === 'positive') return 5;
  if (rating === 'negative') return 1;
  return null;
}

function addRating(map, key, rk) {
  if (!key || UNSAFE.has(key)) return;
  if (!map[key]) map[key] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  map[key][rk] += 1;
}

/** Empty rollup. */
export function emptyRollup(extra = {}) {
  return {
    v: ROLLUP_VERSION,
    ...extra,
    totals: emptyStats(),
    byHour: Array.from({ length: 24 }, emptyCounters),
    ...Object.fromEntries(DIM_KEYS.map(d => [dimField(d), {}])),
    byOutcome: {},
    byError: {},
    feedback: emptyFeedback()
  };
}

/** `user` → `byUser`. */
export function dimField(dimension) {
  return `by${dimension[0].toUpperCase()}${dimension.slice(1)}`;
}

function keysOf(event, dimension) {
  const value = event[DIMENSIONS[dimension]];
  const values = Array.isArray(value) ? value : [value];
  return values.filter(v => typeof v === 'string' && v && !UNSAFE.has(v));
}

/**
 * Build a rollup from records.
 * @param {Object[]} events - v2 records
 * @param {Object} [extra] - fields to stamp (`date`, …)
 * @returns {Object}
 */
export function buildRollup(events, extra = {}) {
  const rollup = emptyRollup(extra);
  for (const event of events) {
    if (event.type === 'feedback') {
      const rk = ratingKey(event.rating);
      if (!rk) continue;
      const fb = rollup.feedback;
      fb.count += 1;
      fb.ratings[rk] += 1;
      addRating(fb.byUser, event.uid, rk);
      addRating(fb.byApp, event.app, rk);
      addRating(fb.byModel, event.model, rk);
      continue;
    }
    if (event.type !== 'llm_call') continue;
    const counters = eventCounters(event);
    addEvent(rollup.totals, event, counters);
    const hour = Number.parseInt(event.ts.slice(11, 13), 10);
    if (hour >= 0 && hour < 24) addCounters(rollup.byHour[hour], counters);

    const st = event.st || 'ok';
    rollup.byOutcome[st] = (rollup.byOutcome[st] || 0) + 1;
    if (event.err && !UNSAFE.has(event.err)) {
      const entry =
        rollup.byError[event.err] || (rollup.byError[event.err] = { count: 0, byProvider: {} });
      entry.count += 1;
      if (event.prov && !UNSAFE.has(event.prov)) {
        entry.byProvider[event.prov] = (entry.byProvider[event.prov] || 0) + 1;
      }
    }

    for (const dimension of DIM_KEYS) {
      const field = dimField(dimension);
      for (const key of keysOf(event, dimension)) {
        let entry = rollup[field][key];
        if (!entry) {
          entry = rollup[field][key] = emptyStats();
          if (dimension !== 'model') entry.models = {};
        }
        addEvent(entry, event, counters);
        if (entry.models && event.model && !UNSAFE.has(event.model)) {
          const sub = entry.models[event.model] || (entry.models[event.model] = emptyCounters());
          addCounters(sub, counters);
        }
      }
    }
  }
  return rollup;
}

/**
 * Merge rollups (of days, or a month) into one. `byHour` is summed by hour of
 * day, which is only meaningful for a single day.
 * @param {Object[]} rollups
 * @param {Object} [extra]
 */
export function mergeRollups(rollups, extra = {}) {
  const out = emptyRollup(extra);
  for (const r of rollups) {
    if (!r) continue;
    mergeStats(out.totals, r.totals);
    (r.byHour || []).forEach((h, i) => i < 24 && addCounters(out.byHour[i], h));
    for (const dimension of DIM_KEYS) {
      const field = dimField(dimension);
      for (const [key, entry] of Object.entries(r[field] || {})) {
        if (UNSAFE.has(key)) continue;
        let target = out[field][key];
        if (!target) {
          target = out[field][key] = emptyStats();
          if (dimension !== 'model') target.models = {};
        }
        mergeStats(target, entry);
        for (const [model, sub] of Object.entries(entry.models || {})) {
          if (UNSAFE.has(model) || !target.models) continue;
          addCounters(target.models[model] || (target.models[model] = emptyCounters()), sub);
        }
      }
    }
    for (const [st, n] of Object.entries(r.byOutcome || {})) {
      if (!UNSAFE.has(st)) out.byOutcome[st] = (out.byOutcome[st] || 0) + n;
    }
    for (const [code, entry] of Object.entries(r.byError || {})) {
      if (UNSAFE.has(code)) continue;
      const target = out.byError[code] || (out.byError[code] = { count: 0, byProvider: {} });
      target.count += entry.count || 0;
      for (const [p, n] of Object.entries(entry.byProvider || {})) {
        if (!UNSAFE.has(p)) target.byProvider[p] = (target.byProvider[p] || 0) + n;
      }
    }
    const fb = r.feedback;
    if (fb) {
      out.feedback.count += fb.count || 0;
      for (const k of [1, 2, 3, 4, 5]) out.feedback.ratings[k] += fb.ratings?.[k] || 0;
      for (const map of ['byUser', 'byApp', 'byModel']) {
        for (const [key, ratings] of Object.entries(fb[map] || {})) {
          if (UNSAFE.has(key)) continue;
          const target =
            out.feedback[map][key] || (out.feedback[map][key] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
          for (const k of [1, 2, 3, 4, 5]) target[k] += ratings?.[k] || 0;
        }
      }
    }
  }
  return out;
}

/** Light counters of a set of events, for one time bucket of a series. */
export function countersOf(events) {
  const out = emptyCounters();
  for (const e of events) if (e.type === 'llm_call') addCounters(out, eventCounters(e));
  return out;
}

/** The light counters of a full entry. */
export function lightCounters(stats) {
  const out = emptyCounters();
  addCounters(out, stats || {});
  return out;
}
