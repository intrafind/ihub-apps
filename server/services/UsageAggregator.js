import fs from 'fs/promises';
import path from 'path';
import {
  readEvents,
  getDailyDir,
  getMonthlyDir,
  cleanupEvents,
  flushQueue
} from './UsageEventLog.js';
import { cleanupFeedback } from '../feedbackStorage.js';
import logger from '../utils/logger.js';

const ROLLUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Optional counters rolled up next to prompt/completion tokens: rollup field
 * → usage-event key. Prompt-cache read/write tokens are subsets of
 * `promptTokens`, reasoning tokens a subset of `completionTokens`. Events
 * written before these were tracked simply contribute zero.
 */
export const ROLLUP_COUNTERS = Object.freeze({
  cacheReadTokens: 'cr',
  cacheWriteTokens: 'cw',
  reasoningTokens: 'rt',
  webSearchRequests: 'ws'
});

/** Per-dimension entry: messages, prompt/completion tokens and the optional counters. */
function emptyDimension() {
  const entry = { messages: 0, promptTokens: 0, completionTokens: 0 };
  for (const field of Object.keys(ROLLUP_COUNTERS)) entry[field] = 0;
  return entry;
}

/** Add one dimension entry (daily rollup or event-derived) into another. */
function addDimension(target, source) {
  target.messages += source.messages || 0;
  target.promptTokens += source.promptTokens || 0;
  target.completionTokens += source.completionTokens || 0;
  for (const field of Object.keys(ROLLUP_COUNTERS)) {
    target[field] = (target[field] || 0) + (source[field] || 0);
  }
}

/**
 * Sum one dimension (`byUser`, `byApp`, `byModel`, `byProvider`) across a set
 * of rollups. With `countDays`, each entry also gets the number of rollups it
 * appeared in.
 * @param {Object[]} rollups - daily or monthly rollups
 * @param {string} dim
 * @param {{countDays?: boolean}} [options]
 * @returns {Object<string, Object>}
 */
export function sumRollupDimension(rollups, dim, { countDays = false } = {}) {
  const out = {};
  for (const rollup of rollups) {
    for (const [key, val] of Object.entries(rollup?.[dim] || {})) {
      if (!out[key]) out[key] = countDays ? { ...emptyDimension(), days: 0 } : emptyDimension();
      addDimension(out[key], val);
      if (countDays) out[key].days += 1;
    }
  }
  return out;
}

/**
 * Build a daily rollup from events for a given date string (YYYY-MM-DD).
 */
function buildDailyRollup(events, date) {
  const rollup = {
    date,
    totals: {
      messages: 0,
      promptTokens: 0,
      completionTokens: 0,
      ...Object.fromEntries(Object.keys(ROLLUP_COUNTERS).map(field => [field, 0])),
      uniqueUsers: new Set(),
      chatRequests: 0,
      chatResponses: 0,
      feedbackCount: 0,
      magicPrompts: 0
    },
    byUser: {},
    byApp: {},
    byModel: {},
    byProvider: {},
    tokenQuality: { provider: 0, estimate: 0 }
  };

  for (const event of events) {
    const uid = event.uid || 'unknown';
    const app = event.app || 'unknown';
    const model = event.model || 'unknown';
    const pt = event.pt || 0;
    const ct = event.ct || 0;
    const counts = { messages: 1, promptTokens: pt, completionTokens: ct };
    for (const [field, key] of Object.entries(ROLLUP_COUNTERS)) counts[field] = event[key] || 0;

    rollup.totals.uniqueUsers.add(uid);
    rollup.totals.promptTokens += pt;
    rollup.totals.completionTokens += ct;
    for (const field of Object.keys(ROLLUP_COUNTERS)) rollup.totals[field] += counts[field];

    if (event.type === 'chat_request') {
      rollup.totals.chatRequests += 1;
      rollup.totals.messages += 1;
    } else if (event.type === 'chat_response') {
      rollup.totals.chatResponses += 1;
      rollup.totals.messages += 1;
    } else if (event.type === 'feedback') {
      rollup.totals.feedbackCount += 1;
    } else if (event.type === 'magic_prompt') {
      rollup.totals.magicPrompts += 1;
    }

    if (event.src === 'provider') {
      rollup.tokenQuality.provider += 1;
    } else {
      rollup.tokenQuality.estimate += 1;
    }

    // Per-user / per-app / per-model aggregation; per provider (adapter) only
    // for events that recorded one.
    for (const [dim, key] of [
      ['byUser', uid],
      ['byApp', app],
      ['byModel', model],
      ['byProvider', event.prov]
    ]) {
      if (!key) continue;
      if (!rollup[dim][key]) rollup[dim][key] = emptyDimension();
      addDimension(rollup[dim][key], counts);
    }
  }

  // Convert Set to count
  rollup.totals.uniqueUsers = rollup.totals.uniqueUsers.size;
  return rollup;
}

