/**
 * Formatting and form helpers for scheduled tasks.
 *
 * The server owns the schedule semantics (validation, next runs, the sentence
 * describing it — see `POST /api/scheduled-tasks/_preview`); this module only
 * converts between the form's flat state and the schedule object, and formats
 * times for display.
 */

export const SCHEDULE_TYPES = [
  'manual',
  'once',
  'interval',
  'daily',
  'weekdays',
  'weekly',
  'monthly',
  'cron'
];

export const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Weekdays in display order, Monday first. */
export const WEEKDAYS_MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];

function locale(language) {
  return language?.startsWith('de') ? 'de-DE' : 'en-GB';
}

/**
 * A date-time for display, in the given timezone (the browser's by default).
 *
 * @param {string|number|Date} value
 * @param {string} language
 * @param {Object} [options]
 * @param {string} [options.timeZone]
 * @param {boolean} [options.weekday=false]
 * @returns {string}
 */
export function formatDateTime(value, language, { timeZone, weekday = false } = {}) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale(language), {
      ...(weekday ? { weekday: 'short' } : {}),
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      ...(timeZone ? { timeZone } : {})
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

/**
 * "in 5 minutes" / "3 hours ago".
 *
 * @param {string|number|Date} value
 * @param {string} language
 * @param {number} [now=Date.now()]
 * @returns {string}
 */
export function formatRelative(value, language, now = Date.now()) {
  if (!value) return '';
  const at = new Date(value).getTime();
  if (!Number.isFinite(at)) return '';
  const diff = at - now;
  const abs = Math.abs(diff);
  const units = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000]
  ];
  let rtf;
  try {
    rtf = new Intl.RelativeTimeFormat(locale(language), { numeric: 'auto' });
  } catch {
    return formatDateTime(value, language);
  }
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === 'minute') {
      return rtf.format(Math.round(diff / ms), unit);
    }
  }
  return '';
}

/** A duration in ms as "1 min 20 s". */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

/** Every IANA zone the browser knows, or a short list when it cannot say. */
export function timezoneOptions() {
  try {
    if (typeof Intl.supportedValuesOf === 'function') return Intl.supportedValuesOf('timeZone');
  } catch {
    // fall through
  }
  return ['UTC', 'Europe/Berlin', 'Europe/London', 'America/New_York', 'Asia/Tokyo'];
}

/** The wall-clock parts of an instant in a timezone. */
function zonedParts(date, timeZone) {
  const parts = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return parts;
}

/**
 * An instant as the value of a `datetime-local` input, in a timezone.
 *
 * @param {string|null} iso
 * @param {string} timeZone
 * @returns {string} `YYYY-MM-DDTHH:MM`, or ''.
 */
export function toLocalInput(iso, timeZone) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  try {
    const p = zonedParts(date, timeZone || 'UTC');
    return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
  } catch {
    return '';
  }
}

/**
 * The form state for a schedule.
 *
 * @param {Object|null} schedule
 * @param {string} defaultTimezone
 * @returns {Object}
 */
export function scheduleToForm(schedule, defaultTimezone) {
  const s = schedule || { type: 'daily', time: '08:00' };
  const timezone = s.timezone || defaultTimezone || 'UTC';
  const numbers = (s.daysOfMonth || []).filter(d => d !== 'last');
  return {
    type: s.type || 'daily',
    timezone,
    time: s.time || '08:00',
    days: Array.isArray(s.days) && s.days.length ? s.days : [1],
    daysOfMonth: numbers.length ? numbers : s.daysOfMonth?.includes('last') ? [] : [1],
    lastDay: Array.isArray(s.daysOfMonth) && s.daysOfMonth.includes('last'),
    every: s.every || 1,
    unit: s.unit || 'hours',
    intervalTime: s.unit === 'days' ? s.time || '' : '',
    at: toLocalInput(s.at, timezone),
    cron: s.cron || '',
    startAt: toLocalInput(s.startAt, timezone),
    endAt: toLocalInput(s.endAt, timezone),
    maxRuns: s.maxRuns ?? '',
    anchorAt: s.anchorAt || null
  };
}

/**
 * The schedule object the API takes, from the form state. Local times are
 * sent without an offset; the server reads them in `timezone`.
 *
 * @param {Object} form
 * @returns {Object}
 */
