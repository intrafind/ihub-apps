/**
 * Recency buckets for the chat history.
 *
 * `GET /api/chats` returns the stored chat documents and nothing else, so the
 * "Today / Yesterday / Last 7 days / Older" headings the history page shows are
 * derived here from each chat's `lastMessageAt`.
 *
 * Buckets are **calendar days in the viewer's local time**, not rolling 24-hour
 * windows: a chat from 23:50 last night is "Yesterday" at 00:10, which is what
 * a reader means by the word. `now` is injected so the boundaries are testable
 * and so a list rendered from one clock reading cannot split across two.
 */

/** Bucket ids, oldest-last. Labels come from i18n (`chatHistory.group.*`). */
export const CHAT_GROUPS = ['today', 'yesterday', 'last7days', 'older'];

/** Days covered by the `last7days` bucket, counting today as the first. */
const RECENT_WINDOW_DAYS = 7;

/**
 * Coerce whatever a caller has — an ISO string from the API, a `Date`, epoch
 * milliseconds — into a `Date`, or null when it is not a usable instant.
 *
 * @param {string|number|Date|null|undefined} value - Candidate timestamp.
 * @returns {Date|null}
 */
function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
  if (typeof value === 'string' && value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** Local midnight opening the day `date` falls in. */
function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Whole calendar days from `date` to `reference`, in local time. Rounded, so a
 * 23- or 25-hour day across a DST change still counts as one day.
 *
 * @param {Date} date - The earlier instant.
 * @param {Date} reference - The instant to measure against.
 * @returns {number} Positive when `date` is in the past.
 */
function localDaysBetween(date, reference) {
  const millisPerDay = 24 * 60 * 60 * 1000;
  return Math.round((startOfLocalDay(reference) - startOfLocalDay(date)) / millisPerDay);
}

/**
 * The bucket one timestamp falls in.
 *
 * A timestamp in the future — a clock skew between server and browser — reads
 * as "today" rather than inventing a bucket for it. A missing or unparseable
 * one reads as "older", which sorts it last instead of pushing it to the top of
 * the list.
 *
 * @param {string|number|Date|null|undefined} timestamp - Usually `chat.lastMessageAt`.
 * @param {Date|number|string} [now] - Injectable clock.
 * @returns {'today'|'yesterday'|'last7days'|'older'}
 */
export function chatRecencyGroup(timestamp, now = new Date()) {
  const date = toDate(timestamp);
  if (!date) return 'older';
  const reference = toDate(now) || new Date();
  const days = localDaysBetween(date, reference);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < RECENT_WINDOW_DAYS) return 'last7days';
  return 'older';
}