/**
 * Build a monthly rollup by aggregating daily rollups.
 */
function buildMonthlyRollup(dailyRollups, month) {
  const rollup = {
    month,
    totals: {
      messages: 0,
      promptTokens: 0,
      completionTokens: 0,
      ...Object.fromEntries(Object.keys(ROLLUP_COUNTERS).map(field => [field, 0])),
      uniqueUsers: new Set(),
      days: dailyRollups.length
    },
    byUser: {},
    byApp: {},
    byModel: {},
    byProvider: {},
    tokenQuality: { provider: 0, estimate: 0 }
  };

  for (const daily of dailyRollups) {
    rollup.totals.messages += daily.totals.messages;
    rollup.totals.promptTokens += daily.totals.promptTokens;
    rollup.totals.completionTokens += daily.totals.completionTokens;
    // Daily files written before these counters existed have none of them.
    for (const field of Object.keys(ROLLUP_COUNTERS)) {
      rollup.totals[field] += daily.totals[field] || 0;
    }
    rollup.tokenQuality.provider += daily.tokenQuality.provider;
    rollup.tokenQuality.estimate += daily.tokenQuality.estimate;

    // Merge per-dimension data
    for (const dim of ['byUser', 'byApp', 'byModel', 'byProvider']) {
      for (const [key, val] of Object.entries(daily[dim] || {})) {
        if (!rollup[dim][key]) rollup[dim][key] = emptyDimension();
        addDimension(rollup[dim][key], val);
        if (dim === 'byUser') rollup.totals.uniqueUsers.add(key);
      }
    }
  }

  rollup.totals.uniqueUsers = rollup.totals.uniqueUsers.size;
  return rollup;
}

/**
 * Generate daily rollup files from events.
 */
export async function generateDailyRollups() {
  try {
    const events = await readEvents();
    if (events.length === 0) {
      logger.info('No usage events found for daily rollup generation', {
        component: 'UsageAggregator'
      });
      return { eventsProcessed: 0, daysGenerated: 0 };
    }

    // Group events by date
    const byDate = {};
    for (const event of events) {
      const date = event.ts.substring(0, 10); // YYYY-MM-DD
      if (!byDate[date]) byDate[date] = [];
      byDate[date].push(event);
    }

    const dailyDir = getDailyDir();
    await fs.mkdir(dailyDir, { recursive: true });

    for (const [date, dateEvents] of Object.entries(byDate)) {
      const rollup = buildDailyRollup(dateEvents, date);
      const filePath = path.join(dailyDir, `${date}.json`);
      await fs.writeFile(filePath, JSON.stringify(rollup, null, 2));
    }

    const daysGenerated = Object.keys(byDate).length;
    logger.info('Generated daily rollups', { component: 'UsageAggregator', daysGenerated });
    return { eventsProcessed: events.length, daysGenerated };
  } catch (error) {
    logger.error('Failed to generate daily rollups', { component: 'UsageAggregator', error });
    return { eventsProcessed: 0, daysGenerated: 0 };
  }
}

/**
 * Generate monthly rollup files from daily rollups.
 */
export async function generateMonthlyRollups() {
  try {
    const dailyDir = getDailyDir();
    const monthlyDir = getMonthlyDir();
    await fs.mkdir(monthlyDir, { recursive: true });

    let files;
    try {
      files = await fs.readdir(dailyDir);
    } catch {
      return { monthsGenerated: 0 }; // No daily rollups yet
    }

    // Group daily files by month
    const byMonth = {};
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const month = file.substring(0, 7); // YYYY-MM
      if (!byMonth[month]) byMonth[month] = [];
      const content = await fs.readFile(path.join(dailyDir, file), 'utf8');
      byMonth[month].push(JSON.parse(content));
    }

    for (const [month, dailyRollups] of Object.entries(byMonth)) {
      const rollup = buildMonthlyRollup(dailyRollups, month);
      const filePath = path.join(monthlyDir, `${month}.json`);
      await fs.writeFile(filePath, JSON.stringify(rollup, null, 2));
    }

    const monthsGenerated = Object.keys(byMonth).length;
    logger.info('Generated monthly rollups', { component: 'UsageAggregator', monthsGenerated });
    return { monthsGenerated };
  } catch (error) {
    logger.error('Failed to generate monthly rollups', { component: 'UsageAggregator', error });
    return { monthsGenerated: 0 };
  }
}

/**
 * Read daily rollups for a given date range.
 */
export async function getDailyRollups(startDate, endDate) {
  const dailyDir = getDailyDir();
  const results = [];
  try {
    const files = await fs.readdir(dailyDir);
    for (const file of files.sort()) {
      if (!file.endsWith('.json')) continue;
      const date = file.replace('.json', '');
      if (startDate && date < startDate) continue;
      if (endDate && date > endDate) continue;
      const content = await fs.readFile(path.join(dailyDir, file), 'utf8');
      results.push(JSON.parse(content));
    }
  } catch {
    // No rollups yet
  }
  return results;
}

