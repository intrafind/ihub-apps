import fs from 'fs/promises';
import path from 'path';
import { getRootDir } from './pathUtils.js';
import config from './config.js';
import { loadJson } from './configLoader.js';
import logger from './utils/logger.js';

const contentsDir = config.CONTENTS_DIR;
const dataFile = path.join(getRootDir(), contentsDir, 'data', 'feedback.jsonl');
const SAVE_INTERVAL_MS = 10000;

let trackingEnabled = true;
let configLoaded = false;
let queue = [];
let saveTimer = null;

async function loadConfig() {
  if (configLoaded) return;
  try {
    const cfg = await loadJson('config/platform.json');
    trackingEnabled = cfg?.features?.feedbackTracking !== false;
  } catch {
    trackingEnabled = true;
  }
  configLoaded = true;
}

async function flushQueue() {
  if (queue.length === 0) return;
  await fs.mkdir(path.dirname(dataFile), { recursive: true });
  const lines = queue.map(entry => JSON.stringify(entry)).join('\n') + '\n';
  queue = [];
  await fs.appendFile(dataFile, lines, 'utf8');
}

function scheduleFlush() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await flushQueue();
    } catch (error) {
      logger.error('Failed to save feedback data', { component: 'FeedbackStorage', error: e });
    }
  }, SAVE_INTERVAL_MS);
}

export function storeFeedback({
  messageId,
  appId,
  chatId,
  modelId,
  rating,
  comment = '',
  contentSnippet = '',
  conversationId = null,
  ifinderMessageId = null,
  baseUrl = null
}) {
  // Load config asynchronously if not loaded yet
  if (!configLoaded) {
    loadConfig().catch(e =>
      logger.error('Failed to load feedback config', { component: 'FeedbackStorage', error: e })
    );
  }

  if (!trackingEnabled || !messageId) return;
  const entry = {
    timestamp: new Date().toISOString(),
    messageId,
    appId,
    chatId,
    modelId,
    rating,
    comment,
    contentSnippet,
    conversationId,
    ifinderMessageId,
    baseUrl
  };
  queue.push(entry);
  scheduleFlush();
}

export async function reloadConfig() {
  configLoaded = false;
  await loadConfig();
}

/**
 * Drop feedback entries older than `retentionDays`. A non-positive value
 * (e.g. the default `-1`) disables cleanup entirely so admins can keep
 * feedback history forever.
 *
 * Entries are filtered by their ISO `timestamp` field; malformed lines are
 * preserved (we don't know their age) but never rewritten so they stay
 * append-safe. Flushes the in-memory queue first so newly-buffered entries
 * are never lost to a cleanup race.
 *
 * @param {number} retentionDays
 * @returns {Promise<{removed: number, kept: number}>}
 */
export async function cleanupFeedback(retentionDays) {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return { removed: 0, kept: 0 };
  }
  try {
    await flushQueue();
  } catch {
    // A flush failure is logged elsewhere; continue with what's on disk.
  }

  let content;
  try {
    content = await fs.readFile(dataFile, 'utf8');
  } catch {
    return { removed: 0, kept: 0 };
  }

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const lines = content.split('\n').filter(Boolean);
  const retained = [];
  let removed = 0;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry?.timestamp && entry.timestamp < cutoff) {
        removed += 1;
        continue;
      }
      retained.push(line);
    } catch {
      // Preserve malformed lines — we can't reason about their age safely.
      retained.push(line);
    }
  }

  if (removed > 0) {
    const out = retained.length > 0 ? retained.join('\n') + '\n' : '';
    await fs.writeFile(dataFile, out, 'utf8');
    logger.info('Feedback cleanup removed expired entries', {
      component: 'FeedbackStorage',
      removed,
      kept: retained.length
    });
  }
  return { removed, kept: retained.length };
}

// Start periodic flush interval
setInterval(() => {
  if (queue.length > 0) {
    flushQueue().catch(e =>
      logger.error('Feedback save error', { component: 'FeedbackStorage', error: e })
    );
  }
}, SAVE_INTERVAL_MS);