export function formToSchedule(form) {
  const type = form.type || 'manual';
  if (type === 'manual') return { type };
  const out = { type, timezone: form.timezone || 'UTC' };
  switch (type) {
    case 'once':
      out.at = form.at;
      break;
    case 'interval':
      out.every = Number(form.every);
      out.unit = form.unit;
      if (form.unit === 'days' && form.intervalTime) out.time = form.intervalTime;
      if (form.anchorAt) out.anchorAt = form.anchorAt;
      break;
    case 'daily':
    case 'weekdays':
      out.time = form.time;
      break;
    case 'weekly':
      out.time = form.time;
      out.days = form.days;
      break;
    case 'monthly':
      out.time = form.time;
      out.daysOfMonth = [...(form.daysOfMonth || []), ...(form.lastDay ? ['last'] : [])];
      break;
    case 'cron':
      out.cron = form.cron;
      break;
    default:
      break;
  }
  if (type !== 'once') {
    if (form.startAt) out.startAt = form.startAt;
    if (form.endAt) out.endAt = form.endAt;
    if (form.maxRuns !== '' && form.maxRuns !== null && form.maxRuns !== undefined) {
      out.maxRuns = Number(form.maxRuns);
    }
  }
  return out;
}

/** Tailwind classes of a task status. */
export const TASK_STATUS_CLASSES = {
  active: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  paused: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  completed: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  disabled: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
};

/** Tailwind classes of a run status. */
export const RUN_STATUS_CLASSES = {
  queued: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  awaiting_approval: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  succeeded: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  skipped: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  cancelled: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300'
};

/** Whether a run is still going. */
export function isRunActive(status) {
  return status === 'queued' || status === 'running' || status === 'awaiting_approval';
}

/** Where a run's chat opens. */
/**
 * Reason codes the server words the same way every time, so the client can
 * say them in the viewer's language. Anything else — an error's own message,
 * an administrator's note, an integration's reconnect hint — is shown as it
 * came.
 */
const TRANSLATED_REASONS = new Set([
  'ABORTED',
  'APP_NOT_ACCESSIBLE',
  'APP_NOT_AVAILABLE',
  'APPROVAL_REJECTED',
  'APPROVAL_TIMED_OUT',
  'AUTHENTICATION_REQUIRED',
  'AWAITING_APPROVAL',
  'CANCELLED_BY_OWNER',
  'INTERRUPTED',
  'MAX_RUNS',
  'MISSED',
  'MODEL_NOT_ACCESSIBLE',
  'MODEL_NOT_AVAILABLE',
  'NO_FUTURE_RUNS',
  'ONCE',
  'OWNER_DEACTIVATED',
  'OWNER_DELETED',
  'OWNER_LOOKUP_FAILED',
  'OWNER_MISSING',
  'PAUSED_BY_OWNER',
  'PERMISSION_REVOKED',
  'PREVIOUS_RUN_ACTIVE',
  'TASK_DELETED',
  'TASK_NOT_ACTIVE',
  'TOO_MANY_APPROVALS',
  'TOO_MANY_FAILURES',
  'TOOL_NOT_AVAILABLE'
]);

/**
 * A task's or run's reason, in the viewer's language where the code allows.
 *
 * @param {Function} t - i18next `t`.
 * @param {{code?: string, message?: string, missedSlots?: number}|null} reason
 * @returns {string}
 */
export function reasonText(t, reason) {
  if (!reason) return '';
  const fallback = reason.message || '';
  if (!TRANSLATED_REASONS.has(reason.code)) return fallback;
  return t(`scheduledTasks.reasons.${reason.code}`, {
    defaultValue: fallback,
    ...(Number.isFinite(reason.missedSlots) ? { count: reason.missedSlots } : {})
  });
}

export function runChatLink(appId, chatId) {
  return appId && chatId ? `/apps/${appId}/c/${chatId}` : null;
}

/** The API error's message, or a fallback. */
export function errorMessage(error, fallback) {
  return (
    responseData(error)?.error ||
    error?.userFriendlyMessage ||
    error?.message ||
    fallback ||
    'Something went wrong'
  );
}

/** The response body behind an API error (raw axios or `handleApiResponse`'s). */
export function responseData(error) {
  return error?.originalError?.response?.data || error?.response?.data || null;
}

/** The machine-readable code of an API error. */
export function errorCode(error) {
  return error?.code || responseData(error)?.code || null;
}

/** The per-field problems of a 400 from the task API. */
export function fieldErrors(error) {
  const details = responseData(error)?.details || error?.details;
  if (!Array.isArray(details)) return {};
  const out = {};
  for (const entry of details) {
    if (entry?.field && !out[entry.field]) out[entry.field] = entry.message;
  }
  return out;
}
