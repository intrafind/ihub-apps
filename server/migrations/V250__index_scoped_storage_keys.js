// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V250 — build the key-prefix index of the filesystem storage
 * provider for what is already stored.
 *
 * Listings scoped to one chat's files, one run's artifacts or one project's
 * blobs read the whole namespace directory and filtered it by prefix — every
 * chat file on the installation to show one chat's. The filesystem document
 * and blob stores now keep an index by the leading `__`-separated segments of
 * the key (`<ns>/.prefixes/<partition>/<key>`, an empty marker per key) and a
 * listing whose prefix pins one partition reads only that directory. Stores
 * write the marker with every new document or blob; this writes it for the
 * ones stored before, so a scoped listing does not miss them.
 *
 * Idempotent (a marker that exists is written again, empty), touches nothing
 * but marker files, and only for the filesystem provider — another provider
 * skips it. Runs before the server's storage bootstrap, so nothing else writes
 * while it runs.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveStorageConfig } from '../storage/StorageRegistry.js';

export const version = '250';
export const description = 'index_scoped_storage_keys';

// Snapshot of KEY_PREFIX_SEGMENTS (storage/namespaces.js) as of V250. Do NOT
// replace with an import — migrations must be self-contained. A namespace
// added there later needs its own migration.
const KEY_PREFIX_SEGMENTS = Object.freeze({
  'chat-files': 2,
  artifacts: 2,
  'project-files': 1
});

/** Directory of a namespace holding the index partitions. */
const PREFIXES_DIR = '.prefixes';

/** Directory holding the blob namespaces, under the provider's base directory. */
const BLOB_DIR = 'blobs';

// Snapshot of utils/pathSecurity.js `isValidId` as of V250.
const SAFE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function isValidId(id) {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 100 &&
    !id.includes('..') &&
    !DANGEROUS_KEYS.has(id) &&
    id !== '.' &&
    SAFE_ID_PATTERN.test(id)
  );
}

// Snapshot of storage/providers/filesystem/paths.js `prefixPartition` as of V250.
function prefixPartition(key, n) {
  let pos = 0;
  let hit = -1;
  for (let i = 0; i < n; i += 1) {
    hit = key.indexOf('__', pos);
    if (hit < 0) return null;
    pos = hit + 2;
  }
  const partition = key.slice(0, hit);
  return isValidId(partition) ? partition : null;
}

/**
 * The filesystem provider's base directory, as the provider resolves it
 * (copy of V247's).
 *
 * @param {Object} ctx - Migration context
 * @returns {Promise<{provider: string, baseDir: string}>}
 */
async function storageLocation(ctx) {
  let platform = {};
  try {
    platform = await ctx.readJson('config/platform.json');
  } catch {
    // a missing or unreadable platform.json means the default (filesystem) provider
  }
  const { provider, config } = resolveStorageConfig(platform);
  let baseDir;
  if (typeof config.baseDir === 'string' && config.baseDir.length > 0) {
    baseDir = path.resolve(config.baseDir);
  } else {
    const dataDir =
      typeof config.dataDir === 'string' && config.dataDir.length > 0
        ? config.dataDir
        : process.env.DATA_DIR || 'data';
    baseDir = path.join(ctx.contentsDir, dataDir);
  }
  return { provider, baseDir };
}

async function readdirSafe(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
}

/**
 * Write the markers for a set of keys stored in one namespace directory.
 *
 * @param {string} nsDir - Namespace directory (documents or blobs)
 * @param {string[]} keys - Keys stored there
 * @param {number} segments - Segment count of the namespace
 * @returns {Promise<number>} Markers written
 */
async function indexKeys(nsDir, keys, segments) {
  const made = new Set();
  let written = 0;
  for (const key of keys) {
    if (!isValidId(key)) continue;
    const partition = prefixPartition(key, segments);
    if (!partition) continue;
    const dir = path.join(nsDir, PREFIXES_DIR, partition);
    if (!made.has(partition)) {
      await fs.mkdir(dir, { recursive: true });
      made.add(partition);
    }
    await fs.writeFile(path.join(dir, key), '');
    written += 1;
  }
  return written;
}

export async function precondition(ctx) {
  const { provider } = await storageLocation(ctx);
  return provider === 'filesystem';
}

export async function up(ctx) {
  const { baseDir } = await storageLocation(ctx);
  let documents = 0;
  let blobs = 0;
  for (const [ns, segments] of Object.entries(KEY_PREFIX_SEGMENTS)) {
    const docDir = path.join(baseDir, ns);
    const docKeys = (await readdirSafe(docDir))
      .filter(
        entry => entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.tmp_')
      )
      .map(entry => entry.name.slice(0, -'.json'.length));
    documents += await indexKeys(docDir, docKeys, segments);

    const blobDir = path.join(baseDir, BLOB_DIR, ns);
    const blobKeys = (await readdirSafe(blobDir))
      .filter(
        entry =>
          entry.isFile() && !entry.name.startsWith('.tmp_') && !entry.name.startsWith('..deleting_')
      )
      .map(entry => entry.name);
    blobs += await indexKeys(blobDir, blobKeys, segments);
  }
  ctx.log(`Key-prefix index: ${documents} document and ${blobs} blob marker(s) written`);
}
