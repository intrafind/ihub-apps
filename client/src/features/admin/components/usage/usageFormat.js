// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/** Formatting for the admin usage reports. All numbers go through Intl. */

export function formatNumber(value, language) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat(language).format(value);
}

/** 1.2K, 3.4M — for chart axes and tight cells. */
export function formatCompact(value, language) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat(language, { notation: 'compact', maximumFractionDigits: 1 }).format(
    value
  );
}

export function formatPercent(ratio, language, digits = 1) {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return '—';
  return new Intl.NumberFormat(language, {
    style: 'percent',
    maximumFractionDigits: digits
  }).format(ratio);
}

/** 850 ms, 1.2 s, 2.5 min. */
export function formatDuration(ms, language) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) {
    return new Intl.NumberFormat(language, { style: 'unit', unit: 'millisecond' }).format(
      Math.round(ms)
    );
  }
  if (ms < 120000) {
    return new Intl.NumberFormat(language, {
      style: 'unit',
      unit: 'second',
      maximumFractionDigits: 1
    }).format(ms / 1000);
  }
  return new Intl.NumberFormat(language, {
    style: 'unit',
    unit: 'minute',
    maximumFractionDigits: 1
  }).format(ms / 60000);
}

/** "5 minutes ago", "yesterday". */
export function formatRelative(iso, language, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const seconds = Math.round((t - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(seconds, 'second');
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour');
  if (abs < 86400 * 45) return rtf.format(Math.round(seconds / 86400), 'day');
  return new Date(t).toLocaleDateString(language);
}

/** Absolute timestamp for tooltips and the request log. */
export function formatDateTime(iso, language) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleString(language, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

/**
 * Label of a series point: an hour (ISO timestamp, shown in local time) or a
 * UTC day (`YYYY-MM-DD`).
 */
export function formatBucket(t, granularity, language) {
  if (granularity === 'hour') {
    return new Date(t).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
  }
  return new Date(`${t}T00:00:00Z`).toLocaleDateString(language, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC'
  });
}

/**
 * Change against the previous period: `{ ratio, direction }`, or null when
 * there is nothing to compare against.
 */
export function changeOf(current, previous) {
  if (current === null || current === undefined || previous === null || previous === undefined) {
    return null;
  }
  if (previous === 0) return current === 0 ? { ratio: 0, direction: 'flat' } : null;
  const ratio = (current - previous) / previous;
  return { ratio, direction: ratio > 0.0005 ? 'up' : ratio < -0.0005 ? 'down' : 'flat' };
}

/** Rows to CSV text (fields quoted when needed). */
export function toCsv(headers, rows) {
  const cell = value => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\n\r]/.test(text) || /^[=+\-@]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers, ...rows].map(row => row.map(cell).join(',')).join('\n');
}

/** Save text as a file. */
export function downloadText(text, filename, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
