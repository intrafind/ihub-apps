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
