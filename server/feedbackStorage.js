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

// Single-flight serialization for any operation that touches `feedback.jsonl`.
// `flushQueue` (appendFile) and `cleanupFeedback` (read + writeFile) must not
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

async function appendQueueToDisk() {
  if (queue.length === 0) return;
  await fs.mkdir(path.dirname(dataFile), { recursive: true });
  const pending = queue;
  queue = [];
  const lines = pending.map(entry => JSON.stringify(entry)).join('\n') + '\n';
  try {
    await fs.appendFile(dataFile, lines, 'utf8');
  } catch (err) {
    // Re-buffer on failure so the next flush retries instead of dropping entries.
    queue = pending.concat(queue);
    throw err;
  }
}

async function flushQueue() {
  return withWriteLock(appendQueueToDisk);
}

function scheduleFlush() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await flushQueue();
    } catch (error) {
      logger.error('Failed to save feedback data', { component: 'FeedbackStorage', error });
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
    loadConfig().catch(err =>
      logger.error('Failed to load feedback config', { component: 'FeedbackStorage', error: err })
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
 * preserved verbatim (we can't reason about their age safely) so admins can
 * inspect/repair them out-of-band rather than have cleanup silently delete
 * them. Read-filter-rewrite is serialised against `flushQueue` by an
 * in-process write lock so a concurrent append cannot be overwritten.
 *
 * @param {number} retentionDays
 * @returns {Promise<{removed: number, kept: number}>}
 */
export async function cleanupFeedback(retentionDays) {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return { removed: 0, kept: 0 };
  }
  return withWriteLock(async () => {
    // Drain any queued entries into the on-disk file first so they're included
    // in the read-filter pass below. Done under the lock so a new
    // scheduleFlush() can't slip in between drain and rewrite.
    try {
      await appendQueueToDisk();
    } catch {
      // A drain failure is logged elsewhere; continue with what's on disk.
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
  });
}

// Start periodic flush interval
setInterval(() => {
  if (queue.length > 0) {
    flushQueue().catch(err =>
      logger.error('Feedback save error', { component: 'FeedbackStorage', error: err })
    );
  }
}, SAVE_INTERVAL_MS);
