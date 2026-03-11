import fs from 'fs/promises';
import path from 'path';
import {
  readEvents,
  getDailyDir,
  getMonthlyDir,
  cleanupEvents,
  flushQueue
} from './UsageEventLog.js';
import logger from '../utils/logger.js';

const ROLLUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

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
      uniqueUsers: new Set(),
      chatRequests: 0,
      chatResponses: 0,
      feedbackCount: 0,
      magicPrompts: 0
    },
    byUser: {},
    byApp: {},
    byModel: {},
    tokenQuality: { provider: 0, estimate: 0 }
  };

  for (const event of events) {
    const uid = event.uid || 'unknown';
    const app = event.app || 'unknown';
    const model = event.model || 'unknown';
    const pt = event.pt || 0;
    const ct = event.ct || 0;

    rollup.totals.uniqueUsers.add(uid);
    rollup.totals.promptTokens += pt;
    rollup.totals.completionTokens += ct;

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

    // Per-user aggregation
    if (!rollup.byUser[uid])
      rollup.byUser[uid] = { messages: 0, promptTokens: 0, completionTokens: 0 };
    rollup.byUser[uid].messages += 1;
    rollup.byUser[uid].promptTokens += pt;
    rollup.byUser[uid].completionTokens += ct;

    // Per-app aggregation
    if (!rollup.byApp[app])
      rollup.byApp[app] = { messages: 0, promptTokens: 0, completionTokens: 0 };
    rollup.byApp[app].messages += 1;
    rollup.byApp[app].promptTokens += pt;
    rollup.byApp[app].completionTokens += ct;

    // Per-model aggregation
    if (!rollup.byModel[model])
      rollup.byModel[model] = { messages: 0, promptTokens: 0, completionTokens: 0 };
    rollup.byModel[model].messages += 1;
    rollup.byModel[model].promptTokens += pt;
    rollup.byModel[model].completionTokens += ct;
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
      uniqueUsers: new Set(),
      days: dailyRollups.length
    },
    byUser: {},
    byApp: {},
    byModel: {},
    tokenQuality: { provider: 0, estimate: 0 }
  };

  for (const daily of dailyRollups) {
    rollup.totals.messages += daily.totals.messages;
    rollup.totals.promptTokens += daily.totals.promptTokens;
    rollup.totals.completionTokens += daily.totals.completionTokens;
    rollup.tokenQuality.provider += daily.tokenQuality.provider;
    rollup.tokenQuality.estimate += daily.tokenQuality.estimate;

    // Merge per-dimension data
    for (const [dim, dimKey] of [
      ['byUser', 'byUser'],
      ['byApp', 'byApp'],
      ['byModel', 'byModel']
    ]) {
      for (const [key, val] of Object.entries(daily[dim])) {
        if (!rollup[dimKey][key])
          rollup[dimKey][key] = { messages: 0, promptTokens: 0, completionTokens: 0 };
        rollup[dimKey][key].messages += val.messages;
        rollup[dimKey][key].promptTokens += val.promptTokens;
        rollup[dimKey][key].completionTokens += val.completionTokens;
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
  } catch (e) {
    logger.error('Failed to generate daily rollups', { component: 'UsageAggregator', error: e });
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
  } catch (e) {
    logger.error('Failed to generate monthly rollups', { component: 'UsageAggregator', error: e });
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
 * Run all rollup generation and cleanup tasks.
 */
export async function runRollups(retentionConfig = {}) {
  const eventsFlushed = (await flushQueue()) || 0;
  const { eventsProcessed = 0, daysGenerated = 0 } = (await generateDailyRollups()) || {};
  const { monthsGenerated = 0 } = (await generateMonthlyRollups()) || {};
  if (retentionConfig.eventRetentionDays != null) {
    await cleanupEvents(retentionConfig.eventRetentionDays);
  }
  return { eventsFlushed, eventsProcessed, daysGenerated, monthsGenerated };
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
