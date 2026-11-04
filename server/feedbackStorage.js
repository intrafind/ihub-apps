// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import fs from 'node:fs/promises';
import { loadJson } from './configLoader.js';
import logger from './utils/logger.js';
import { createJsonlAppender } from './utils/jsonlAppender.js';
import { getContentsPath } from './utils/contentsPath.js';

const dataFile = getContentsPath('data', 'feedback.jsonl');

let trackingEnabled = true;
let configLoaded = false;

const appender = createJsonlAppender({
  getFilePath: () => dataFile,
  component: 'FeedbackStorage'
});

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
  appender.append(entry);
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
 * them. Read-filter-rewrite is serialised against the appender's flush by a
 * write lock so a concurrent append cannot be overwritten.
 *
 * @param {number} retentionDays
 * @returns {Promise<{removed: number, kept: number}>}
 */
export async function cleanupFeedback(retentionDays) {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return { removed: 0, kept: 0 };
  }
  return appender.withWriteLock(async () => {
    // Drain any queued entries into the on-disk file first so they're included
    // in the read-filter pass below. Done under the lock so a new append()
    // can't slip in between drain and rewrite.
    try {
      await appender.drainToDisk();
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

/**
 * One page of stored feedback, newest first. Entries are appended in time
 * order, so a page is a slice from the end of the file: only the lines of
 * that page are parsed, and nothing is sorted.
 *
 * @param {{limit?: number, offset?: number}} [opts]
 * @returns {Promise<{feedbackEntries: Object[], total: number, limit: number, offset: number}>}
 */
export async function readFeedbackPage({ limit = 100, offset = 0 } = {}) {
  const pageSize = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
  const skip = Math.max(Number.parseInt(offset, 10) || 0, 0);
  try {
    await appender.flush();
  } catch {
    // Show what is on disk.
  }
  let content;
  try {
    content = await fs.readFile(dataFile, 'utf8');
  } catch {
    return { feedbackEntries: [], total: 0, limit: pageSize, offset: skip };
  }
  const lines = content.split('\n').filter(line => line.trim());
  const total = lines.length;
  const end = Math.max(total - skip, 0);
  const start = Math.max(end - pageSize, 0);
  const feedbackEntries = [];
  for (let i = end - 1; i >= start; i--) {
    try {
      feedbackEntries.push(JSON.parse(lines[i]));
    } catch {
      // Skip a malformed line.
    }
  }
  return { feedbackEntries, total, limit: pageSize, offset: skip };
}
