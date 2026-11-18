// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V255 — move users' AI-use acknowledgements out of users.json
 *
 * Until now a user's confirmations (`aiAcknowledgements`) and the time an admin
 * last removed them (`aiAcknowledgementsClearedAt`) were fields of their
 * users.json record. Every confirmation rewrote the whole user file under one
 * lock, which a sign-in wave turned into lock timeouts. They now live in one
 * small runtime document per user (namespace `ai-acknowledgements`).
 *
 * This migration copies the fields of every record into that user's document,
 * then removes them from users.json. A migration, not a boot-time import,
 * because migrations run once per cluster (the primary, under the migration
 * lock) before any worker serves, and V219 already brings the storage provider
 * up the same way. Safe to run again: the documents are written first, merged
 * with what a document already holds (an entry per version, the existing one
 * wins; the later cleared stamp wins), and users.json is changed only after,
 * from a fresh read under the lock the server writes it under (see
 * `moveAcknowledgements`). A run that stops between the two steps is repeated
 * in full on the next start.
 *
 * Self-contained: the document key and shape are a snapshot of
 * `AiAcknowledgementRepository` as of V255. Do NOT replace them with an import.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getRootDir } from '../pathUtils.js';
import { atomicWriteJSON } from '../utils/atomicWrite.js';

export const version = '255';
export const description = 'move_ai_acknowledgements_to_runtime_store';

// Snapshot of RUNTIME_NAMESPACES.aiAcknowledgements as of V255.
const NAMESPACE = 'ai-acknowledgements';
const DOC_VERSION = 1;
const MAX_ATTEMPTS = 5;

/**
 * Snapshot of `acknowledgementKey()` (AiAcknowledgementRepository) as of V255.
 *
 * @param {string} userId
 * @returns {string}
 */
function acknowledgementKey(userId) {
  return `ack_${createHash('sha256').update(String(userId)).digest('hex').slice(0, 24)}`;
}

/**
 * Where a configured users.json lives — the rule of `locateConfigFile`
 * (utils/configFileLocation.js), which the server reads and writes it by,
 * mirrored here with the migration's contents directory: a relative path is
 * relative to the installation root, and the file is addressed through the
 * contents directory only when it lies inside it.
 *
 * @param {string} configured - `platform.localAuth.usersFile` as configured
 * @param {{rootDir: string, contentsDir: string}} dirs - Absolute directories
 * @returns {{fullPath: string, relPath: string|null}} `relPath` is
 *   contents-relative, or null for a file outside the contents directory
 */
export function locateUsersFile(configured, { rootDir, contentsDir }) {
  const fullPath = path.isAbsolute(configured) ? configured : path.join(rootDir, configured);
  const fromContents = path.relative(contentsDir, fullPath);
  const contained =
    !!fromContents && !path.isAbsolute(fromContents) && !fromContents.startsWith('..');
  return { fullPath, relPath: contained ? fromContents.split(path.sep).join('/') : null };
}

/**
 * Where users.json lives: `platform.localAuth.usersFile` may move it.
 *
 * @param {Object} ctx - Migration context
 * @returns {Promise<{fullPath: string, relPath: string|null, configured: boolean}>}
 */
async function resolveUsersFile(ctx) {
  const fallback = {
    fullPath: path.join(ctx.contentsDir, 'config/users.json'),
    relPath: 'config/users.json',
    configured: false
  };
  if (!(await ctx.fileExists('config/platform.json'))) return fallback;
  let configured;
  try {
    configured = (await ctx.readJson('config/platform.json'))?.localAuth?.usersFile;
  } catch {
    return fallback;
  }
  if (typeof configured !== 'string' || configured.trim() === '') return fallback;
  return {
    ...locateUsersFile(configured, { rootDir: getRootDir(), contentsDir: ctx.contentsDir }),
    configured: true
  };
}

