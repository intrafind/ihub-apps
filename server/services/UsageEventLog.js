// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The usage event log: one JSONL file per UTC day,
 * `contents/data/usage-events/YYYY-MM-DD.jsonl`, holding schema-v2 records
 * (services/usage/callRecord.js).
 *
 * Every worker appends to the file of the record's day (O_APPEND, so
 * concurrent appends from several processes do not interleave). Retention
 * deletes whole day files — nothing is ever rewritten, so there is no
 * read-modify-write to race with another worker.
 *
 * @module services/UsageEventLog
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import logger from '../utils/logger.js';
import { createJsonlAppender } from '../utils/jsonlAppender.js';
import { getContentsPath } from '../utils/contentsPath.js';
import { USAGE_SCHEMA_VERSION } from './usage/callRecord.js';

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Directory of the daily event files. */
export function getEventsDir() {
  return getContentsPath('data', 'usage-events');
}

/** Directory of the daily rollups. */
export function getDailyDir() {
  return getContentsPath('data', 'usage-daily');
}

/** Directory of the monthly rollups. */
export function getMonthlyDir() {
  return getContentsPath('data', 'usage-monthly');
}

/** Path of one day's event file. */
export function eventFileFor(date) {
  if (!DATE.test(date)) throw new Error(`Invalid usage event date: ${date}`);
  return path.join(getEventsDir(), `${date}.jsonl`);
}

/** The UTC day (`YYYY-MM-DD`) of an ISO timestamp, or today. */
export function dayOf(ts) {
  return typeof ts === 'string' && DATE.test(ts.slice(0, 10))
    ? ts.slice(0, 10)
    : new Date().toISOString().slice(0, 10);
}

const appender = createJsonlAppender({
  getFilePath: entry => eventFileFor(dayOf(entry.ts)),
  component: 'UsageEventLog'
});

/** Write everything still buffered to disk. */
export async function flushQueue() {
  return appender.flush();
}

/**
 * Append a usage record (schema v2). Buffered and flushed every few seconds.
 * @param {Object} record
 */
export function appendUsageRecord(record) {
  if (!record || typeof record !== 'object') return;
  appender.append(record);
}

/**
 * Days that have an event file, oldest first.
 * @returns {Promise<string[]>}
 */
export async function listEventDays() {
  let files;
  try {
    files = await fs.readdir(getEventsDir());
  } catch {
    return [];
  }
  return files
    .map(f => DAY_FILE.exec(f)?.[1])
    .filter(Boolean)
    .sort();
}

/**
 * Last modification of a day's event file (ms), or null when there is none.
 * @param {string} date
 */
export async function eventFileMtime(date) {
  try {
    return (await fs.stat(eventFileFor(date))).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The records of one day, in the order they were written. Lines that do not
 * parse (a torn write) and records of another schema version are skipped.
 * @param {string} date - `YYYY-MM-DD`
 * @returns {Promise<Object[]>}
 */
export async function readDayEvents(date) {
  let content;
  try {
    content = await fs.readFile(eventFileFor(date), 'utf8');
  } catch {
    return [];
  }
  const events = [];
  for (const line of content.split('\n')) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event?.v === USAGE_SCHEMA_VERSION && typeof event.ts === 'string') events.push(event);
    } catch {
      /* torn line */
    }
  }
  return events;
}

/**
 * Records of a range of days (inclusive), oldest day first.
 * @param {{startDate?: string, endDate?: string}} [range]
 * @returns {Promise<Object[]>}
 */
export async function readEvents({ startDate, endDate } = {}) {
  const days = (await listEventDays()).filter(
    d => (!startDate || d >= startDate) && (!endDate || d <= endDate)
  );
  const out = [];
  for (const day of days) out.push(...(await readDayEvents(day)));
  return out;
}

/**
 * Delete event files older than `retentionDays` days. A negative value keeps
 * everything.
 * @param {number} retentionDays
 * @param {number} [now]
 * @returns {Promise<number>} files deleted
 */
export async function cleanupEvents(retentionDays = 90, now = Date.now()) {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) return 0;
  const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let removed = 0;
  for (const day of await listEventDays()) {
    if (day >= cutoff) break;
    try {
      await fs.unlink(eventFileFor(day));
      removed++;
    } catch (error) {
      logger.warn('Failed to delete usage event file', {
        component: 'UsageEventLog',
        day,
        error: error.message
      });
    }
  }
  if (removed > 0) {
    logger.info('Usage event cleanup completed', { component: 'UsageEventLog', removed });
  }
  return removed;
}
