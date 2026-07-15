/**
 * Per-user notification persistence.
 *
 * v1 scope: one JSON file per user under contents/data/notifications/<userId>.json,
 * capped at MAX_NOTIFICATIONS_PER_USER entries. This is intentionally not the
 * PostgreSQL-backed store described in #1499/#1490 — those don't exist yet.
 * Swapping the implementation later (e.g. once a writable StorageProvider
 * lands) should not require changes to NotificationService's call sites.
 */
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { getRootDir } from '../../pathUtils.js';
import config from '../../config.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import logger from '../../utils/logger.js';

const NOTIFICATIONS_DIR = path.join(getRootDir(), config.CONTENTS_DIR, 'data', 'notifications');
const MAX_NOTIFICATIONS_PER_USER = 200;

/**
 * Restrict userId to a safe filename component, mirroring
 * TokenStorageService.js's `_assertSafeFilenameComponent` — user ids can be
 * emails (contain '@', '.', '+'), so this is intentionally broader than
 * pathSecurity.js's SAFE_ID_PATTERN, which rejects '@'.
 */
function assertSafeUserId(userId) {
  if (typeof userId !== 'string' || userId.length === 0 || userId.length > 256) {
    throw new Error('Invalid userId: must be a non-empty string up to 256 characters');
  }
  if (!/^[A-Za-z0-9._@+-]+$/.test(userId)) {
    throw new Error('Invalid userId: contains characters outside the safe filename set');
  }
}

function filePathForUser(userId) {
  assertSafeUserId(userId);
  const candidate = path.resolve(NOTIFICATIONS_DIR, `${userId}.json`);
  const baseDir = path.resolve(NOTIFICATIONS_DIR) + path.sep;
  if (!candidate.startsWith(baseDir)) {
    throw new Error('Resolved notifications file path escapes its base directory');
  }
  return candidate;
}

// Per-user write locks so a read-modify-write (append/markRead) can't race
// against another one for the same user. Separate users never contend.
const writeLocks = new Map();
function withUserWriteLock(userId, fn) {
  const prev = writeLocks.get(userId) || Promise.resolve();
  const run = prev.then(fn, fn);
  // Store a non-rejecting continuation as the lock so a failed operation
  // doesn't permanently wedge this user's future writes.
  writeLocks.set(
    userId,
    run.catch(() => {})
  );
  return run;
}

async function readUserNotifications(userId) {
  const filePath = filePathForUser(userId);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    logger.warn('Failed to read notifications file, treating as empty', {
      component: 'NotificationStore',
      userId,
      error: error.message
    });
    return [];
  }
}

async function writeUserNotifications(userId, notifications) {
  const filePath = filePathForUser(userId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteJSON(filePath, notifications);
}

/**
 * Append a new notification for a user and persist it, capping the stored
 * history at MAX_NOTIFICATIONS_PER_USER (oldest entries are dropped).
 *
 * @param {string} userId
 * @param {string} type - e.g. 'job.started' | 'job.progress' | 'job.completed' | 'job.error'
 * @param {object} [data] - Arbitrary event payload
 * @returns {Promise<object>} The persisted notification
 */
export async function appendNotification(userId, type, data = {}) {
  const notification = {
    id: crypto.randomUUID(),
    userId,
    type,
    data,
    read: false,
    createdAt: new Date().toISOString()
  };

  await withUserWriteLock(userId, async () => {
    const existing = await readUserNotifications(userId);
    const updated = [notification, ...existing].slice(0, MAX_NOTIFICATIONS_PER_USER);
    await writeUserNotifications(userId, updated);
  });

  return notification;
}

/**
 * List a user's notifications, most recent first.
 *
 * @param {string} userId
 * @param {object} [options]
 * @param {number} [options.limit=50]
 * @param {boolean} [options.unreadOnly=false]
 */
export async function listNotifications(userId, { limit = 50, unreadOnly = false } = {}) {
  const all = await readUserNotifications(userId);
  const filtered = unreadOnly ? all.filter(n => !n.read) : all;
  return filtered.slice(0, limit);
}

export async function countUnread(userId) {
  const all = await readUserNotifications(userId);
  return all.reduce((count, n) => (n.read ? count : count + 1), 0);
}

/**
 * Mark a single notification as read. No-op (returns false) if not found.
 */
export async function markRead(userId, notificationId) {
  return withUserWriteLock(userId, async () => {
    const all = await readUserNotifications(userId);
    const target = all.find(n => n.id === notificationId);
    if (!target || target.read) return false;
    target.read = true;
    await writeUserNotifications(userId, all);
    return true;
  });
}

/**
 * Mark all of a user's notifications as read.
 * @returns {Promise<number>} Number of notifications flipped from unread to read.
 */
export async function markAllRead(userId) {
  return withUserWriteLock(userId, async () => {
    const all = await readUserNotifications(userId);
    let changed = 0;
    for (const n of all) {
      if (!n.read) {
        n.read = true;
        changed += 1;
      }
    }
    if (changed > 0) await writeUserNotifications(userId, all);
    return changed;
  });
}
