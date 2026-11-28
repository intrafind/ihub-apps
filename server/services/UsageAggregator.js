// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Usage rollup files: one per UTC day (`usage-daily/YYYY-MM-DD.json`) and
 * one per month (`usage-monthly/YYYY-MM.json`), built from the daily event
 * files (services/usage/rollup.js for the shape).
 *
 * Generation is incremental: a day is rebuilt when it is today or yesterday
 * (late flushes from other workers), when it has no rollup yet, or when its
 * event file changed after its rollup was written. History is not re-read.
 * A month is rebuilt when one of its days was.
 *
 * Runs are serialized ({@link runRollups}): each reads the event files and then
 * replaces whole rollup files, so two overlapping runs could finish in the
 * wrong order and leave the older snapshot in place.
 *
 * @module services/UsageAggregator
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  listEventDays,
  readDayEvents,
  eventFileMtime,
  getDailyDir,
  getMonthlyDir,
  cleanupEvents,
  flushQueue
} from './UsageEventLog.js';
import { buildRollup, mergeRollups, ROLLUP_VERSION } from './usage/rollup.js';
import { cleanupFeedback } from '../feedbackStorage.js';
import logger from '../utils/logger.js';
import { getStorage, readFacet } from '../storage/bootstrap.js';
import { renameWithRetry } from '../utils/atomicWrite.js';

const ROLLUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/** Storage lock that keeps the rollup runs of different workers and instances apart. */
const ROLLUP_LOCK = 'usage-rollups';
/**
 * Lease of one rollup run: renewed while the run lasts (`ttlMs` is how long a
 * crashed holder blocks the next run); a second run queues for up to `waitMs`,
 * long enough for a full `all` rebuild.
 */
const ROLLUP_LOCK_OPTIONS = Object.freeze({ ttlMs: 60_000, waitMs: 10 * 60_000 });
const DAY_MS = 24 * 60 * 60 * 1000;

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

async function mtimeOf(file) {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Thrown when a run finds it no longer holds the rollup lease: it stops publishing. */
class RollupLeaseLostError extends Error {
  constructor() {
    super('The usage rollup run lost its lease to another run; it stops without publishing');
    this.name = 'RollupLeaseLostError';
  }
}

/**
 * Write a file whole or not at all.
 *
 * With a `lease` (the run holds the storage lock), the lease is checked after
 * the content is written and right before the rename that publishes it: a run
 * that was evicted (its event loop wedged past the lease's TTL, so another run
 * took over) must not replace the newer run's rollup with the snapshot it read
 * before. The check and the rename are not one step; the window left is the
 * time between them (see `storage/LockManager.js`, fencing).
 *
 * @param {string} file
 * @param {unknown} data
 * @param {{isCurrent: () => Promise<boolean>}} [lease]
 */
async function writeJsonAtomic(file, data, lease) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  try {
    if (lease && !(await lease.isCurrent())) throw new RollupLeaseLostError();
    await renameWithRetry(tmp, file);
  } catch (error) {
    // A lost lease, a lease that cannot be read, a failed rename: retention
    // only removes `.json` files, so the snapshot would stay behind for good.
    await fs.unlink(tmp).catch(() => {});
    throw error;
  }
}

export function dailyRollupFile(date) {
  return path.join(getDailyDir(), `${date}.json`);
}

export function monthlyRollupFile(month) {
  return path.join(getMonthlyDir(), `${month}.json`);
}

/**
 * Whether a day's stored rollup is current: written after its event file
 * last changed, and of this rollup version.
 * @param {string} date
 * @returns {Promise<boolean>}
 */
export async function isDailyRollupFresh(date) {
  const [rollupAt, eventsAt] = await Promise.all([
    mtimeOf(dailyRollupFile(date)),
    eventFileMtime(date)
  ]);
  if (rollupAt === null) return false;
  return eventsAt === null || rollupAt >= eventsAt;
}

/** Build one day's rollup from its event file (not written). */
export async function buildDayRollup(date) {
  return buildRollup(await readDayEvents(date), { date });
}