/**
 * Read monthly rollups for a given range.
 */
export async function getMonthlyRollups(startMonth, endMonth) {
  const monthlyDir = getMonthlyDir();
  const results = [];
  try {
    const files = await fs.readdir(monthlyDir);
    for (const file of files.sort()) {
      if (!file.endsWith('.json')) continue;
      const month = file.replace('.json', '');
      if (startMonth && month < startMonth) continue;
      if (endMonth && month > endMonth) continue;
      const content = await fs.readFile(path.join(monthlyDir, file), 'utf8');
      results.push(JSON.parse(content));
    }
  } catch {
    // No rollups yet
  }
  return results;
}

/**
 * Delete rollup files older than `retentionDays` in the given directory.
 *
 * Files are expected to be named `<key>.json` where `<key>` is a
 * lexicographically-sortable date prefix (e.g. `YYYY-MM-DD` for daily,
 * `YYYY-MM` for monthly). A non-positive `retentionDays` (e.g. `-1`)
 * disables cleanup entirely so admins can keep history forever.
 *
 * @param {string} dir - Absolute path to the rollup directory.
 * @param {number} retentionDays
 * @param {number} keyLength - Length of the lexicographic date prefix
 *   (`10` for `YYYY-MM-DD`, `7` for `YYYY-MM`).
 * @returns {Promise<string[]>} list of deleted file names
 */
async function cleanupRollupDir(dir, retentionDays, keyLength) {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return [];
  let files;
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  // Format the cutoff to match the file key length so string comparison works.
  const cutoffKey =
    keyLength === 7 ? cutoff.toISOString().slice(0, 7) : cutoff.toISOString().slice(0, 10);

  const deleted = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const key = file.replace('.json', '');
    if (key.length !== keyLength) continue;
    if (key < cutoffKey) {
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
  }
  return deleted;
}

/**
 * Clean up daily rollup files past the configured retention. Returns the
 * list of deleted file names so callers can log a summary.
 */
export async function cleanupDailyRollups(retentionDays) {
  return cleanupRollupDir(getDailyDir(), retentionDays, 10);
}

/**
 * Clean up monthly rollup files past the configured retention.
 */
export async function cleanupMonthlyRollups(retentionDays) {
  return cleanupRollupDir(getMonthlyDir(), retentionDays, 7);
}

/**
 * Run all rollup generation and cleanup tasks.
 */
export async function runRollups(retentionConfig = {}) {
  const eventsFlushed = (await flushQueue()) || 0;
  const { eventsProcessed = 0, daysGenerated = 0 } = (await generateDailyRollups()) || {};
  const { monthsGenerated = 0 } = (await generateMonthlyRollups()) || {};
  if (retentionConfig.eventRetentionDays != null) {
    await cleanupEvents(retentionConfig.eventRetentionDays);
  }
  let dailyDeleted = [];
  let monthlyDeleted = [];
  if (retentionConfig.dailyRetentionDays != null) {
    dailyDeleted = await cleanupDailyRollups(retentionConfig.dailyRetentionDays);
    if (dailyDeleted.length > 0) {
      logger.info('Daily rollup cleanup removed expired files', {
        component: 'UsageAggregator',
        removed: dailyDeleted.length
      });
    }
  }
  if (retentionConfig.monthlyRetentionDays != null) {
    monthlyDeleted = await cleanupMonthlyRollups(retentionConfig.monthlyRetentionDays);
    if (monthlyDeleted.length > 0) {
      logger.info('Monthly rollup cleanup removed expired files', {
        component: 'UsageAggregator',
        removed: monthlyDeleted.length
      });
    }
  }
  let feedbackRemoved = 0;
  if (retentionConfig.feedbackRetentionDays != null) {
    try {
      const result = await cleanupFeedback(retentionConfig.feedbackRetentionDays);
      feedbackRemoved = result?.removed || 0;
    } catch (err) {
      logger.warn('Feedback cleanup failed', {
        component: 'UsageAggregator',
        error: err.message
      });
    }
  }
  return {
    eventsFlushed,
    eventsProcessed,
    daysGenerated,
    monthsGenerated,
    dailyDeleted: dailyDeleted.length,
    monthlyDeleted: monthlyDeleted.length,
    feedbackRemoved
  };
}

// Schedule periodic rollup generation
let rollupInterval = null;
export function startRollupScheduler(retentionConfig = {}) {
  if (rollupInterval) return;
  // Run immediately on start
  runRollups(retentionConfig).catch(e =>
    logger.error('Initial rollup failed', { component: 'UsageAggregator', error: e })
  );
  rollupInterval = setInterval(() => {
    runRollups(retentionConfig).catch(e =>
      logger.error('Scheduled rollup failed', { component: 'UsageAggregator', error: e })
    );
  }, ROLLUP_INTERVAL_MS);
}
