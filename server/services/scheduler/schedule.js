/**
 * Schedules — the one normalized shape every scheduled job is described by,
 * and the arithmetic on it: validation, the next run times, and a sentence a
 * person can check before saving.
 *
 * Every preset the task form and the `schedule_task` tool offer compiles to
 * the same object:
 *
 *   { type: 'manual' }
 *   { type: 'once',     at }                               absolute instant
 *   { type: 'interval', every, unit, time? }               minutes | hours | days
 *   { type: 'daily',    time }                             'HH:MM'
 *   { type: 'weekdays', time }                             Mon–Fri
 *   { type: 'weekly',   time, days }                       0 = Sunday … 6 = Saturday
 *   { type: 'monthly',  time, daysOfMonth }                1–31 and/or 'last'
 *   { type: 'cron',     cron }                             croner syntax
 *
 * plus, on every type but `manual`: `timezone` (IANA), and the optional window
 * `startAt`, `endAt` and `maxRuns`. An interval also carries `anchorAt`, the
 * instant its slots count from, so editing the task later does not shift them.
 *
 * Nothing here keeps a `Cron` instance alive: a `Cron` built without a callback
 * only evaluates its pattern, so the scheduler can compute next runs for any
 * number of stored jobs without holding a timer per job.
 *
 * Calendar arithmetic is done in the schedule's timezone, so "every day at
 * 08:00" stays at 08:00 across a DST change, "every 3 days" keeps its wall
 * clock time, and "the 31st" falls back to the last day of shorter months.
 *
 * @module services/scheduler/schedule
 */
import { Cron } from 'croner';

/** Every schedule type, in the order the form lists them. */
export const SCHEDULE_TYPES = Object.freeze([
  'manual',
  'once',
  'interval',
  'daily',
  'weekdays',
  'weekly',
  'monthly',
  'cron'
]);

/** Units an interval may be expressed in, with their length in ms. */
export const INTERVAL_UNITS = Object.freeze({
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000
});

/** Upper bounds that keep a schedule's arithmetic finite. */
const MAX_INTERVAL = { minutes: 60 * 24 * 366, hours: 24 * 366, days: 366 };
const MAX_RUNS_LIMIT = 100_000;
/** Next runs a preview may ask for. */
export const MAX_PREVIEW_RUNS = 10;
/** Runs sampled to find the shortest gap of a cron pattern. */
const CRON_GAP_SAMPLE = 60;
/** Days walked at most when a calendar predicate looks for its next match. */
const MAX_DAY_SCAN = 800;

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * A schedule validation problem.
 *
 * @typedef {Object} ScheduleError
 * @property {string} field - Dotted field name (`schedule.time`).
 * @property {string} code - Machine-readable reason.
 * @property {string} message - English explanation.
 */

export class ScheduleValidationError extends Error {
  /**
   * @param {ScheduleError[]} errors
   */
  constructor(errors) {
    super(errors.map(e => e.message).join('; ') || 'Invalid schedule');
    this.name = 'ScheduleValidationError';
    this.code = 'INVALID_SCHEDULE';
    this.errors = errors;
  }
}

/**
 * Whether `timezone` is an IANA zone this runtime knows.
 *
 * @param {unknown} timezone
 * @returns {boolean}
 */
export function isValidTimezone(timezone) {
  if (typeof timezone !== 'string' || !timezone || timezone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

const partsFormatters = new Map();

function partsFormatter(timezone) {
  let formatter = partsFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short'
    });
    partsFormatters.set(timezone, formatter);
  }
  return formatter;
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * The wall-clock fields of an instant in a timezone.
 *
 * @param {Date|number} instant
 * @param {string} timezone
 * @returns {{year: number, month: number, day: number, hour: number, minute: number,
 *   second: number, weekday: number}} `month` is 1-based, `weekday` 0 = Sunday.
 */