/**
 * Rebuild the daily rollups that need it.
 * @param {Object} [opts]
 * @param {number} [opts.now]
 * @param {boolean} [opts.all=false] - rebuild every day that has events
 * @param {Object} [opts.lease] - the rollup lease to check before each write
 * @returns {Promise<{daysGenerated: number, eventsProcessed: number, days: string[]}>}
 */
export async function generateDailyRollups({ now = Date.now(), all = false, lease } = {}) {
  const today = utcDay(now);
  const yesterday = utcDay(now - DAY_MS);
  const days = [];
  let eventsProcessed = 0;
  for (const date of await listEventDays()) {
    const recent = date === today || date === yesterday;
    if (!all && !recent && (await isDailyRollupFresh(date))) continue;
    try {
      const events = await readDayEvents(date);
      eventsProcessed += events.length;
      await writeJsonAtomic(dailyRollupFile(date), buildRollup(events, { date }), lease);
      days.push(date);
    } catch (error) {
      if (error instanceof RollupLeaseLostError) throw error;
      logger.error('Failed to write daily usage rollup', {
        component: 'UsageAggregator',
        date,
        error
      });
    }
  }
  if (days.length) {
    logger.info('Generated daily usage rollups', {
      component: 'UsageAggregator',
      daysGenerated: days.length
    });
  }
  return { daysGenerated: days.length, eventsProcessed, days };
}

/** The `YYYY-MM` of the retention cutoff `retentionDays` before `now`, or '' to keep all. */
function cutoffMonth(retentionDays, now) {
  return Number.isFinite(retentionDays) && retentionDays > 0
    ? new Date(now - retentionDays * DAY_MS).toISOString().slice(0, 7)
    : '';
}

/**
 * Months whose monthly rollup is missing or not newer than one of their daily
 * rollups: a run that stopped between a day and its month (a lost lease, a
 * crash) left them behind, and the next run does not rebuild that day again,
 * because its rollup is now newer than its event file. Equal times count as
 * behind (a filesystem with coarse timestamps); the rebuild then gives the
 * monthly rollup a later time, so a month is rebuilt at most once for that.
 *
 * Left out:
 * - months past the monthly retention, or retention and this would delete and
 *   rebuild them on every run;
 * - months reaching back past the daily retention (the month of its cutoff and
 *   older): some of their days are gone, and rebuilding from the rest would
 *   replace a complete monthly rollup with a partial one.
 *
 * @param {string[]} files - The daily rollup directory's entries
 * @param {Object} opts
 * @param {number} [opts.retentionDays] - platform `monthlyRetentionDays`
 * @param {number} [opts.dailyRetentionDays] - platform `dailyRetentionDays`
 * @param {number} [opts.now]
 * @returns {Promise<string[]>}
 */
async function staleMonths(files, { retentionDays, dailyRetentionDays, now = Date.now() }) {
  const monthlyCutoff = cutoffMonth(retentionDays, now);
  const dailyCutoff = cutoffMonth(dailyRetentionDays, now);
  const daily = files.filter(f => {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) return false;
    const month = f.slice(0, 7);
    return month >= monthlyCutoff && (!dailyCutoff || month > dailyCutoff);
  });
  const times = await Promise.all(daily.map(f => mtimeOf(path.join(getDailyDir(), f))));
  const newestDaily = new Map();
  daily.forEach((file, i) => {
    const month = file.slice(0, 7);
    if (times[i] !== null && times[i] > (newestDaily.get(month) ?? -Infinity)) {
      newestDaily.set(month, times[i]);
    }
  });
  const months = [...newestDaily.keys()];
  const monthlyTimes = await Promise.all(months.map(m => mtimeOf(monthlyRollupFile(m))));
  return months.filter((m, i) => monthlyTimes[i] === null || monthlyTimes[i] <= newestDaily.get(m));
}