async function usersFileExists(ctx, where) {
  if (where.relPath) return ctx.fileExists(where.relPath);
  return fs.access(where.fullPath).then(
    () => true,
    () => false
  );
}

async function readUsers(ctx, where) {
  if (where.relPath) return ctx.readJson(where.relPath);
  return JSON.parse(await fs.readFile(where.fullPath, 'utf8'));
}

/**
 * Change users.json under the lock the server writes it under (see
 * `updateUsersFile` in utils/userManager.js): `configStore.updateJson` for a
 * file under contents/, a lock file next to it otherwise.
 *
 * @param {{fullPath: string, relPath: string|null}} where
 * @param {(current: Object) => Promise<Object|undefined>} change - Returns the
 *   body to write, or undefined to leave the file alone; may run more than once
 */
async function updateUsersLocked(where, change) {
  if (where.relPath) {
    const { default: configStore } = await import('../services/config/ConfigStore.js');
    await configStore.updateJson(where.relPath, current => (current ? change(current) : undefined));
    return;
  }
  const { withFileLock } = await import('../utils/fileLock.js');
  await withFileLock(`${where.fullPath}.lock`, async () => {
    const next = await change(JSON.parse(await fs.readFile(where.fullPath, 'utf8')));
    if (next !== undefined) await atomicWriteJSON(where.fullPath, next);
  });
}

/** Whether a record still carries an acknowledgement field. */
function hasLegacyFields(user) {
  return (
    !!user &&
    typeof user === 'object' &&
    (Object.hasOwn(user, 'aiAcknowledgements') ||
      Object.hasOwn(user, 'aiAcknowledgementsClearedAt'))
  );
}

