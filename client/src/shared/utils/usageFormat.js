// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Formatting for usage limits: token counts, the time left until a reset and
 * the reset moment itself ("Resets today at 00:00 · in 3 h 12 min").
 */

/** 1234 → "1,234"; 12_345 → "12.3k"; 3_400_000 → "3.4M". */
export function formatTokens(value, language = 'en') {
  const n = Number(value) || 0;
  if (Math.abs(n) < 10000) return n.toLocaleString(language);
  try {
    return new Intl.NumberFormat(language, {
      notation: 'compact',
      maximumFractionDigits: 1
    }).format(n);
  } catch {
    return n.toLocaleString(language);
  }
}

/**
 * Time from `now` until `iso` as "2 d 4 h", "3 h 12 min" or "5 min".
 *
 * @param {string} iso
 * @param {Function} t - i18next `t`
 * @param {number} [now]
 */
export function formatTimeUntil(iso, t, now = Date.now()) {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms <= 0) return t('usage.reset.now', 'now');
  const minutes = Math.ceil(ms / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) {
    return hours > 0
      ? t('usage.reset.daysHours', '{{days}} d {{hours}} h', { days, hours })
      : t('usage.reset.days', '{{days}} d', { days });
  }
  if (hours > 0) {
    return mins > 0
      ? t('usage.reset.hoursMinutes', '{{hours}} h {{minutes}} min', { hours, minutes: mins })
      : t('usage.reset.hours', '{{hours}} h', { hours });
  }
  return t('usage.reset.minutes', '{{minutes}} min', { minutes: mins });
}

function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * The reset moment in the viewer's time: "today at 00:00", "tomorrow at 06:00",
 * "Monday at 00:00" (within a week) or "1 Dec at 00:00".
 *
 * @param {string} iso
 * @param {Function} t
 * @param {string} [language]
 * @param {number} [now]
 */
export function formatResetMoment(iso, t, language = 'en', now = Date.now()) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date(now);
  const tomorrow = new Date(now + 24 * 60 * 60 * 1000);
  const time = date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
  if (sameDay(date, today)) return t('usage.reset.todayAt', 'today at {{time}}', { time });
  if (sameDay(date, tomorrow)) return t('usage.reset.tomorrowAt', 'tomorrow at {{time}}', { time });
  const day =
    date.getTime() - now < 7 * 24 * 60 * 60 * 1000
      ? date.toLocaleDateString(language, { weekday: 'long' })
      : date.toLocaleDateString(language, { day: 'numeric', month: 'short' });
  return t('usage.reset.dayAt', '{{day}} at {{time}}', { day, time });
}

/** "Resets today at 00:00 (in 3 h 12 min)". */
export function formatReset(iso, t, language = 'en', now = Date.now()) {
  return t('usage.reset.full', 'Resets {{moment}} (in {{until}})', {
    moment: formatResetMoment(iso, t, language, now),
    until: formatTimeUntil(iso, t, now)
  });
}

/** "Daily", "Weekly", "Monthly". */
export function windowLabel(window, t) {
  if (window === 'day') return t('usage.window.day', 'Daily');
  if (window === 'week') return t('usage.window.week', 'Weekly');
  return t('usage.window.month', 'Monthly');
}

/**
 * Where a limit comes from, for "limited by …": the model, the platform, a
 * group or the user's own limit.
 */
export function sourceLabel(source, t) {
  if (!source) return '';
  if (source === 'model') return t('usage.source.model', 'set for this model');
  if (source === 'platform') return t('usage.source.platform', 'set for everyone');
  if (source === 'user') return t('usage.source.user', 'your personal limit');
  if (source.startsWith('group:')) {
    return t('usage.source.group', 'set for group {{group}}', { group: source.slice(6) });
  }
  return source;
}

/** A localized model name (`{ en, de }` or a string). */
export function localizedName(name, language = 'en', fallback = '') {
  if (!name) return fallback;
  if (typeof name === 'string') return name;
  return name[language] || name[language?.split('-')[0]] || name.en || Object.values(name)[0];
}
