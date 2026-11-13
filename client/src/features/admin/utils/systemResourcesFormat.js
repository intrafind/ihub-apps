// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Formatting helpers for the admin System resources page and the Overview's
 * disk-space row.
 */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/**
 * Bytes as a short human-readable string (1024-based, like `df -h`).
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

/**
 * Seconds as a compact uptime such as "3d 4h", "2h 5m" or "45s".
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatUptime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.floor(seconds)}s`;
}

/**
 * A percentage with at most one decimal, or an em dash when unknown.
 *
 * @param {number|null} value
 * @returns {string}
 */
export function formatPercent(value) {
  if (!Number.isFinite(value)) return '—';
  return `${Math.round(value * 10) / 10}%`;
}

/** Heap bytes one indexed character costs (server `utils/cacheBudgets.js` assumes the same). */
export const INDEX_BYTES_PER_CHAR = 4.5;

/**
 * A count with thousands separators, or an em dash when unknown.
 *
 * @param {number|null} value
 * @returns {string}
 */
export function formatCount(value) {
  if (!Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString();
}

/**
 * Memory a search index over `chars` characters of text needs.
 *
 * @param {number} chars
 * @returns {number|null}
 */
export function estimateIndexBytes(chars) {
  return Number.isFinite(chars) ? chars * INDEX_BYTES_PER_CHAR : null;
}

/**
 * Index-cache hit rate (0-1) as a percentage, or an em dash before any lookup.
 *
 * @param {number|null} hitRate
 * @returns {string}
 */
export function formatHitRate(hitRate) {
  return Number.isFinite(hitRate) ? formatPercent(hitRate * 100) : '—';
}

/**
 * The index-cache capacity (characters) of one worker: the largest any process
 * reports, since every worker has its own cache of the same size.
 *
 * @param {Array<{indexCache?: {maxChars?: number}}>} processes
 * @returns {number}
 */
export function indexCacheCapacityChars(processes = []) {
  return processes.reduce((max, proc) => Math.max(max, proc?.indexCache?.maxChars || 0), 0);
}

/** Tailwind classes per storage status, shared by the page and the Overview. */
export const STORAGE_STATUS_STYLES = {
  ok: {
    bar: 'bg-green-500',
    text: 'text-green-700 dark:text-green-400',
    badge: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
  },
  warning: {
    bar: 'bg-amber-500',
    text: 'text-amber-700 dark:text-amber-400',
    badge: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
  },
  critical: {
    bar: 'bg-red-600',
    text: 'text-red-700 dark:text-red-400',
    badge: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
  }
};
