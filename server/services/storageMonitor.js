/**
 * Background disk-space check that writes to the server log.
 *
 * The admin UI only helps when somebody opens it. On a small installation that
 * may be nobody for weeks, while the operator does look at `docker logs` or a
 * log shipper when something breaks. So the process that owns the cluster's
 * singletons checks the volumes iHub writes to at a fixed interval and logs:
 *
 *  - `warn` when a volume reaches the warning threshold,
 *  - `error` when it reaches the critical threshold,
 *  - `info` when it drops back below the warning threshold,
 *  - the same `warn` / `error` again every `reminderMs` while it stays there,
 *    so a rotated log or a freshly attached viewer still shows the problem.
 *
 * Nothing is logged while a volume is fine, and a status that has not changed
 * is not repeated before the reminder is due, so a full disk costs one log line
 * per hour rather than one per check.
 */

import logger from '../utils/logger.js';
import { STORAGE_THRESHOLDS } from './systemResources.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_REMINDER_MS = 60 * 60 * 1000;

const LOG_LEVEL = { warning: 'warn', critical: 'error', ok: 'info' };

const PATH_LABELS = {
  contents: 'contents',
  data: 'data',
  uploads: 'uploads',
  logs: 'logs',
  temp: 'temp'
};

let monitorTimer = null;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 || value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** Stable identity of a volume across checks: the first directory on it. */
function volumeKey(volume) {
  return volume.paths?.[0]?.path;
}

/**
 * Compare a storage snapshot with the previous check and decide what to log.
 * Pure, so the rules can be tested without timers or a real disk.
 *
 * @param {Map<string, {status: string, loggedAt: number}>} previous - State
 *   from the last check, keyed by volume.
 * @param {{volumes: Array}} storage - Result of `getStorageSnapshot`.
 * @param {object} [options]
 * @param {number} [options.now=Date.now()]
 * @param {number} [options.reminderMs]
 * @returns {{next: Map, events: Array<{kind: 'entered'|'reminder'|'recovered', status: string, previousStatus: string|null, volume: object}>}}
 */
export function evaluateStorageAlerts(
  previous,
  storage,
  { now = Date.now(), reminderMs = DEFAULT_REMINDER_MS } = {}
) {
  const next = new Map();
  const events = [];

  for (const volume of storage?.volumes || []) {
    const key = volumeKey(volume);
    if (!key) continue;
    const before = previous.get(key);
    const previousStatus = before?.status ?? null;
    const { status } = volume;

    if (status === 'ok') {
      if (previousStatus && previousStatus !== 'ok') {
        events.push({ kind: 'recovered', status, previousStatus, volume });
      }
      next.set(key, { status, loggedAt: now });
      continue;
    }

    if (previousStatus !== status) {
      events.push({ kind: 'entered', status, previousStatus, volume });
      next.set(key, { status, loggedAt: now });
    } else if (now - before.loggedAt >= reminderMs) {
      events.push({ kind: 'reminder', status, previousStatus, volume });
      next.set(key, { status, loggedAt: now });
    } else {
      next.set(key, before);
    }
  }

  // Volumes that vanished (a directory deleted, a mount gone) are forgotten
  // silently: there is nothing left to warn about on them.
  return { next, events };
}

/**
 * The log entry for one event: a readable message for text logs plus the
 * numbers as fields for JSON logs and log shippers.
 */
export function describeStorageEvent(event, thresholds = STORAGE_THRESHOLDS) {
  const { volume, status, kind } = event;
  const where = volume.paths.map(p => PATH_LABELS[p.key] || p.key).join(', ');
  const amount = `${formatBytes(volume.available)} free of ${formatBytes(volume.total)} (${volume.usedPercent}% used)`;

  let message;
  if (kind === 'recovered') {
    message = `Disk space back to normal on the volume holding ${where}: ${amount}`;
  } else if (status === 'critical') {
    message = `Disk space critically low on the volume holding ${where}: ${amount}. Free up space or enlarge the volume; saving chats, uploads and configuration will start to fail.`;
  } else {
    message = `Disk space running low on the volume holding ${where}: ${amount}`;
  }
  if (kind === 'reminder') message += ' (still)';

  return {
    level: LOG_LEVEL[status] || 'warn',
    entry: {
      component: 'StorageMonitor',
      message,
      event: kind,
      status,
      previousStatus: event.previousStatus,
      usedPercent: volume.usedPercent,
      availableBytes: volume.available,
      totalBytes: volume.total,
      paths: volume.paths.map(p => p.path),
      warningPercent: thresholds.warningPercent,
      criticalPercent: thresholds.criticalPercent
    }
  };
}

/**
 * A monitor whose `check()` reads a snapshot, logs what changed and remembers
 * the result. Separate from the timer so tests can drive it directly.
 *
 * @param {object} options
 * @param {() => Promise<{volumes: Array, thresholds?: object}>} options.getSnapshot
 * @param {(level: string, entry: object) => void} [options.log]
 * @param {number} [options.reminderMs]
 * @param {() => number} [options.now]
 */
export function createStorageMonitor({
  getSnapshot,
  log = (level, entry) => logger[level](entry),
  reminderMs = DEFAULT_REMINDER_MS,
  now = () => Date.now()
}) {
  let state = new Map();

  return {
    async check() {
      let storage;
      try {
        storage = await getSnapshot();
      } catch (error) {
        logger.debug({
          component: 'StorageMonitor',
          message: 'Disk space check failed',
          error: error?.message || String(error)
        });
        return [];
      }
      const { next, events } = evaluateStorageAlerts(state, storage, {
        now: now(),
        reminderMs
      });
      state = next;
      for (const event of events) {
        const { level, entry } = describeStorageEvent(event, storage.thresholds);
        log(level, entry);
      }
      return events;
    }
  };
}

/**
 * Check now and then every `intervalMs`. Run it in one process per cluster
 * (the one owning the cluster singletons), or every worker logs the same line.
 * Idempotent; the timer is unref'd.
 *
 * @param {object} options - As `createStorageMonitor`, plus `intervalMs`.
 */
export function startStorageMonitor({ intervalMs = DEFAULT_INTERVAL_MS, ...options }) {
  if (monitorTimer) return;
  const monitor = createStorageMonitor(options);
  // check() handles a failed snapshot itself; this covers anything after it, so a
  // monitoring hiccup is logged instead of surfacing as an unhandled rejection.
  const runCheck = () =>
    monitor.check().catch(error => {
      logger.warn({
        component: 'StorageMonitor',
        message: 'Storage check failed',
        error: error?.message || String(error)
      });
    });
  void runCheck();
  monitorTimer = setInterval(() => void runCheck(), intervalMs);
  monitorTimer.unref?.();
}

/** Test seam. */
export function stopStorageMonitorForTests() {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
}
