// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The default blob backend: the storage provider's own blob facet (the
 * filesystem blob store), behind the encrypting blob store.
 *
 * `storage.encryption.enabled` decides what a write stores:
 * - **on**: every blob is encrypted. Blobs that were stored before it was
 *   switched on are still plaintext and are read as they are, until
 *   `encryptExistingBlobs()` has converted them and the composition switches
 *   to strict reads (`plaintextReads: 'reject'`).
 * - **off**: blobs are stored as they are. A blob encrypted earlier is still
 *   decrypted. An installation that never had encryption on is served exactly
 *   as by the blob store alone: nothing is inspected, nothing needs a key.
 *
 * @module storage/localBlobBackend
 */
import crypto from 'node:crypto';
import logger from '../utils/logger.js';
import { FORMAT_ID } from '../crypto/streamingAead.js';
import { EncryptingBlobStore } from './EncryptingBlobStore.js';
import { DEFAULT_BLOB_BACKEND } from './blobBackends.js';
import { blobProbeError, runBlobProbe } from './blobProbe.js';
import { KeyUnavailableError, StorageError } from './errors.js';
import { INTERNAL_BLOB_NAMESPACE } from './namespaces.js';

const COMPONENT = 'BlobStorage';

/**
 * The key step of a blob storage check: a master key that exists and will
 * still exist after a restart.
 *
 * @param {Object} keys - The key module (`crypto/KeyProvider.js`).
 * @returns {Promise<string>} A sentence naming the key id and its source.
 * @throws {KeyUnavailableError} With `keyMissing: true`.
 */
export async function checkMasterKey(keys) {
  const master = await keys.ensureMasterKey();
  if (!master.initialized) {
    const error = new KeyUnavailableError(
      'No master key is available. Restore contents/.encryption-key from a backup or set ' +
        'TOKEN_ENCRYPTION_KEY; without it no encrypted blob can be read or written.'
    );
    error.keyMissing = true;
    throw error;
  }
  if (master.source === 'generated-unpersisted') {
    const error = new KeyUnavailableError(
      'The master key was generated for this run and could not be saved to ' +
        'contents/.encryption-key. Blobs written now would be unreadable after a restart. ' +
        'Make the contents directory writable or set TOKEN_ENCRYPTION_KEY.'
    );
    error.keyMissing = true;
    throw error;
  }
  return `key ${master.keyId} (${master.source})`;
}

/**
 * The round-trip step of a blob storage check: write, read, compare and
 * remove one object in the internal namespace.
 *
 * @param {import('./BlobStore.js').BlobStore} blobs - The store callers use.
 * @param {import('./BlobStore.js').BlobStore} inner - The store behind it,
 *   which removes the object without a lock.
 * @returns {Promise<void>}
 * @throws {StorageError} `probeCode: 'S3_PROBE_MISMATCH'` when it reads back differently.
 */
export async function blobRoundTrip(blobs, inner) {
  const key = `probe-${crypto.randomUUID()}`;
  const payload = crypto.randomBytes(64);
  try {
    await blobs.put(INTERNAL_BLOB_NAMESPACE, key, payload);
    const read = await blobs.get(INTERNAL_BLOB_NAMESPACE, key);
    if (!read || !read.data.equals(payload)) {
      const error = new StorageError('A test object did not read back as written', {
        code: 'IO_ERROR'
      });
      error.probeCode = 'S3_PROBE_MISMATCH';
      throw error;
    }
  } finally {
    await inner.deletePrefix(INTERNAL_BLOB_NAMESPACE, key).catch(() => {});
  }
}

/**
 * Build the default blob backend over a provider's blob facet.
 *
 * @param {import('./BlobStore.js').BlobStore} inner - The provider's blob facet.
 * @param {Object} context
 * @param {{enabled: boolean, plaintextReads: 'reject'|'accept'}} context.encryption
 * @param {() => Promise<Object>} context.loadKeys - Resolves with the key
 *   module (`crypto/KeyProvider.js`).
 * @returns {import('./blobBackends.js').BlobBackend}
 */
export function createLocalBlobBackend(inner, { encryption, loadKeys }) {
  const enabled = encryption?.enabled === true;
  /** @type {Object|null} */
  let keys = null;
  let initialized = false;
  let lastProbe = null;

  const blobs = new EncryptingBlobStore({
    inner,
    encryptWrites: enabled,
    plaintextReads: encryption?.plaintextReads || 'reject',
    // The filesystem store has no size limit of its own; none is added here.
    maxBlobBytes: Number.MAX_SAFE_INTEGER,
    keyProvider: () => {
      if (!keys) throw new Error('the blob storage has not been initialized');
      return keys.getKeyProvider();
    }
  });

  async function ensureKeyCheck() {
    keys = keys || (await loadKeys());
    await keys.ensureMasterKey();
    // No "objects but no key check" rule here: an installation that switches
    // encryption on has plaintext blobs and no key check object yet.
    return blobs.verifyKey({ create: true });
  }

  async function probe() {
    lastProbe = await runBlobProbe({
      provider: DEFAULT_BLOB_BACKEND,
      steps: enabled
        ? [
            {
              name: 'key',
              run: async () => {
                keys = keys || (await loadKeys());
                return checkMasterKey(keys);
              }
            },
            {
              name: 'keycheck',
              run: async () => `key check object ${(await ensureKeyCheck()).status}`
            },
            { name: 'roundtrip', run: () => blobRoundTrip(blobs, inner) }
          ]
        : []
    });
    return lastProbe;
  }

  async function initialize() {
    if (initialized) return;
    if (enabled) {
      const result = await probe();
      if (result.status !== 'ok') {
        logger.error('Blob storage check failed', {
          component: COMPONENT,
          provider: DEFAULT_BLOB_BACKEND,
          code: result.error.code,
          step: result.error.step,
          detail: result.error.detail
        });
        throw blobProbeError(result);
      }
      logger.info('Blob storage ready: blobs are encrypted before they are written', {
        component: COMPONENT,
        provider: DEFAULT_BLOB_BACKEND,
        plaintextReads: blobs.acceptsPlaintext
          ? 'accepted (blobs from before are converted)'
          : 'refused'
      });
    } else if (await blobs.detectEnvelopes()) {
      // Encryption was on before: those blobs still need the key. Not having
      // it is not a reason to refuse a start with encryption off.
      try {
        keys = await loadKeys();
        await keys.ensureMasterKey();
      } catch (error) {
        logger.warn('Encrypted blobs exist, but the master key could not be loaded', {
          component: COMPONENT,
          error: error.message
        });
      }
      await probe();
    } else {
      await probe();
    }
    initialized = true;
  }

  return {
    name: DEFAULT_BLOB_BACKEND,
    remote: false,
    blobs,
    initialize,
    probe,
    ensureKeyCheck,
    get lastProbe() {
      return lastProbe;
    },
    describe: () => ({
      provider: DEFAULT_BLOB_BACKEND,
      encryption: enabled
        ? { scope: 'all', format: FORMAT_ID, keyProvider: 'local-file' }
        : { scope: 'none' }
    }),
    shutdown: async () => {}
  };
}
