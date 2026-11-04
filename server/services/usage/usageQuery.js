// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Usage queries over a time range: stored daily rollups for past days, a
 * live aggregation of today's event file (and of any day whose rollup is
 * behind its events), and raw events for the hourly ranges. Results are
 * cached for 30 seconds, so the dashboard is current without an hourly lag
 * and without re-reading files on every request.
 *
 * All days and hours are UTC.
 *
 * @module services/usage/usageQuery
 */
import { readDayEvents, eventFileMtime, flushQueue, listEventDays } from '../UsageEventLog.js';
import {
  readDailyRollup,
  readMonthlyRollup,
  isDailyRollupFresh,
  listDailyRollupDays
} from '../UsageAggregator.js';
import {
  buildRollup,
  mergeRollups,
  summarizeStats,
  lightCounters,
  countersOf,
  dimField,
  DIMENSIONS
} from './rollup.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CACHE_TTL_MS = 30 * 1000;
const MAX_CUSTOM_DAYS = 3 * 366;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const RANGES = Object.freeze(['today', '24h', '7d', '30d', '90d', '12m', 'custom']);
export const BREAKDOWN_DIMENSIONS = Object.freeze(Object.keys(DIMENSIONS));

/** A request-level error the route turns into a 400. */
export class UsageQueryError extends Error {}

const utcDay = ms => new Date(ms).toISOString().slice(0, 10);
const startOfDay = date => Date.parse(`${date}T00:00:00.000Z`);

function daysBetween(fromDay, toDay) {
  const out = [];
  for (let t = startOfDay(fromDay); t <= startOfDay(toDay); t += DAY_MS) out.push(utcDay(t));
  return out;
}

/**
 * Resolve a range to a window and the previous window of equal length.
 *
 * @param {Object} params
 * @param {string} [params.range='7d'] - one of RANGES
 * @param {string} [params.from] - `YYYY-MM-DD` (custom)
 * @param {string} [params.to] - `YYYY-MM-DD` (custom, inclusive)
 * @param {number} [now]
 * @returns {{range: string, granularity: 'hour'|'day', from: number, to: number,
 *   previous: {from: number, to: number}}}
 */
export function resolveRange({ range = '7d', from, to } = {}, now = Date.now()) {
  if (!RANGES.includes(range)) throw new UsageQueryError(`Unknown range: ${range}`);
  if (range === 'today') {
    const start = startOfDay(utcDay(now));
    return {
      range,
      granularity: 'hour',
      from: start,
      to: now,
      previous: { from: start - DAY_MS, to: now - DAY_MS }
    };
  }
  if (range === '24h') {
    const start = Math.floor(now / HOUR_MS) * HOUR_MS - 23 * HOUR_MS;
    return {
      range,
      granularity: 'hour',
      from: start,
      to: now,
      previous: { from: start - DAY_MS, to: now - DAY_MS }
    };
  }
  let firstDay;
  let lastDay;
  if (range === 'custom') {
    if (!DATE.test(from || '') || !DATE.test(to || '') || Number.isNaN(startOfDay(from))) {
      throw new UsageQueryError('Custom ranges need from and to as YYYY-MM-DD');
    }
    if (from > to) throw new UsageQueryError('from must not be after to');
    if (daysBetween(from, to).length > MAX_CUSTOM_DAYS) {
      throw new UsageQueryError(`Custom ranges are limited to ${MAX_CUSTOM_DAYS} days`);
    }
    firstDay = from;
    lastDay = to;
  } else {
    const days = range === '12m' ? 365 : Number.parseInt(range, 10);
    lastDay = utcDay(now);
    firstDay = utcDay(startOfDay(lastDay) - (days - 1) * DAY_MS);
  }
  const fromMs = startOfDay(firstDay);
  const toMs = Math.min(startOfDay(lastDay) + DAY_MS - 1, Math.max(now, fromMs));
  const length = startOfDay(lastDay) + DAY_MS - fromMs;
  return {
    range,
    granularity: 'day',
    from: fromMs,
    to: toMs,
    previous: { from: fromMs - length, to: fromMs - 1 }
  };
}

// ── caches ────────────────────────────────────────────────────────────────

/** day → { mtime, events } for the raw reads of the hourly ranges. */
const eventCache = new Map();
/** day → { mtime, rollup } for days aggregated live. */
const liveRollupCache = new Map();
/** query key → { at, value } */
const resultCache = new Map();

