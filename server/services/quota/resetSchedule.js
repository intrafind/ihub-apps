// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The built-in reset schedule of usage limits.
 *
 * Every token budget runs in a calendar window that all users share, so the
 * UI can always say exactly when it resets:
 *
 *   - `day`   — resets every day at `dailyAt`;
 *   - `week`  — resets on `weeklyOn` at `weeklyAt`;
 *   - `month` — resets on the 1st of each month at `monthlyAt`.
 *
 * Times are wall-clock times in `timezone` (an IANA name; the server's own
 * zone when unset), so a reset at 00:00 stays at 00:00 across DST changes.
 * Configured in `platform.json` → `usageLimits.resets`.
 *
 * @module services/quota/resetSchedule
 */

export const WINDOWS = Object.freeze(['day', 'week', 'month']);

export const WEEKDAYS = Object.freeze([
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday'
]);

export const DEFAULT_RESETS = Object.freeze({
  timezone: null,
  dailyAt: '00:00',
  weeklyOn: 'monday',
  weeklyAt: '00:00',
  monthlyAt: '00:00'
});

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Whether `tz` is an IANA time zone this runtime knows. */
export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function serverTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function parseTime(value, fallback = '00:00') {
  const match =
    TIME_PATTERN.exec(typeof value === 'string' ? value : '') || TIME_PATTERN.exec(fallback);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * The schedule with every field filled in and validated.
 *
 * @param {Object} [resets] - `platform.usageLimits.resets`
 * @returns {{timezone: string, dailyAt: string, weeklyOn: string, weeklyAt: string, monthlyAt: string}}
 */
export function normalizeResets(resets = {}) {
  const r = resets && typeof resets === 'object' ? resets : {};
  const time = (value, key) =>
    typeof value === 'string' && TIME_PATTERN.test(value) ? value : DEFAULT_RESETS[key];
  const weeklyOn = String(r.weeklyOn || '').toLowerCase();
  return {
    timezone: isValidTimeZone(r.timezone) ? r.timezone : serverTimeZone(),
    dailyAt: time(r.dailyAt, 'dailyAt'),
    weeklyOn: WEEKDAYS.includes(weeklyOn) ? weeklyOn : DEFAULT_RESETS.weeklyOn,
    weeklyAt: time(r.weeklyAt, 'weeklyAt'),
    monthlyAt: time(r.monthlyAt, 'monthlyAt')
  };
}

const formatters = new Map();
function formatterFor(timeZone) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric'
    });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

/** The wall-clock parts of `date` in `timeZone`. */
function zonedParts(date, timeZone) {
  const parts = {};
  for (const { type, value } of formatterFor(timeZone).formatToParts(date)) {
    if (type !== 'literal') parts[type] = Number(value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
    second: parts.second
  };
}

/** Offset of `timeZone` from UTC at instant `ms`, in milliseconds. */
function offsetAt(ms, timeZone) {
  const p = zonedParts(new Date(ms), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant of a wall-clock time in `timeZone`. Day overflow is normalized
 * (`day: 0` is the last day of the previous month). A time skipped by a DST
 * change resolves to the instant just after the gap.
 */
function zonedToUtc({ year, month, day, hour, minute }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  let utc = guess - offsetAt(guess, timeZone);
  const corrected = guess - offsetAt(utc, timeZone);
  if (corrected !== utc) utc = corrected;
  return utc;
}

/** The local calendar date `days` after `date` (`{year, month, day}`). */
function addDays({ year, month, day }, days) {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function boundary(date, time, timeZone) {
  return zonedToUtc({ ...date, ...time }, timeZone);
}

/**
 * The window that contains `now`: `{ start, end }` as epoch milliseconds.
 *
 * @param {'day'|'week'|'month'} window
 * @param {Object} [resets] - `platform.usageLimits.resets` (normalized here)
 * @param {Date|number} [now]
 * @returns {{start: number, end: number}}
 */
export function windowBounds(window, resets, now = Date.now()) {
  const schedule = normalizeResets(resets);
  const tz = schedule.timezone;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const local = zonedParts(new Date(nowMs), tz);
  const today = { year: local.year, month: local.month, day: local.day };

  if (window === 'day') {
    const time = parseTime(schedule.dailyAt);
    let startDate = today;
    if (boundary(startDate, time, tz) > nowMs) startDate = addDays(today, -1);
    return {
      start: boundary(startDate, time, tz),
      end: boundary(addDays(startDate, 1), time, tz)
    };
  }

  if (window === 'week') {
    const time = parseTime(schedule.weeklyAt);
    const weekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
    const target = WEEKDAYS.indexOf(schedule.weeklyOn);
    let startDate = addDays(today, -((weekday - target + 7) % 7));
    if (boundary(startDate, time, tz) > nowMs) startDate = addDays(startDate, -7);
    return {
      start: boundary(startDate, time, tz),
      end: boundary(addDays(startDate, 7), time, tz)
    };
  }

  if (window === 'month') {
    const time = parseTime(schedule.monthlyAt);
    let startDate = { year: today.year, month: today.month, day: 1 };
    if (boundary(startDate, time, tz) > nowMs) {
      startDate =
        today.month === 1
          ? { year: today.year - 1, month: 12, day: 1 }
          : { year: today.year, month: today.month - 1, day: 1 };
    }
    const next =
      startDate.month === 12
        ? { year: startDate.year + 1, month: 1, day: 1 }
        : { year: startDate.year, month: startDate.month + 1, day: 1 };
    return { start: boundary(startDate, time, tz), end: boundary(next, time, tz) };
  }

  throw new Error(`Unknown usage window: ${window}`);
}

/**
 * Start (as an ISO string, the ledger's window key) and next reset of every
 * window at `now`.
 *
 * @param {Object} [resets]
 * @param {Date|number} [now]
 * @returns {{day: {key: string, resetAt: string}, week: {key: string, resetAt: string}, month: {key: string, resetAt: string}}}
 */
export function currentWindows(resets, now = Date.now()) {
  const out = {};
  for (const window of WINDOWS) {
    const { start, end } = windowBounds(window, resets, now);
    out[window] = { key: new Date(start).toISOString(), resetAt: new Date(end).toISOString() };
  }
  return out;
}
