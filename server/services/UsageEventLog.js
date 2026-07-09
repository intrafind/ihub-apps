import fs from 'fs/promises';
import path from 'path';
import { getRootDir } from '../pathUtils.js';
import config from '../config.js';
import logger from '../utils/logger.js';

const contentsDir = config.CONTENTS_DIR;
const dataDir = path.join(getRootDir(), contentsDir, 'data');
const eventFile = path.join(dataDir, 'usage-events.jsonl');
const FLUSH_INTERVAL_MS = 10000;

let queue = [];
let flushTimer = null;

// Single-flight serialization for any operation that touches `usage-events.jsonl`.
// `flushQueue` (appendFile) and `cleanupEvents` (read + writeFile) must not
// interleave, otherwise a flush that lands between the cleanup's read and its
// rewrite would be overwritten — silently losing the just-appended entries.
let writeLock = Promise.resolve();
function withWriteLock(fn) {
  const prev = writeLock;
  let release;
  writeLock = new Promise(r => {
    release = r;
  });
  return prev.then(fn).finally(release);
}

async function appendQueueToDisk() {
  if (queue.length === 0) return 0;
  await fs.mkdir(path.dirname(eventFile), { recursive: true });
  const pending = queue;
  queue = [];
  const count = pending.length;
  const lines = pending.map(entry => JSON.stringify(entry)).join('\n') + '\n';
  try {
    await fs.appendFile(eventFile, lines, 'utf8');
  } catch (err) {
    // Re-buffer on failure so the next flush retries instead of dropping events.
    queue = pending.concat(queue);
    throw err;
  }
  return count;
}

export async function flushQueue() {
  return withWriteLock(appendQueueToDisk);
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    try {
      await flushQueue();
    } catch (error) {
      logger.error('Failed to flush usage events', { component: 'UsageEventLog', error });
    }
  }, FLUSH_INTERVAL_MS);
}

/**
 * Log a usage event to the JSONL append-only file.
 * Events are buffered and flushed every 10 seconds.
 */
export function logUsageEvent({
  type,
  userId,
  appId,
  modelId,
  promptTokens = 0,
  completionTokens = 0,
  tokenSource = 'estimate',
  conversationId = null,
  rating = null,
  metadata = null
}) {
  const entry = {
    ts: new Date().toISOString(),
    type,
    uid: userId,
    app: appId,
    model: modelId,
    pt: promptTokens,
    ct: completionTokens,
    src: tokenSource
  };
  if (conversationId) entry.cid = conversationId;
  if (rating != null) entry.rating = rating;
  if (metadata) entry.meta = metadata;
  queue.push(entry);
  scheduleFlush();
}

/**
 * Read all events from the JSONL file, optionally filtered by date range.
 */
export async function readEvents({ startDate, endDate } = {}) {
  try {
    const content = await fs.readFile(eventFile, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    let events = lines
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    if (startDate) {
      const start = new Date(startDate).toISOString();
      events = events.filter(e => e.ts >= start);
    }
    if (endDate) {
      // If endDate is a date-only string (YYYY-MM-DD), include the entire day
      if (/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
        const nextDay = new Date(endDate);
        nextDay.setDate(nextDay.getDate() + 1);
        const end = nextDay.toISOString();
        events = events.filter(e => e.ts < end);
      } else {
        const end = new Date(endDate).toISOString();
        events = events.filter(e => e.ts <= end);
      }
    }
    return events;
  } catch {
    return [];
  }
}

/**
 * Get the path to daily rollup files.
 */
export function getDailyDir() {
  return path.join(dataDir, 'usage-daily');
}

/**
 * Get the path to monthly rollup files.
 */
export function getMonthlyDir() {
  return path.join(dataDir, 'usage-monthly');
}

/**
 * Clean up old event data based on retention policy.
 */
export async function cleanupEvents(retentionDays = 90) {
  if (retentionDays < 0) return; // -1 means keep forever
  try {
    await withWriteLock(async () => {
      // Drain any queued events into the on-disk file first so they're
      // included in the read-filter pass below. Done under the lock so a
      // new scheduleFlush() can't slip in between drain and rewrite.
      try {
        await appendQueueToDisk();
      } catch {
        // A drain failure is logged elsewhere; continue with what's on disk.
      }

      const events = await readEvents();
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - retentionDays);
      const cutoffStr = cutoff.toISOString();
      const retained = events.filter(e => e.ts >= cutoffStr);
      if (retained.length < events.length) {
        const lines =
          retained.map(e => JSON.stringify(e)).join('\n') + (retained.length ? '\n' : '');
        await fs.writeFile(eventFile, lines, 'utf8');
        logger.info('Usage event cleanup completed', {
          component: 'UsageEventLog',
          removed: events.length - retained.length
        });
      }
    });
  } catch (error) {
    logger.error('Failed to cleanup usage events', { component: 'UsageEventLog', error });
  }
}

// Periodic flush
setInterval(() => {
  if (queue.length > 0) {
    flushQueue().catch(error =>
      logger.error('Usage event flush error', { component: 'UsageEventLog', error })
    );
  }
}, FLUSH_INTERVAL_MS);