function remember(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

/** Forget every cached result (tests, and after an on-demand rollup). */
export function clearUsageQueryCache() {
  eventCache.clear();
  liveRollupCache.clear();
  resultCache.clear();
}

async function cachedResult(key, compute, now = Date.now()) {
  const hit = resultCache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await compute();
  remember(resultCache, key, { at: now, value }, 200);
  return value;
}

async function dayEvents(date) {
  const mtime = await eventFileMtime(date);
  if (mtime === null) return [];
  const hit = eventCache.get(date);
  if (hit && hit.mtime === mtime) return hit.events;
  const events = await readDayEvents(date);
  remember(eventCache, date, { mtime, events }, 4);
  return events;
}

/**
 * One day's rollup: the stored one when it is current, otherwise built live
 * from the day's events (today always). Null for a day without data.
 */
export async function getDayRollup(date) {
  if (await isDailyRollupFresh(date)) {
    const stored = await readDailyRollup(date);
    if (stored) return stored;
  }
  const mtime = await eventFileMtime(date);
  if (mtime === null) return null;
  const hit = liveRollupCache.get(date);
  if (hit && hit.mtime === mtime) return hit.rollup;
  const rollup = buildRollup(await readDayEvents(date), { date });
  remember(liveRollupCache, date, { mtime, rollup }, 400);
  return rollup;
}

/**
 * The rollup and the time series of a window.
 * @param {{from: number, to: number, granularity: 'hour'|'day'}} window
 * @returns {Promise<{rollup: Object, series: Object[]}>}
 */
export async function computeWindow({ from, to, granularity }) {
  const days = daysBetween(utcDay(from), utcDay(to));
  if (granularity === 'hour') {
    const fromIso = new Date(from).toISOString();
    const toIso = new Date(to).toISOString();
    const events = [];
    for (const day of days) {
      for (const e of await dayEvents(day)) if (e.ts >= fromIso && e.ts <= toIso) events.push(e);
    }
    const byHour = new Map();
    for (const e of events) {
      const key = e.ts.slice(0, 13);
      if (!byHour.has(key)) byHour.set(key, []);
      byHour.get(key).push(e);
    }
    const series = [];
    for (let t = Math.floor(from / HOUR_MS) * HOUR_MS; t <= to; t += HOUR_MS) {
      const key = new Date(t).toISOString().slice(0, 13);
      series.push({ t: `${key}:00:00.000Z`, ...countersOf(byHour.get(key) || []) });
    }
    return { rollup: buildRollup(events), series };
  }

  const rollups = [];
  const series = [];
  const covered = new Set();
  for (const day of days) {
    const rollup = await getDayRollup(day);
    if (rollup) {
      rollups.push(rollup);
      covered.add(day.slice(0, 7));
    }
    series.push({ t: day, ...lightCounters(rollup?.totals) });
  }
  // Months whose daily rollups are gone (past daily retention) still count
  // through their monthly rollup, on the first day of the month in range.
  for (const month of new Set(days.map(d => d.slice(0, 7)))) {
    if (covered.has(month)) continue;
    const monthly = await readMonthlyRollup(month);
    if (!monthly) continue;
    rollups.push(monthly);
    const point = series.find(p => p.t.startsWith(month));
    if (point) Object.assign(point, lightCounters(monthly.totals), { t: point.t, month: true });
  }
  return { rollup: mergeRollups(rollups), series };
}

function activeUsers(rollup) {
  return Object.keys(rollup.byUser || {}).length;
}

function averageRating(ratings) {
  let n = 0;
  let sum = 0;
  for (const k of [1, 2, 3, 4, 5]) {
    n += ratings?.[k] || 0;
    sum += k * (ratings?.[k] || 0);
  }
  return n ? sum / n : null;
}

function kpis(rollup) {
  return {
    ...summarizeStats(rollup.totals),
    activeUsers: activeUsers(rollup),
    feedbackCount: rollup.feedback?.count || 0,
    averageRating: averageRating(rollup.feedback?.ratings)
  };
}

function rowsOf(rollup, dimension) {
  return Object.entries(rollup[dimField(dimension)] || {}).map(([key, entry]) => ({
    key,
    ...summarizeStats(entry),
    ...(entry.models
      ? {
          models: Object.entries(entry.models)
            .map(([model, c]) => ({
              key: model,
              ...c,
              totalTokens: c.promptTokens + c.completionTokens
            }))
            .sort((a, b) => b.totalTokens - a.totalTokens)
        }
      : {})
  }));
}

function topBy(rows, field, n = 5) {
  return [...rows].sort((a, b) => (b[field] || 0) - (a[field] || 0)).slice(0, n);
}

function windowInfo(resolved) {
  return {
    range: resolved.range,
    granularity: resolved.granularity,
    from: new Date(resolved.from).toISOString(),
    to: new Date(resolved.to).toISOString()
  };
}

async function maybeFlush(resolved, now) {
  // This worker's buffered records belong in a range that reaches now.
  if (resolved.to >= now - DAY_MS) await flushQueue().catch(() => {});
}

function cacheKey(kind, resolved, extra = '') {
  return `${kind}|${resolved.granularity}|${resolved.from}|${Math.floor(resolved.to / 1000)}|${extra}`;
}

/**
 * KPIs (with the previous equal period), the time series, top models and
 * top apps.
 */
export async function getUsageSummary(params, now = Date.now()) {
  const resolved = resolveRange(params, now);
  return cachedResult(cacheKey('summary', resolved), async () => {
    await maybeFlush(resolved, now);
    const current = await computeWindow(resolved);
    const previous = await computeWindow({
      ...resolved.previous,
      granularity: resolved.granularity
    });
    return {
      ...windowInfo(resolved),
      generatedAt: new Date(now).toISOString(),
      totals: kpis(current.rollup),
      previous: kpis(previous.rollup),
      series: current.series,
      topModels: topBy(rowsOf(current.rollup, 'model'), 'totalTokens'),
      topApps: topBy(rowsOf(current.rollup, 'app'), 'totalTokens'),
      byOutcome: current.rollup.byOutcome
    };
  });
}

const SORTABLE = new Set([
  'key',
  'requests',
  'promptTokens',
  'completionTokens',
  'cacheReadTokens',
  'totalTokens',
  'errors',
  'errorRate',
  'latencyP95',
  'lastTs'
]);

/**
 * One row per key of a dimension, each with per-model sub-rows.
 * @param {Object} params - range params plus `dimension`, `sort`, `order`
 */
export async function getUsageBreakdown(params, now = Date.now()) {
  const dimension = params.dimension || 'user';
  if (!BREAKDOWN_DIMENSIONS.includes(dimension)) {
    throw new UsageQueryError(`Unknown dimension: ${dimension}`);
  }
  const sort = SORTABLE.has(params.sort) ? params.sort : 'totalTokens';
  const order = params.order === 'asc' ? 'asc' : 'desc';
  const resolved = resolveRange(params, now);
  return cachedResult(
    cacheKey('breakdown', resolved, `${dimension}|${sort}|${order}`),
    async () => {
      await maybeFlush(resolved, now);
      const { rollup } = await computeWindow(resolved);
      const rows = rowsOf(rollup, dimension).sort((a, b) => {
        const av = a[sort] ?? '';
        const bv = b[sort] ?? '';
        const cmp =
          typeof av === 'number' && typeof bv === 'number'
            ? av - bv
            : String(av).localeCompare(String(bv));
        return order === 'asc' ? cmp : -cmp;
      });
      return { ...windowInfo(resolved), dimension, sort, order, rows };
    }
  );
}

/** Errors over time, by code and by provider, and latency per model. */
export async function getUsageReliability(params, now = Date.now()) {
  const resolved = resolveRange(params, now);
  return cachedResult(cacheKey('reliability', resolved), async () => {
    await maybeFlush(resolved, now);
    const { rollup, series } = await computeWindow(resolved);
    return {
      ...windowInfo(resolved),
      series: series.map(p => ({
        t: p.t,
        requests: p.requests,
        errors: p.errors,
        errorRate: p.requests ? p.errors / p.requests : 0
      })),
      byOutcome: rollup.byOutcome,
      byError: Object.entries(rollup.byError)
        .map(([code, e]) => ({ code, count: e.count, byProvider: e.byProvider }))
        .sort((a, b) => b.count - a.count),
      byProvider: rowsOf(rollup, 'provider')
        .map(({ models: _m, ...row }) => row)
        .sort((a, b) => b.requests - a.requests),
      byModel: rowsOf(rollup, 'model').sort((a, b) => b.requests - a.requests)
    };
  });
}

function feedbackBucket(ratings) {
  const total = [1, 2, 3, 4, 5].reduce((n, k) => n + (ratings?.[k] || 0), 0);
  return { total, ratings: { ...ratings }, averageRating: averageRating(ratings) || 0 };
}

/** Feedback ratings in the range: totals and per user, app and model. */
export async function getFeedbackSummary(params, now = Date.now()) {
  const resolved = resolveRange(params, now);
  return cachedResult(cacheKey('feedback', resolved), async () => {
    await maybeFlush(resolved, now);
    const { rollup } = await computeWindow(resolved);
    const fb = rollup.feedback;
    const per = map =>
      Object.fromEntries(Object.entries(map || {}).map(([k, r]) => [k, feedbackBucket(r)]));
    return {
      ...windowInfo(resolved),
      ...feedbackBucket(fb.ratings),
      perUser: per(fb.byUser),
      perApp: per(fb.byApp),
      perModel: per(fb.byModel)
    };
  });
}

/** Oldest day with data, for the range picker. */
export async function getDataStart() {
  const [events, rollups] = await Promise.all([listEventDays(), listDailyRollupDays()]);
  return [events[0], rollups[0]].filter(Boolean).sort((a, b) => a.localeCompare(b))[0] || null;
}