export function zonedParts(instant, timezone) {
  const date = instant instanceof Date ? instant : new Date(instant);
  const out = {};
  for (const part of partsFormatter(timezone).formatToParts(date)) {
    if (part.type === 'weekday') out.weekday = WEEKDAY_INDEX[part.value];
    else if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return out;
}

/** Days in a month (`month` 1-based). */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Day number of a calendar date, for whole-day differences. */
function dayNumber({ year, month, day }) {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

/**
 * The instant a wall-clock time in `timezone` denotes. A time that does not
 * exist (skipped by a DST change) lands just after the gap; an ambiguous one
 * (repeated) resolves to its first occurrence.
 *
 * @param {{year: number, month: number, day: number, hour?: number, minute?: number}} local
 * @param {string} timezone
 * @returns {Date}
 */
export function zonedTimeToInstant(local, timezone) {
  const guess = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour || 0,
    local.minute || 0,
    local.second || 0
  );
  const offsetAt = ms => {
    const p = zonedParts(ms, timezone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
  };
  // Two passes settle every real offset change; the earlier of the candidates
  // wins for a repeated hour.
  const first = guess - offsetAt(guess);
  const second = guess - offsetAt(first);
  const candidates = [first, second].filter(ms => {
    const p = zonedParts(ms, timezone);
    return (
      p.year === local.year &&
      p.month === local.month &&
      p.day === local.day &&
      p.hour === (local.hour || 0) &&
      p.minute === (local.minute || 0)
    );
  });
  if (candidates.length > 0) return new Date(Math.min(...candidates));
  return new Date(Math.max(first, second));
}

/**
 * Parse an instant. A string with an offset or `Z` is taken as written; a bare
 * local date-time (`2026-10-01T09:00`) is read in `timezone`, which is what a
 * `datetime-local` input and a model resolving "tomorrow at nine" produce.
 *
 * @param {unknown} value
 * @param {string} [timezone='UTC']
 * @returns {Date|null}
 */
export function parseInstant(value, timezone = 'UTC') {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value) : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(
    text
  );
  if (local) {
    const [, y, mo, d, h = '0', mi = '0', s = '0'] = local;
    const parts = {
      year: Number(y),
      month: Number(mo),
      day: Number(d),
      hour: Number(h),
      minute: Number(mi),
      second: Number(s)
    };
    if (parts.month < 1 || parts.month > 12 || parts.day < 1) return null;
    if (parts.day > daysInMonth(parts.year, parts.month) || parts.hour > 23 || parts.minute > 59) {
      return null;
    }
    return zonedTimeToInstant(parts, isValidTimezone(timezone) ? timezone : 'UTC');
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function parseTime(time) {
  const match = TIME_PATTERN.exec(typeof time === 'string' ? time.trim() : '');
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

const UNIT_ALIASES = {
  m: 'minutes',
  min: 'minutes',
  mins: 'minutes',
  minute: 'minutes',
  minutes: 'minutes',
  h: 'hours',
  hr: 'hours',
  hrs: 'hours',
  hour: 'hours',
  hours: 'hours',
  d: 'days',
  day: 'days',
  days: 'days'
};

function normalizeUnit(unit) {
  if (typeof unit !== 'string' || !unit.trim()) return 'hours';
  const key = unit.trim().toLowerCase();
  return UNIT_ALIASES[key] || key;
}

function toIso(date) {
  return date ? date.toISOString() : null;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * Normalize a schedule as the form or a tool sent it: fill defaults, coerce
 * the lenient input shapes (`dayOfMonth: 15`, `days: ['mon']`, a number as a
 * string), and drop fields the type does not use.
 *
 * Does not validate — {@link validateSchedule} does; the two are separate so
 * a preview can show what it understood next to what is wrong with it.
 *
 * @param {Object} input
 * @param {Object} [options]
 * @param {string} [options.timezone='UTC'] - Zone to use when the input names none.
 * @param {Date|number} [options.now=Date.now()] - Anchor for a new interval.
 * @param {Object} [options.previous] - The schedule this one replaces; an unchanged
 *   interval keeps its anchor.
 * @returns {Object} The normalized schedule.
 */
export function normalizeSchedule(input, { timezone = 'UTC', now = Date.now(), previous } = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const type = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : '';
  const out = { type: SCHEDULE_TYPES.includes(type) ? type : type || 'manual' };
  if (out.type === 'manual') return out;

  const zone = typeof raw.timezone === 'string' && raw.timezone.trim() ? raw.timezone.trim() : '';
  out.timezone = zone || timezone || 'UTC';
  const zoneForParsing = isValidTimezone(out.timezone) ? out.timezone : 'UTC';

  switch (out.type) {
    case 'once': {
      const at = parseInstant(raw.at ?? raw.startAt, zoneForParsing);
      out.at = at ? at.toISOString() : typeof raw.at === 'string' ? raw.at : null;
      break;
    }
    case 'interval': {
      const every = Number(raw.every);
      out.every = Number.isFinite(every) ? every : raw.every;
      out.unit = normalizeUnit(raw.unit);
      if (out.unit === 'days' && raw.time !== undefined && raw.time !== null && raw.time !== '') {
        out.time = String(raw.time).trim();
      }
      break;
    }
    case 'daily':
    case 'weekdays':
      out.time = typeof raw.time === 'string' ? raw.time.trim() : raw.time;
      break;
    case 'weekly': {
      out.time = typeof raw.time === 'string' ? raw.time.trim() : raw.time;
      const days = Array.isArray(raw.days) ? raw.days : raw.days !== undefined ? [raw.days] : [];
      out.days = uniqueSorted(
        days
          .map(day => {
            if (typeof day === 'string' && !/^\d+$/.test(day.trim())) {
              const key = day.trim().slice(0, 3).toLowerCase();
              const index = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(key);
              return index;
            }
            const n = Number(day);
            return n === 7 ? 0 : n;
          })
          .filter(n => Number.isInteger(n))
      );
      break;
    }
    case 'monthly': {
      out.time = typeof raw.time === 'string' ? raw.time.trim() : raw.time;
      const source = raw.daysOfMonth ?? raw.dayOfMonth;
      const list = Array.isArray(source) ? source : source !== undefined ? [source] : [];
      const numbers = [];
      let last = false;
      for (const entry of list) {
        if (typeof entry === 'string' && ['last', 'l', '-1'].includes(entry.trim().toLowerCase())) {
          last = true;
          continue;
        }
        const n = Number(entry);
        if (n === -1) last = true;
        else if (Number.isInteger(n)) numbers.push(n);
      }
      out.daysOfMonth = [...uniqueSorted(numbers), ...(last ? ['last'] : [])];
      break;
    }
    case 'cron':
      out.cron = typeof raw.cron === 'string' ? raw.cron.trim().replace(/\s+/g, ' ') : raw.cron;
      break;
    default:
      break;
  }

  if (out.type !== 'once') {
    const startAt = parseInstant(raw.startAt, zoneForParsing);
    const endAt = parseInstant(raw.endAt, zoneForParsing);
    if (startAt) out.startAt = startAt.toISOString();
    else if (raw.startAt) out.startAt = String(raw.startAt);
    if (endAt) out.endAt = endAt.toISOString();
    else if (raw.endAt) out.endAt = String(raw.endAt);
    if (raw.maxRuns !== undefined && raw.maxRuns !== null && raw.maxRuns !== '') {
      const maxRuns = Number(raw.maxRuns);
      out.maxRuns = Number.isFinite(maxRuns) ? maxRuns : raw.maxRuns;
    }
  }

  if (out.type === 'interval') {
    // Slots count from the anchor. An edit that leaves the interval as it was
    // keeps the old anchor, so saving a new name does not shift the runs.
    const sameInterval =
      previous?.type === 'interval' &&
      previous.every === out.every &&
      previous.unit === out.unit &&
      (previous.time || null) === (out.time || null) &&
      (previous.startAt || null) === (out.startAt || null) &&
      (previous.timezone || null) === (out.timezone || null);
    const anchor =
      (sameInterval && previous.anchorAt) ||
      out.startAt ||
      parseInstant(raw.anchorAt)?.toISOString() ||
      new Date(now).toISOString();
    out.anchorAt = anchor;
  }
  return out;
}

/**
 * The croner pattern of a calendar schedule, or null for the types that are
 * not a single pattern.
 *
 * @param {Object} schedule - Normalized schedule.
 * @returns {string|null}
 */
export function cronPatternOf(schedule) {
  const time = parseTime(schedule?.time);
  switch (schedule?.type) {
    case 'daily':
      return time ? `${time.minute} ${time.hour} * * *` : null;
    case 'weekdays':
      return time ? `${time.minute} ${time.hour} * * 1-5` : null;
    case 'weekly':
      return time && schedule.days?.length
        ? `${time.minute} ${time.hour} * * ${schedule.days.join(',')}`
        : null;
    case 'cron':
      return typeof schedule.cron === 'string' ? schedule.cron : null;
    default:
      return null;
  }
}

function buildCron(pattern, timezone) {
  return new Cron(pattern, { timezone, paused: true });
}

/**
 * Validate a normalized schedule.
 *
 * @param {Object} schedule - {@link normalizeSchedule}'s result.
 * @param {Object} [options]
 * @param {number} [options.minIntervalMinutes=0] - Shortest gap allowed between two runs.
 * @param {Date|number} [options.now=Date.now()]
 * @param {boolean} [options.requireFuture=true] - A `once` in the past is an error.
 * @returns {ScheduleError[]} Empty when the schedule is usable.
 */
export function validateSchedule(
  schedule,
  { minIntervalMinutes = 0, now = Date.now(), requireFuture = true } = {}
) {
  const errors = [];
  const add = (field, code, message) => errors.push({ field: `schedule.${field}`, code, message });
  if (!schedule || !SCHEDULE_TYPES.includes(schedule.type)) {
    add('type', 'INVALID_TYPE', `Schedule type must be one of: ${SCHEDULE_TYPES.join(', ')}`);
    return errors;
  }
  if (schedule.type === 'manual') return errors;
  if (!isValidTimezone(schedule.timezone)) {
    add('timezone', 'INVALID_TIMEZONE', `Unknown timezone: ${String(schedule.timezone)}`);
    return errors;
  }
  const minGapMs = Math.max(0, Number(minIntervalMinutes) || 0) * 60_000;
  const nowMs = typeof now === 'number' ? now : now.getTime();

  switch (schedule.type) {
    case 'once': {
      const at = parseInstant(schedule.at);
      if (!at) add('at', 'INVALID_DATE', 'A one-time schedule needs a valid date and time');
      else if (requireFuture && at.getTime() <= nowMs) {
        add('at', 'IN_PAST', 'The time of a one-time schedule must be in the future');
      }
      break;
    }
    case 'interval': {
      if (!Object.hasOwn(INTERVAL_UNITS, schedule.unit)) {
        add('unit', 'INVALID_UNIT', 'Interval unit must be minutes, hours or days');
        break;
      }
      const every = schedule.every;
      if (!Number.isInteger(every) || every < 1 || every > MAX_INTERVAL[schedule.unit]) {
        add(
          'every',
          'INVALID_INTERVAL',
          `Interval must be a whole number between 1 and ${MAX_INTERVAL[schedule.unit]} ${schedule.unit}`
        );
        break;
      }
      if (minGapMs && every * INTERVAL_UNITS[schedule.unit] < minGapMs) {
        add(
          'every',
          'BELOW_MIN_INTERVAL',
          `Runs must be at least ${minIntervalMinutes} minutes apart`
        );
      }
      if (schedule.time !== undefined && !parseTime(schedule.time)) {
        add('time', 'INVALID_TIME', 'Time must be HH:MM (24-hour)');
      }
      if (!parseInstant(schedule.anchorAt)) {
        add('anchorAt', 'INVALID_DATE', 'Interval anchor is not a valid date');
      }
      break;
    }
    case 'daily':
    case 'weekdays':
    case 'weekly':
    case 'monthly': {
      if (!parseTime(schedule.time)) add('time', 'INVALID_TIME', 'Time must be HH:MM (24-hour)');
      if (schedule.type === 'weekly') {
        if (!schedule.days?.length || schedule.days.some(d => d < 0 || d > 6)) {
          add('days', 'INVALID_DAYS', 'Pick at least one weekday (0 = Sunday … 6 = Saturday)');
        }
      }
      if (schedule.type === 'monthly') {
        const numbers = (schedule.daysOfMonth || []).filter(d => d !== 'last');
        if (!schedule.daysOfMonth?.length || numbers.some(d => d < 1 || d > 31)) {
          add('daysOfMonth', 'INVALID_DAYS', 'Pick at least one day of the month (1–31 or last)');
        }
      }
      break;
    }
    case 'cron': {
      if (typeof schedule.cron !== 'string' || !schedule.cron || schedule.cron.length > 120) {
        add('cron', 'INVALID_CRON', 'A cron expression is required');
        break;
      }
      const fields = schedule.cron.split(' ').length;
      if (fields !== 5 && fields !== 6) {
        add('cron', 'INVALID_CRON', 'A cron expression has five fields (or six with seconds)');
        break;
      }
      let job;
      try {
        job = buildCron(schedule.cron, schedule.timezone);
      } catch (error) {
        add('cron', 'INVALID_CRON', `Invalid cron expression: ${error.message}`);
        break;
      }
      const sample = job.nextRuns(CRON_GAP_SAMPLE, new Date(nowMs));
      if (sample.length === 0) {
        add('cron', 'NEVER_RUNS', 'This cron expression never runs');
        break;
      }
      if (minGapMs) {
        for (let i = 1; i < sample.length; i++) {
          if (sample[i].getTime() - sample[i - 1].getTime() < minGapMs) {
            add(
              'cron',
              'BELOW_MIN_INTERVAL',
              `Runs must be at least ${minIntervalMinutes} minutes apart`
            );
            break;
          }
        }
      }
      break;
    }
    default:
      break;
  }

  if (schedule.startAt !== undefined && !parseInstant(schedule.startAt)) {
    add('startAt', 'INVALID_DATE', 'Start date is not a valid date');
  }
  if (schedule.endAt !== undefined) {
    const endAt = parseInstant(schedule.endAt);
    if (!endAt) add('endAt', 'INVALID_DATE', 'End date is not a valid date');
    else {
      const startAt = parseInstant(schedule.startAt);
      if (startAt && endAt.getTime() <= startAt.getTime()) {
        add('endAt', 'END_BEFORE_START', 'End date must be after the start date');
      }
    }
  }
  if (schedule.maxRuns !== undefined) {
    if (
      !Number.isInteger(schedule.maxRuns) ||
      schedule.maxRuns < 1 ||
      schedule.maxRuns > MAX_RUNS_LIMIT
    ) {
      add('maxRuns', 'INVALID_MAX_RUNS', `Max runs must be between 1 and ${MAX_RUNS_LIMIT}`);
    }
  }
  return errors;
}

/**
 * Normalize and validate in one step; throws on a bad schedule.
 *
 * @param {Object} input
 * @param {Object} [options] - Both {@link normalizeSchedule}'s and {@link validateSchedule}'s.
 * @returns {Object} The normalized schedule.
 * @throws {ScheduleValidationError}
 */
export function parseSchedule(input, options = {}) {
  const schedule = normalizeSchedule(input, options);
  const errors = validateSchedule(schedule, options);
  if (errors.length > 0) throw new ScheduleValidationError(errors);
  return schedule;
}

/**
 * The first calendar day at or after `from` (in `timezone`) at `time` that
 * satisfies `matches`, strictly after `after`.
 */
function nextCalendarSlot({ after, timezone, time, matches }) {
  const job = buildCron(`${time.minute} ${time.hour} * * *`, timezone);
  let cursor = after;
  for (let i = 0; i < MAX_DAY_SCAN; i++) {
    const next = job.nextRun(cursor);
    if (!next) return null;
    if (matches(zonedParts(next, timezone))) return next;
    cursor = next;
  }
  return null;
}

/**
 * The first slot of a schedule strictly after `after`, ignoring the window
 * (`startAt`, `endAt`, `maxRuns`).
 *
 * @param {Object} schedule - Normalized, valid schedule.
 * @param {Date} after
 * @returns {Date|null}
 */
function rawNextSlot(schedule, after) {
  switch (schedule.type) {
    case 'manual':
      return null;
    case 'once': {
      const at = parseInstant(schedule.at);
      return at && at.getTime() > after.getTime() ? at : null;
    }
    case 'interval': {
      const anchor = parseInstant(schedule.anchorAt) || new Date(0);
      if (schedule.unit === 'days') {
        const anchorParts = zonedParts(anchor, schedule.timezone);
        const time = parseTime(schedule.time) || {
          hour: anchorParts.hour,
          minute: anchorParts.minute
        };
        const anchorDay = dayNumber(anchorParts);
        // An anchor given as `startAt` is the first run; one that is only the
        // creation time is not — "every 2 days" set up at noon does not run
        // at noon.
        const floor = new Date(
          Math.max(after.getTime(), schedule.startAt ? anchor.getTime() - 1 : anchor.getTime())
        );
        return nextCalendarSlot({
          after: floor,
          timezone: schedule.timezone,
          time,
          matches: parts => {
            const diff = dayNumber(parts) - anchorDay;
            return diff >= 0 && diff % schedule.every === 0;
          }
        });
      }
      const step = schedule.every * INTERVAL_UNITS[schedule.unit];
      const first = schedule.startAt ? anchor.getTime() : anchor.getTime() + step;
      if (after.getTime() < first) return new Date(first);
      const k = Math.floor((after.getTime() - first) / step) + 1;
      return new Date(first + k * step);
    }
    case 'monthly': {
      const time = parseTime(schedule.time);
      const wanted = schedule.daysOfMonth || [];
      const numbers = wanted.filter(d => d !== 'last');
      const wantsLast = wanted.includes('last');
      return nextCalendarSlot({
        after,
        timezone: schedule.timezone,
        time,
        matches: ({ year, month, day }) => {
          const last = daysInMonth(year, month);
          if (numbers.includes(day)) return true;
          if (day === last && (wantsLast || numbers.some(d => d > last))) return true;
          return false;
        }
      });
    }
    default: {
      const pattern = cronPatternOf(schedule);
      if (!pattern) return null;
      return buildCron(pattern, schedule.timezone).nextRun(after) || null;
    }
  }
}

/**
 * The next slot of a schedule strictly after `after`, within its window.
 *
 * @param {Object} schedule - Normalized, valid schedule.
 * @param {Object} [options]
 * @param {Date|number|string} [options.after=Date.now()]
 * @param {number} [options.runCount=0] - Runs already made (for `maxRuns`).
 * @returns {Date|null} Null when the schedule will not run again.
 */
export function nextSlot(schedule, { after = Date.now(), runCount = 0 } = {}) {
  if (!schedule || schedule.type === 'manual') return null;
  if (Number.isInteger(schedule.maxRuns) && runCount >= schedule.maxRuns) return null;
  let from = after instanceof Date ? after : new Date(after);
  if (!Number.isFinite(from.getTime())) from = new Date();
  const startAt = schedule.type === 'interval' ? null : parseInstant(schedule.startAt);
  if (startAt && from.getTime() < startAt.getTime()) from = new Date(startAt.getTime() - 1);
  let slot;
  try {
    slot = rawNextSlot(schedule, from);
  } catch {
    return null;
  }
  if (!slot) return null;
  const endAt = parseInstant(schedule.endAt);
  if (endAt && slot.getTime() > endAt.getTime()) return null;
  return slot;
}

/**
 * The next `count` slots after `after`.
 *
 * @param {Object} schedule
 * @param {Object} [options]
 * @param {number} [options.count=5]
 * @param {Date|number} [options.after=Date.now()]
 * @param {number} [options.runCount=0]
 * @returns {Date[]}
 */
export function nextSlots(schedule, { count = 5, after = Date.now(), runCount = 0 } = {}) {
  const out = [];
  let cursor = after instanceof Date ? after : new Date(after);
  const limit = Math.max(0, Math.min(MAX_PREVIEW_RUNS, Number(count) || 0));
  for (let i = 0; i < limit; i++) {
    const slot = nextSlot(schedule, { after: cursor, runCount: runCount + i });
    if (!slot) break;
    out.push(slot);
    cursor = slot;
  }
  return out;
}

/**
 * The slots a schedule had between two instants: `(from, to]`, at most
 * `limit` of them, oldest first. Used to tell what a server that was down
 * missed.
 *
 * @param {Object} schedule
 * @param {Object} options
 * @param {Date|number} options.from - Exclusive lower bound.
 * @param {Date|number} options.to - Inclusive upper bound.
 * @param {number} [options.runCount=0]
 * @param {number} [options.limit=1000]
 * @returns {{slots: Date[], truncated: boolean}}
 */
export function slotsBetween(schedule, { from, to, runCount = 0, limit = 1000 }) {
  const toMs = to instanceof Date ? to.getTime() : Number(to);
  const slots = [];
  let cursor = from instanceof Date ? from : new Date(from);
  for (;;) {
    const slot = nextSlot(schedule, { after: cursor, runCount: runCount + slots.length });
    if (!slot || slot.getTime() > toMs) return { slots, truncated: false };
    if (slots.length >= limit) return { slots, truncated: true };
    slots.push(slot);
    cursor = slot;
  }
}

/**
 * The fixed delay a job starts after its slot, derived from its id so it is
 * the same on every computation and every worker. Spreads the thousands of
 * "every day at 09:00" tasks over the stagger window instead of starting them
 * in the same second.
 *
 * @param {string} id - Job id.
 * @param {number} staggerMinutes - Window size; 0 turns staggering off.
 * @returns {number} Offset in ms, in `[0, staggerMinutes * 60 s)`.
 */
export function staggerOffsetMs(id, staggerMinutes) {
  const windowSeconds = Math.floor(Math.max(0, Number(staggerMinutes) || 0) * 60);
  if (!windowSeconds || typeof id !== 'string') return 0;
  // FNV-1a: stable, fast, and good enough to spread ids over a window.
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % windowSeconds) * 1000;
}

// ── descriptions ──────────────────────────────────────────────────────────

const WORDS = {
  en: {
    manual: 'Only when started manually',
    once: 'Once on {at}',
    every: { minutes: ['minute', 'minutes'], hours: ['hour', 'hours'], days: ['day', 'days'] },
    interval: 'Every {n} {unit}',
    intervalOne: 'Every {unit}',
    intervalAt: '{base} at {time}',
    daily: 'Every day at {time}',
    weekdays: 'Every weekday (Monday to Friday) at {time}',
    weekly: 'Every {days} at {time}',
    monthly: 'Monthly on the {days} at {time}',
    lastDay: 'last day',
    cron: 'Cron schedule "{cron}"',
    and: 'and',
    from: 'starting {date}',
    until: 'until {date}',
    maxRuns: 'at most {n} runs',
    maxRunsOne: 'once only',
    timezone: 'time zone {tz}'
  },
  de: {
    manual: 'Nur bei manuellem Start',
    once: 'Einmalig am {at}',
    every: {
      minutes: ['Minute', 'Minuten'],
      hours: ['Stunde', 'Stunden'],
      days: ['Tag', 'Tage']
    },
    interval: 'Alle {n} {unit}',
    intervalOne: 'Jede {unit}',
    intervalAt: '{base} um {time}',
    daily: 'Jeden Tag um {time}',
    weekdays: 'Jeden Werktag (Montag bis Freitag) um {time}',
    weekly: 'Jeden {days} um {time}',
    monthly: 'Monatlich am {days} um {time}',
    lastDay: 'letzten Tag',
    cron: 'Cron-Zeitplan „{cron}“',
    and: 'und',
    from: 'ab {date}',
    until: 'bis {date}',
    maxRuns: 'höchstens {n} Ausführungen',
    maxRunsOne: 'nur einmal',
    timezone: 'Zeitzone {tz}'
  }
};

function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, key) => (values[key] ?? '').toString());
}

function joinList(items, and) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} ${and} ${items[items.length - 1]}`;
}

function ordinal(n, lang) {
  if (lang === 'de') return `${n}.`;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
}

/**
 * Format an instant for a person, in the schedule's timezone.
 *
 * @param {Date|string|number} instant
 * @param {string} timezone
 * @param {string} [language='en']
 * @returns {string}
 */
export function formatInstant(instant, timezone, language = 'en') {
  const date = instant instanceof Date ? instant : parseInstant(instant);
  if (!date) return String(instant ?? '');
  const locale = language === 'de' ? 'de-DE' : 'en-GB';
  return new Intl.DateTimeFormat(locale, {
    timeZone: isValidTimezone(timezone) ? timezone : 'UTC',
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(date);
}

/**
 * The instant as ISO 8601 with the schedule timezone's offset
 * (`2026-10-01T09:00:00+02:00`) — unambiguous for a model and still readable.
 *
 * @param {Date|string|number} instant
 * @param {string} timezone
 * @returns {string}
 */
export function formatZonedIso(instant, timezone) {
  const date = instant instanceof Date ? instant : parseInstant(instant);
  if (!date) return '';
  const zone = isValidTimezone(timezone) ? timezone : 'UTC';
  const p = zonedParts(date, zone);
  const offsetMinutes = Math.round(
    (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) -
      Math.floor(date.getTime() / 1000) * 1000) /
      60_000
  );
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const offset = `${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${offset}`;
}

/**
 * A sentence describing the schedule ("Every weekday (Monday to Friday) at
 * 08:00, time zone Europe/Berlin").
 *
 * @param {Object} schedule - Normalized schedule.
 * @param {string} [language='en'] - `en` or `de`; anything else falls back to English.
 * @returns {string}
 */
export function describeSchedule(schedule, language = 'en') {
  const lang = language?.toLowerCase().startsWith('de') ? 'de' : 'en';
  const w = WORDS[lang];
  if (!schedule || schedule.type === 'manual') return w.manual;
  const tz = schedule.timezone || 'UTC';
  const locale = lang === 'de' ? 'de-DE' : 'en-GB';
  const weekdayName = index =>
    new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(
      // 2023-01-01 was a Sunday.
      new Date(Date.UTC(2023, 0, 1 + index))
    );
  let base;
  switch (schedule.type) {
    case 'once':
      base = fill(w.once, { at: formatInstant(schedule.at, tz, lang) });
      break;
    case 'interval': {
      const [one, many] = w.every[schedule.unit] || [schedule.unit, schedule.unit];
      base =
        schedule.every === 1
          ? fill(w.intervalOne, { unit: one })
          : fill(w.interval, { n: schedule.every, unit: many });
      if (schedule.unit === 'days' && schedule.time) {
        base = fill(w.intervalAt, { base, time: schedule.time });
      }
      break;
    }
    case 'daily':
      base = fill(w.daily, { time: schedule.time });
      break;
    case 'weekdays':
      base = fill(w.weekdays, { time: schedule.time });
      break;
    case 'weekly':
      base = fill(w.weekly, {
        days: joinList((schedule.days || []).map(weekdayName), w.and),
        time: schedule.time
      });
      break;
    case 'monthly':
      base = fill(w.monthly, {
        days: joinList(
          (schedule.daysOfMonth || []).map(d => (d === 'last' ? w.lastDay : ordinal(d, lang))),
          w.and
        ),
        time: schedule.time
      });
      break;
    case 'cron':
      base = fill(w.cron, { cron: schedule.cron });
      break;
    default:
      base = String(schedule.type);
  }
  const extras = [];
  if (schedule.type !== 'once') {
    if (schedule.startAt)
      extras.push(fill(w.from, { date: formatInstant(schedule.startAt, tz, lang) }));
    if (schedule.endAt)
      extras.push(fill(w.until, { date: formatInstant(schedule.endAt, tz, lang) }));
    if (Number.isInteger(schedule.maxRuns)) {
      extras.push(schedule.maxRuns === 1 ? w.maxRunsOne : fill(w.maxRuns, { n: schedule.maxRuns }));
    }
  }
  extras.push(fill(w.timezone, { tz }));
  return `${base}, ${extras.join(', ')}`;
}

/**
 * A preview of a schedule: what it understood, whether it is valid, a
 * description, and the next runs.
 *
 * @param {Object} input - Schedule as sent.
 * @param {Object} [options]
 * @param {string} [options.timezone] - Default zone.
 * @param {number} [options.minIntervalMinutes]
 * @param {string} [options.language='en']
 * @param {number} [options.count=5]
 * @param {Date|number} [options.now=Date.now()]
 * @param {Object} [options.previous] - Schedule being replaced (keeps an interval's anchor).
 * @param {number} [options.runCount=0]
 * @param {number} [options.staggerMs=0] - Start delay added to every run.
 * @returns {{schedule: Object, valid: boolean, errors: ScheduleError[], description: string,
 *   nextRuns: string[]}}
 */
export function previewSchedule(input, options = {}) {
  const {
    language = 'en',
    count = 5,
    now = Date.now(),
    runCount = 0,
    staggerMs = 0,
    ...rest
  } = options;
  const schedule = normalizeSchedule(input, { ...rest, now });
  const errors = validateSchedule(schedule, { ...rest, now });
  const valid = errors.length === 0;
  return {
    schedule,
    valid,
    errors,
    description: valid ? describeSchedule(schedule, language) : '',
    nextRuns: valid
      ? nextSlots(schedule, { count, after: now, runCount }).map(slot =>
          toIso(new Date(slot.getTime() + staggerMs))
        )
      : []
  };
}