/**
 * Rebuild the monthly rollups of the given days' months, and of every month
 * whose monthly rollup is behind its daily rollups ({@link staleMonths}), from
 * their daily rollups.
 * @param {string[]} days
 * @param {Object} [opts]
 * @param {Object} [opts.lease] - the rollup lease to check before each write
 * @param {number} [opts.retentionDays] - platform `monthlyRetentionDays`
 * @param {number} [opts.dailyRetentionDays] - platform `dailyRetentionDays`
 * @param {number} [opts.now]
 * @returns {Promise<{monthsGenerated: number}>}
 */
export async function generateMonthlyRollups(
  days,
  { lease, retentionDays, dailyRetentionDays, now } = {}
) {
  let files = [];
  try {
    files = await fs.readdir(getDailyDir());
  } catch {
    return { monthsGenerated: 0 };
  }
  const months = [
    ...new Set([
      ...days.map(d => d.slice(0, 7)),
      ...(await staleMonths(files, { retentionDays, dailyRetentionDays, now }))
    ])
  ].sort();
  let generated = 0;
  for (const month of months) {
    const rollups = [];
    for (const file of files.filter(f => f.startsWith(month) && f.endsWith('.json')).sort()) {
      const rollup = await readJson(path.join(getDailyDir(), file));
      if (rollup?.v === ROLLUP_VERSION) rollups.push(rollup);
    }
    if (!rollups.length) continue;
    try {
      await writeJsonAtomic(
        monthlyRollupFile(month),
        mergeRollups(rollups, { month, days: rollups.length }),
        lease
      );
      generated++;
    } catch (error) {
      if (error instanceof RollupLeaseLostError) throw error;
      logger.error('Failed to write monthly usage rollup', {
        component: 'UsageAggregator',
        month,
        error
      });
    }
  }
  return { monthsGenerated: generated };
}

/**
 * The stored daily rollup of a day (current rollup version only), or null.
 * @param {string} date
 */
export async function readDailyRollup(date) {
  const rollup = await readJson(dailyRollupFile(date));
  return rollup?.v === ROLLUP_VERSION ? rollup : null;
}

/**
 * The stored monthly rollup of a month, or null.
 * @param {string} month - `YYYY-MM`
 */
export async function readMonthlyRollup(month) {
  const rollup = await readJson(monthlyRollupFile(month));
  return rollup?.v === ROLLUP_VERSION ? rollup : null;
}

/** Days that have a stored daily rollup. */
export async function listDailyRollupDays() {
  try {
    return (await fs.readdir(getDailyDir()))
      .map(f => /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f)?.[1])
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Delete rollup files older than `retentionDays` in a directory. A
 * non-positive value keeps everything.
 */
async function cleanupRollupDir(dir, retentionDays, keyLength, now = Date.now()) {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return [];
  let files;
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const cutoffKey = new Date(now - retentionDays * DAY_MS).toISOString().slice(0, keyLength);
  const deleted = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const key = file.replace('.json', '');
    if (key.length !== keyLength || key >= cutoffKey) continue;
    try {
      await fs.unlink(path.join(dir, file));
      deleted.push(file);
    } catch (err) {
      logger.warn('Failed to delete rollup file', {
        component: 'UsageAggregator',
        file,
        error: err.message
      });
    }
  }
  return deleted;
}

export async function cleanupDailyRollups(retentionDays, now) {
  return cleanupRollupDir(getDailyDir(), retentionDays, 10, now);
}

export async function cleanupMonthlyRollups(retentionDays, now) {
  return cleanupRollupDir(getMonthlyDir(), retentionDays, 7, now);
}

/** The end of the queue of this process's rollup runs. */
let rollupQueue = Promise.resolve();

/**
 * Run `fn` holding the storage lock of rollup runs, where the storage has one
 * that excludes anything, and hand it the lease. Without one (no storage yet,
 * `locking: 'none'`), only the queue of this process orders the runs, and `fn`
 * gets no lease.
 */
