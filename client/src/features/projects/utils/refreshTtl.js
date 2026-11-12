// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The refresh TTL of project items (#3536), as the dialogs offer it: how long
 * a file downloaded from a website is kept before it is downloaded again,
 * and how long a web page's read is cached. A TTL is a number of seconds or
 * `'never'`; the item's own, else the project's, else the platform's applies
 * (the server sends the result as `item.refresh`).
 *
 * @module features/projects/utils/refreshTtl
 */

/** The value that turns scheduled refreshes off. */
export const REFRESH_NEVER = 'never';

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

/** The TTLs the dialogs offer, shortest first; the server takes 900 s to a year. */
export const REFRESH_TTL_CHOICES = Object.freeze([
  HOUR,
  6 * HOUR,
  DAY,
  7 * DAY,
  30 * DAY,
  REFRESH_NEVER
]);

/** Item kinds that take a refresh TTL. */
export const REFRESH_TTL_KINDS = Object.freeze(['web-file', 'url']);

/**
 * Whether an item has a refresh schedule the user may set.
 *
 * @param {{kind?: string, refresh?: Object}|null|undefined} item
 * @returns {boolean}
 */
export function takesRefreshTtl(item) {
  return Boolean(item?.refresh) || REFRESH_TTL_KINDS.includes(item?.kind);
}

/**
 * A TTL in words ("1 day", "6 hours", "Never").
 *
 * @param {number|'never'|null|undefined} ttl
 * @param {Function} t
 * @returns {string}
 */
export function refreshTtlLabel(ttl, t) {
  if (ttl === REFRESH_NEVER) return t('projects.refresh.never', 'Never (only by hand)');
  const seconds = Number(ttl);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds % DAY === 0) {
    return t('projects.refresh.days', '{{count}} days', { count: seconds / DAY });
  }
  if (seconds % HOUR === 0) {
    return t('projects.refresh.hours', '{{count}} hours', { count: seconds / HOUR });
  }
  return t('projects.refresh.minutes', '{{count}} minutes', { count: Math.round(seconds / 60) });
}

/**
 * The choices of a TTL select, with the current value added when it is not
 * one of the usual ones (set through the API).
 *
 * @param {number|'never'|null|undefined} current
 * @returns {Array<number|'never'>}
 */
export function refreshTtlChoices(current) {
  if (current === null || current === undefined || REFRESH_TTL_CHOICES.includes(current)) {
    return [...REFRESH_TTL_CHOICES];
  }
  const numbers = [...REFRESH_TTL_CHOICES.filter(value => value !== REFRESH_NEVER), current].sort(
    (a, b) => a - b
  );
  return [...numbers, REFRESH_NEVER];
}

/**
 * A select's value back to a TTL: `''` is "inherit" (null).
 *
 * @param {string|null|undefined} value
 * @returns {number|'never'|null}
 */
export function parseRefreshTtl(value) {
  const text = String(value ?? '');
  if (text === '') return null;
  if (text === REFRESH_NEVER) return REFRESH_NEVER;
  const seconds = Number(text);
  return Number.isFinite(seconds) ? seconds : null;
}

/**
 * A date and time in the user's language, or null when it does not parse.
 *
 * @param {string|null|undefined} value
 * @param {string} [language]
 * @returns {string|null}
 */
export function formatRefreshTime(value, language) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(language || undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(date);
  } catch {
    return date.toISOString().replace('T', ' ').slice(0, 16);
  }
}

/**
 * The one line an item's card shows about its schedule: when a downloaded
 * file or a web page's snapshot is refreshed next, or that it is refreshed
 * only by hand.
 *
 * @param {{kind?: string, refresh?: Object}} item
 * @param {Function} t
 * @param {string} [language]
 * @returns {string|null}
 */
export function refreshSummary(item, t, language) {
  const refresh = item?.refresh;
  if (!refresh) return null;
  if (refresh.ttl === REFRESH_NEVER) {
    return t('projects.refresh.manualOnly', 'Refreshed only by hand');
  }
  const next = formatRefreshTime(refresh.nextAt, language);
  return next
    ? t('projects.refresh.nextAt', 'Next refresh {{date}}', { date: next })
    : t('projects.refresh.every', 'Refreshed every {{ttl}}', {
        ttl: refreshTtlLabel(refresh.ttl, t)
      });
}
