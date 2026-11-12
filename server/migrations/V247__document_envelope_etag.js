// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Migration V247 — store `etag` and `size` in every document envelope
 *
 * The filesystem document store derived a document's `etag` and `size` from
 * its body on every read, so a metadata-only listing read, parsed,
 * canonicalized and hashed every document it listed — on an installation with
 * a large workflow history, more than a gigabyte of heap at startup (#3624).
 * The store now writes both into the envelope, before `data`, and reads a
 * metadata-only listing from the start of the file. It has no fallback for an
 * envelope without them: such an envelope reads as corrupt.
 *
 * This rewrites the envelopes written by earlier releases (`v: 1`) once, one
 * document at a time, as `v: 2` with the values the store reported for them
 * until now — sha256 and UTF-8 byte length of the canonical serialization of
 * the body — so an etag a client already holds still matches. Timestamps,
 * owner and content type are kept; owner index markers are untouched.
 *
 * Only the filesystem provider stores envelopes; another provider skips it.
 * Raw configuration namespaces (`contents/apps`, …) are files of their own and
 * are not touched. Runs before the server's storage bootstrap, so nothing else
 * writes while it runs.
 */
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveStorageConfig } from '../storage/StorageRegistry.js';

export const version = '247';
export const description = 'document_envelope_etag';

/** Envelope version that carries `etag` and `size`. */
const UPGRADED_VERSION = 2;

/** Directory entries of a namespace that are bookkeeping, not documents. */
const RESERVED = new Set(['.owners', '.locks']);

// Snapshot of storage/canonicalJson.js + storage/etag.js as of V247 — the etag
// rule. Do NOT replace with an import: migrations must be self-contained.
function canonicalReplacer(_key, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = value[key];
  return sorted;
}

function digest(data) {
  const json = JSON.stringify(data, canonicalReplacer);
  return {
    etag: crypto.createHash('sha256').update(json, 'utf8').digest('hex'), // lgtm[js/insufficient-password-hash] -- entity tag over a document body, not a stored password
    size: Buffer.byteLength(json, 'utf8')
  };
}

/**
 * The filesystem provider's base directory, as the provider resolves it.
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

/**
 * Whether a parsed file is an envelope written before V247.
 *
 * @param {unknown} value - Parsed JSON
 * @param {string} key - Key the file name says it holds
 * @returns {boolean}
 */
function isLegacyEnvelope(value, key) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.v === 1 &&
    value.key === key &&
    Object.hasOwn(value, 'data')
  );
}

async function readdirSafe(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
}

export async function precondition(ctx) {
  const { provider } = await storageLocation(ctx);
  return provider === 'filesystem';
}

export async function up(ctx) {
  const { baseDir } = await storageLocation(ctx);
  let upgraded = 0;
  let unreadable = 0;
  for (const namespace of await readdirSafe(baseDir)) {
    if (!namespace.isDirectory() || namespace.name.startsWith('.')) continue;
    const nsDir = path.join(baseDir, namespace.name);
    for (const entry of await readdirSafe(nsDir)) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      if (RESERVED.has(entry.name) || entry.name.startsWith('.tmp_')) continue;
      const key = entry.name.slice(0, -'.json'.length);
      const file = path.join(nsDir, entry.name);
      // One document at a time: read, rewrite, let go.
      let envelope;
      try {
        envelope = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch {
        unreadable += 1;
        continue;
      }
      if (!isLegacyEnvelope(envelope, key)) continue;
      const data = envelope.data === undefined ? null : envelope.data;
      const { etag, size } = digest(data);
      const next = {
        v: UPGRADED_VERSION,
        key: envelope.key,
        ownerId: envelope.ownerId ?? null,
        contentType: envelope.contentType,
        createdAt: envelope.createdAt,
        updatedAt: envelope.updatedAt,
        etag,
        size,
        data
      };
      const temp = path.join(nsDir, `.tmp_v247_${process.pid}_${crypto.randomUUID()}`);
      await fs.writeFile(temp, JSON.stringify(next, null, 2), 'utf8');
      await fs.rename(temp, file);
      upgraded += 1;
    }
  }
  ctx.log(`Document envelopes: upgraded ${upgraded} with their etag and size`);
  if (unreadable > 0) {
    ctx.warn(
      `Document envelopes: ${unreadable} file(s) could not be parsed and were left as they are`
    );
  }
}
