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

const ROLLUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
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

/** Write a file whole or not at all. */
async function writeJsonAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, file);
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
 * @returns {Promise<{daysGenerated: number, eventsProcessed: number, days: string[]}>}
 */
export async function generateDailyRollups({ now = Date.now(), all = false } = {}) {
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
      await writeJsonAtomic(dailyRollupFile(date), buildRollup(events, { date }));
      days.push(date);
    } catch (error) {
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

/**
 * Rebuild the monthly rollups of the given days' months from their daily
 * rollups.
 * @param {string[]} days
 * @returns {Promise<{monthsGenerated: number}>}
 */
export async function generateMonthlyRollups(days) {
  const months = [...new Set(days.map(d => d.slice(0, 7)))];
  let files = [];
  try {
    files = await fs.readdir(getDailyDir());
  } catch {
    return { monthsGenerated: 0 };
  }
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
        mergeRollups(rollups, { month, days: rollups.length })
      );
      generated++;
    } catch (error) {
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

/**
 * Flush, roll up incrementally, and apply retention.
 * @param {Object} [retentionConfig] - platform `usageTracking`
 * @param {Object} [opts] - `{ now, all }`
 */
export async function runRollups(retentionConfig = {}, opts = {}) {
  const eventsFlushed = (await flushQueue().catch(() => 0)) || 0;
  const { daysGenerated, eventsProcessed, days } = await generateDailyRollups(opts);
  const { monthsGenerated } = await generateMonthlyRollups(days);
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