/** The later of two ISO times; either may be missing. */
function later(a, b) {
  if (typeof a !== 'string') return typeof b === 'string' ? b : undefined;
  if (typeof b !== 'string') return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/**
 * Merge a record's fields into the user's document under compare-and-set.
 *
 * @returns {Promise<number>} Entries the document did not have yet
 */
async function mergeIntoDocument(documents, userId, user) {
  const key = acknowledgementKey(userId);
  const incoming = Array.isArray(user.aiAcknowledgements)
    ? user.aiAcknowledgements.filter(entry => Number.isInteger(entry?.version))
    : [];
  for (let attempt = 1; ; attempt += 1) {
    const doc = await documents.get(NAMESPACE, key);
    const current =
      doc?.data && String(doc.data.userId) === String(userId)
        ? doc.data
        : { version: DOC_VERSION, userId: String(userId), aiAcknowledgements: [] };
    const existing = Array.isArray(current.aiAcknowledgements) ? current.aiAcknowledgements : [];
    const known = new Set(existing.map(entry => entry?.version));
    const added = incoming.filter(entry => !known.has(entry.version));
    const clearedAt = later(current.aiAcknowledgementsClearedAt, user.aiAcknowledgementsClearedAt);
    if (added.length === 0 && clearedAt === current.aiAcknowledgementsClearedAt && doc) return 0;
    const next = { ...current, aiAcknowledgements: [...existing, ...added] };
    if (clearedAt) next.aiAcknowledgementsClearedAt = clearedAt;
    try {
      await documents.put(NAMESPACE, key, next, {
        ownerId: String(userId),
        etag: doc ? doc.etag : null
      });
      return added.length;
    } catch (error) {
      if (error?.code !== 'ETAG_MISMATCH' || attempt >= MAX_ATTEMPTS) throw error;
    }
  }
}

/**
 * Copy every record's acknowledgement fields into the documents, then remove
 * them from `usersConfig` (in place). The caller writes users.json afterwards.
 *
 * @param {Object} params
 * @param {Object} params.documents - Document facet of the storage provider
 * @param {Object} params.usersConfig - Parsed users.json
 * @returns {Promise<{users: number, entries: number}>} Records moved and entries added
 */
export async function importAcknowledgements({ documents, usersConfig }) {
  const users =
    usersConfig?.users && typeof usersConfig.users === 'object' ? usersConfig.users : {};
  let moved = 0;
  let entries = 0;
  const ids = Object.keys(users).filter(id => hasLegacyFields(users[id]));
  // Every document first: users.json changes only once nothing can be lost.
  for (const id of ids) entries += await mergeIntoDocument(documents, id, users[id]);
  for (const id of ids) {
    delete users[id].aiAcknowledgements;
    delete users[id].aiAcknowledgementsClearedAt;
    moved += 1;
  }
  return { users: moved, entries };
}

/** A record's acknowledgement fields, comparable as a string. */
function legacyFingerprint(user) {
  return JSON.stringify([user?.aiAcknowledgements, user?.aiAcknowledgementsClearedAt]);
}

/**
 * Move the acknowledgements in two passes, so users.json is locked only briefly.
 *
 * The bulk is copied from `snapshot` without any lock. users.json is then
 * changed from a fresh read under the server's lock: during a rolling deploy
 * older servers keep writing it (new users, admin edits, new confirmations),
 * and rewriting the snapshot would erase those. A record whose fields changed
 * since the snapshot is imported again before the fields are stripped.
 *
 * @param {Object} params
 * @param {Object} params.documents - Document facet of the storage provider
 * @param {Object} params.snapshot - users.json as read before the first pass
 * @param {(change: Function) => Promise<void>} params.update - Runs `change`
 *   on a fresh users.json under its lock and writes what it returns
 * @returns {Promise<{users: number, entries: number}>}
 */
export async function moveAcknowledgements({ documents, snapshot, update }) {
  const before = snapshot?.users && typeof snapshot.users === 'object' ? snapshot.users : {};
  const first = await importAcknowledgements({ documents, usersConfig: snapshot });
  let late = { users: 0, entries: 0 };
  await update(async current => {
    const users = current?.users && typeof current.users === 'object' ? current.users : {};
    const changed = {};
    let stripped = false;
    for (const [id, user] of Object.entries(users)) {
      if (!hasLegacyFields(user)) continue;
      stripped = true;
      changed[id] = user;
      if (legacyFingerprint(user) === legacyFingerprint(before[id])) {
        // Already in the documents; only the fields go.
        delete user.aiAcknowledgements;
        delete user.aiAcknowledgementsClearedAt;
        delete changed[id];
      }
    }
    // `update` may run more than once; only the last run's count is reported.
    late = await importAcknowledgements({ documents, usersConfig: { users: changed } });
    return stripped ? current : undefined;
  });
  return { users: first.users, entries: first.entries + late.entries };
}

export async function precondition(ctx) {
  const where = await resolveUsersFile(ctx);
  if (!(await usersFileExists(ctx, where))) {
    if (where.configured) {
      ctx.warn?.(
        `localAuth.usersFile points to ${where.fullPath}, which does not exist; ` +
          'no AI acknowledgements to move'
      );
    }
    return false;
  }
  const usersConfig = await readUsers(ctx, where);
  return Object.values(usersConfig?.users || {}).some(hasLegacyFields);
}

export async function up(ctx) {
  const where = await resolveUsersFile(ctx);
  const snapshot = await readUsers(ctx, where);
  let platform = {};
  try {
    platform = await ctx.readJson('config/platform.json');
  } catch {
    // a missing or unreadable platform.json means the default (filesystem) provider
  }
  const { bootstrapStorage, shutdownStorageBootstrap } = await import('../storage/bootstrap.js');
  const provider = await bootstrapStorage(platform);
  try {
    const { users, entries } = await moveAcknowledgements({
      documents: provider.documents,
      snapshot,
      update: change => updateUsersLocked(where, change)
    });
    ctx.log(
      `Moved the AI acknowledgements of ${users} users (${entries} entries) out of users.json`
    );
  } finally {
    await shutdownStorageBootstrap();
  }
}