function withRollupLock(fn) {
  const provider = getStorage();
  const locks = readFacet(provider, 'locks');
  let locking;
  try {
    locking = provider?.getCapabilities?.()?.locking;
  } catch {
    locking = undefined;
  }
  if (typeof locks?.withLock !== 'function' || locking === 'none') return fn(undefined);
  return locks.withLock(ROLLUP_LOCK, fn, ROLLUP_LOCK_OPTIONS);
}

/**
 * Flush, roll up incrementally, and apply retention.
 *
 * Runs one at a time, in the order they were asked for: the hourly run, the
 * one at startup and an admin's `POST /api/admin/usage/_rollup` queue behind
 * each other in this process, and the storage lock keeps the runs of other
 * workers and instances apart where the storage has a lock. A run that lost
 * its lease (wedged past the TTL, taken over) stops before it publishes
 * another rollup. A run that was asked for while another was
 * going still runs itself afterwards, so it sees the events that arrived in
 * the meantime and honours its own `all`.
 *
 * @param {Object} [retentionConfig] - platform `usageTracking`
 * @param {Object} [opts] - `{ now, all }`
 * @returns {Promise<Object>} the run's counts
 */
export function runRollups(retentionConfig = {}, opts = {}) {
  const run = rollupQueue.then(() =>
    withRollupLock(lease => rollUp(retentionConfig, { ...opts, lease }))
  );
  // A failed run must not stop the ones queued behind it.
  rollupQueue = run.catch(() => {});
  return run;
}

/** One rollup run; always called through {@link runRollups}. */
async function rollUp(retentionConfig, opts) {
  const eventsFlushed = (await flushQueue().catch(() => 0)) || 0;
  const { daysGenerated, eventsProcessed, days } = await generateDailyRollups(opts);
  const { monthsGenerated } = await generateMonthlyRollups(days, {
    lease: opts.lease,
    retentionDays: retentionConfig.monthlyRetentionDays,
    dailyRetentionDays: retentionConfig.dailyRetentionDays,
    now: opts.now
  });
  let eventsDeleted = 0;
  if (retentionConfig.eventRetentionDays != null) {
    eventsDeleted = await cleanupEvents(retentionConfig.eventRetentionDays, opts.now);
  }
  const dailyDeleted =
    retentionConfig.dailyRetentionDays != null
      ? await cleanupDailyRollups(retentionConfig.dailyRetentionDays, opts.now)
      : [];
  const monthlyDeleted =
    retentionConfig.monthlyRetentionDays != null
      ? await cleanupMonthlyRollups(retentionConfig.monthlyRetentionDays, opts.now)
      : [];
  let feedbackRemoved = 0;
  if (retentionConfig.feedbackRetentionDays != null) {
    try {
      feedbackRemoved =
        (await cleanupFeedback(retentionConfig.feedbackRetentionDays))?.removed || 0;
    } catch (err) {
      logger.warn('Feedback cleanup failed', { component: 'UsageAggregator', error: err.message });
    }
  }
  return {
    eventsFlushed,
    eventsProcessed,
    daysGenerated,
    monthsGenerated,
    eventsDeleted,
    dailyDeleted: dailyDeleted.length,
    monthlyDeleted: monthlyDeleted.length,
    feedbackRemoved
  };
}

let rollupInterval = null;

/**
 * Roll up now and every hour. Retention is read from `getRetention()` on
 * every run, so a changed setting applies without a restart.
 * @param {() => Object} getRetention
 */
export function startRollupScheduler(getRetention = () => ({})) {
  if (rollupInterval) return;
  const run = label =>
    runRollups(getRetention() || {}).catch(e =>
      logger.error(`${label} rollup failed`, { component: 'UsageAggregator', error: e })
    );
  void run('Initial');
  rollupInterval = setInterval(() => void run('Scheduled'), ROLLUP_INTERVAL_MS);
  rollupInterval.unref?.();
}

export function stopRollupScheduler() {
  if (rollupInterval) clearInterval(rollupInterval);
  rollupInterval = null;
}
