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
 * wins; the later cleared stamp wins), and users.json is changed only after.
 * A run that stops between the two steps is repeated in full on the next start.
 *
 * Self-contained: the document key and shape are a snapshot of
 * `AiAcknowledgementRepository` as of V255. Do NOT replace them with an import.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

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
 * Where users.json lives (resolution as in V117): `platform.localAuth.usersFile`
 * may move it. A contents-relative path is read through the migration context;
 * an absolute path outside the contents directory directly, so its
 * acknowledgements are moved too.
 *
 * @param {Object} ctx - Migration context
 * @returns {Promise<{rel: string}|{abs: string}>}
 */
async function resolveUsersFile(ctx) {
  const fallback = { rel: 'config/users.json' };
  if (!(await ctx.fileExists('config/platform.json'))) return fallback;
  let configured;
  try {
    configured = (await ctx.readJson('config/platform.json'))?.localAuth?.usersFile;
  } catch {
    return fallback;
  }
  if (typeof configured !== 'string' || configured.trim() === '') return fallback;
  const normalized = configured.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.startsWith('contents/')) return { rel: normalized.slice('contents/'.length) };
  if (!path.isAbsolute(configured)) return { rel: normalized };
  const fromContents = ctx.contentsDir ? path.relative(ctx.contentsDir, configured) : '';
  if (fromContents && !fromContents.startsWith('..') && !path.isAbsolute(fromContents)) {
    return { rel: fromContents.split(path.sep).join('/') };
  }
  return { abs: configured };
}

async function usersFileExists(ctx, where) {
  if (where.rel) return ctx.fileExists(where.rel);
  return fs.access(where.abs).then(
    () => true,
    () => false
  );
}

async function readUsers(ctx, where) {
  if (where.rel) return ctx.readJson(where.rel);
  return JSON.parse(await fs.readFile(where.abs, 'utf8'));
}

async function writeUsers(ctx, where, data) {
  if (where.rel) return ctx.writeJson(where.rel, data);
  const temp = `${where.abs}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(temp, where.abs);
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

export async function precondition(ctx) {
  const where = await resolveUsersFile(ctx);
  if (!(await usersFileExists(ctx, where))) return false;
  const usersConfig = await readUsers(ctx, where);
  return Object.values(usersConfig?.users || {}).some(hasLegacyFields);
}

export async function up(ctx) {
  const where = await resolveUsersFile(ctx);
  const usersConfig = await readUsers(ctx, where);
  let platform = {};
  try {
    platform = await ctx.readJson('config/platform.json');
  } catch {
    // a missing or unreadable platform.json means the default (filesystem) provider
  }
  const { bootstrapStorage, shutdownStorageBootstrap } = await import('../storage/bootstrap.js');
  const provider = await bootstrapStorage(platform);
  try {
    const { users, entries } = await importAcknowledgements({
      documents: provider.documents,
      usersConfig
    });
    await writeUsers(ctx, where, usersConfig);
    ctx.log(
      `Moved the AI acknowledgements of ${users} users (${entries} entries) out of users.json`
    );
  } finally {
    await shutdownStorageBootstrap();
  }
}
