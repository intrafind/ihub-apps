// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Test doubles for the blob storage tests: an in-memory blob store, key
 * providers over fixed master keys, and a composed filesystem + S3 provider on
 * the fake S3 server.
 *
 * @module tests/support/blobTestSupport
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BlobStore } from '../../storage/BlobStore.js';
import {
  clampBlobLimit,
  compareBlobKeys,
  decodeBlobCursor,
  encodeBlobCursor,
  toBlobBuffer
} from '../../storage/blobSupport.js';
import { ComposedStorageProvider } from '../../storage/ComposedStorageProvider.js';
import { FilesystemStorageProvider } from '../../storage/providers/filesystem/index.js';
import { createS3BlobBackend } from '../../storage/providers/s3/index.js';

/** Two fixed master keys (hex). Test values, used nowhere else. */
export const MASTER_KEY_A = 'a1'.repeat(32);
export const MASTER_KEY_B = 'b2'.repeat(32);

/**
 * A blob store in a Map, with direct access to what is stored.
 */
export class MemoryBlobStore extends BlobStore {
  constructor() {
    super();
    /** @type {Map<string, Buffer>} `<ns>/<key>` → stored bytes */
    this.objects = new Map();
    this.gets = 0;
  }

  async put(ns, key, data) {
    const buffer = Buffer.from(toBlobBuffer(data));
    this.objects.set(`${ns}/${key}`, buffer);
    return {
      key,
      bytes: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex')
    };
  }

  async get(ns, key) {
    this.gets += 1;
    const data = this.objects.get(`${ns}/${key}`);
    return data ? { key, bytes: data.length, data: Buffer.from(data) } : null;
  }

  async delete(ns, key) {
    return this.objects.delete(`${ns}/${key}`);
  }

  async list(ns, { prefix = '', limit, cursor } = {}) {
    const after = cursor ? decodeBlobCursor(cursor) : null;
    const keys = [...this.objects.keys()]
      .filter(name => name.startsWith(`${ns}/`))
      .map(name => name.slice(ns.length + 1))
      .filter(key => key.startsWith(prefix) && (after === null || key > after))
      .sort(compareBlobKeys);
    const page = keys.slice(0, clampBlobLimit(limit));
    return {
      items: page.map(key => ({ key, bytes: this.objects.get(`${ns}/${key}`).length })),
      nextCursor: keys.length > page.length ? encodeBlobCursor(page[page.length - 1]) : null
    };
  }
}

/**
 * The key module a blob backend loads (`crypto/KeyProvider.js`), over fixed
 * keys instead of the installation's key file.
 *
 * @param {Object} keyModule - The real `crypto/KeyProvider.js` module.
 * @param {Object} [options]
 * @param {string|null} [options.master] - Current master key (hex); null for "none".
 * @param {string|null} [options.previous] - Previous master key (hex).
 * @param {string} [options.source='file'] - Reported key source.
 * @returns {Object} `ensureMasterKey`, `getKeyProvider`, `openConfigSecret`, `provider`.
 */
export function fixedKeys(
  keyModule,
  { master = MASTER_KEY_A, previous = null, source = 'file' } = {}
) {
  const provider = new keyModule.LocalFileKeyProvider({
    readMasterKey: () => master,
    readPreviousKey: () => previous
  });
  const describe = async () => ({
    initialized: Boolean(master),
    source: master ? source : null,
    fingerprint: null,
    keyId: master ? await provider.currentKeyId() : null
  });
  return {
    provider,
    ensureMasterKey: describe,
    getKeyProvider: () => provider,
    openConfigSecret: value => value
  };
}

/**
 * The `storage.blobs.s3` block for a fake S3 server.
 *
 * @param {Object} s3 - A running fake server.
 * @param {Object} [overrides]
 * @returns {Object}
 */
export function s3ConfigFor(s3, overrides = {}) {
  return {
    endpoint: s3.endpoint,
    bucket: 'ihub-test',
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
    maxAttempts: 2,
    ...overrides
  };
}

/**
 * A filesystem provider over a scratch directory with its blobs on the fake
 * S3 server, as `storage.blobs.provider: "s3"` composes it.
 *
 * @param {Object} options
 * @param {Object} options.s3 - A running fake server.
 * @param {Object} options.keys - Key module, see {@link fixedKeys}.
 * @param {string} [options.baseDir] - Reuse this directory.
 * @param {Object} [options.config] - Overrides for the S3 block.
 * @param {Object} [options.filesystem] - Extra filesystem provider options.
 * @param {Object} [options.env] - Environment for the backend.
 * @param {{enabled: boolean, plaintextReads: 'reject'|'accept'}} [options.encryption] -
 *   `storage.encryption` as the registry resolves it; on and strict by default.
 * @returns {Promise<{provider: ComposedStorageProvider, backend: Object, baseDir: string}>}
 *   Not initialized.
 */
export async function composeS3Provider({
  s3,
  keys,
  baseDir,
  config = {},
  filesystem = {},
  env = {},
  encryption = { enabled: true, plaintextReads: 'reject' }
}) {
  const dir = baseDir || (await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-s3-storage-')));
  const base = new FilesystemStorageProvider({
    baseDir: dir,
    flushIntervalMs: 25,
    fenceSweepIntervalMs: 0,
    // The switch as the registry hands it to the base provider
    // (`providerConfigWithEncryption`): documents and append logs follow it,
    // and `describeEncryption()` says what the S3 backend below does.
    encryption: {
      mode: encryption?.enabled === false ? 'off' : 'auto',
      loadKeys: async () => keys
    },
    ...filesystem
  });
  const backend = createS3BlobBackend(s3ConfigFor(s3, config), {
    platformConfig: {},
    locks: base.locks,
    env,
    encryption,
    loadKeys: async () => keys
  });
  return { provider: new ComposedStorageProvider({ base, backend }), backend, baseDir: dir };
}
