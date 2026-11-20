// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * One-time encryption of blobs that were stored in plaintext before
 * `storage.encryption.enabled` was switched on.
 *
 * It walks the declared blob namespaces of an encrypting store's inner store,
 * leaves every object that already is an envelope alone, and writes every
 * other object back through the encrypting store, at the same key. A blob is
 * replaced in one step by the inner store (a rename on the filesystem, one
 * `PutObject` on S3), so a reader sees the plaintext or the ciphertext, never
 * a mix; the store must accept plaintext reads while this runs.
 *
 * Idempotent and resumable: a run that was interrupted is simply run again
 * and skips what is already encrypted. When a run reports `failed: 0` and
 * `remaining: 0`, the store holds no plaintext blob in those namespaces and
 * can be switched to the strict mode.
 *
 * It does not record its completion and nothing calls it at start-up: where
 * that is recorded, and when the store turns strict, is decided together with
 * the encryption of documents and append logs.
 *
 * **Run it while nothing overwrites existing blob keys.** Between reading a
 * plaintext blob and writing its ciphertext there is no compare-and-set, so a
 * `put` to the same key in that moment would be replaced by the older
 * content. Blobs are written once under fresh keys almost everywhere; the
 * exceptions (the URL list of a website corpus) make "the server is not
 * serving" the safe time.
 *
 * @module storage/encryptExistingBlobs
 */
import logger from '../utils/logger.js';
import { ENVELOPE_HEADER_BYTES, decodeHeader } from '../crypto/blobEnvelope.js';
import { isBlobEnvelope } from './EncryptingBlobStore.js';
import { StorageError } from './errors.js';
import { BLOB_NAMESPACES } from './namespaces.js';

const COMPONENT = 'BlobEncryption';

/**
 * Encrypt the plaintext blobs of a store in place.
 *
 * @param {import('./EncryptingBlobStore.js').EncryptingBlobStore} store - A
 *   store that encrypts its writes.
 * @param {Object} [options]
 * @param {string[]} [options.namespaces] - Namespaces to walk; every
 *   `BLOB_NAMESPACES` value by default. A store cannot list its namespaces,
 *   so one that is not named is not converted.
 * @param {boolean} [options.dryRun=false] - Count only, write nothing.
 * @param {AbortSignal} [options.signal] - Stop before the next blob.
 * @param {Iterable<string>} [options.knownKeyIds] - The ids of the master keys
 *   this installation holds. An encrypted blob that names another one is
 *   counted in `foreign`: it was written by another installation or under a
 *   key that is gone, and this installation cannot read it.
 * @param {(progress: {namespace: string, key: string, action: 'encrypted'|'skipped'|'failed'}) => void} [options.onProgress]
 * @returns {Promise<{scanned: number, encrypted: number, alreadyEncrypted: number,
 *   failed: number, remaining: number, aborted: boolean, foreign: number,
 *   plaintextBytes: number, largestBytes: number,
 *   namespaces: Record<string, {scanned: number, encrypted: number, alreadyEncrypted: number, failed: number}>}>}
 *   `remaining` is the number of plaintext blobs still there: the failed ones,
 *   or in a dry run all that would be encrypted. `plaintextBytes` and
 *   `largestBytes` are the stored sizes of the blobs found in plaintext.
 * @throws {StorageError} Code `NOT_SUPPORTED` when the store does not encrypt writes.
 *
 * @example
 * const result = await encryptExistingBlobs(provider.blobs);
 * if (result.remaining === 0 && !result.aborted) {
 *   // every declared namespace is encrypted; the store may turn strict
 * }
 */
export async function encryptExistingBlobs(
  store,
  {
    namespaces = Object.values(BLOB_NAMESPACES),
    dryRun = false,
    signal,
    onProgress,
    knownKeyIds = null
  } = {}
) {
  if (!store?.encryptsWrites || !store.inner) {
    throw new StorageError('encryptExistingBlobs needs a blob store that encrypts its writes', {
      code: 'NOT_SUPPORTED'
    });
  }
  const inner = store.inner;
  const totals = { scanned: 0, encrypted: 0, alreadyEncrypted: 0, failed: 0 };
  const perNamespace = {};
  const known = knownKeyIds ? new Set(knownKeyIds) : null;
  let aborted = false;
  let foreign = 0;
  let plaintextBytes = 0;
  let largestBytes = 0;

  for (const namespace of namespaces) {
    const counts = { scanned: 0, encrypted: 0, alreadyEncrypted: 0, failed: 0 };
    perNamespace[namespace] = counts;
    for await (const item of inner.scan(namespace)) {
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      counts.scanned += 1;
      let action;
      try {
        const head =
          typeof inner.readHead === 'function'
            ? await inner.readHead(namespace, item.key, ENVELOPE_HEADER_BYTES)
            : (await inner.get(namespace, item.key))?.data;
        if (!head) continue; // deleted since it was listed
        if (isBlobEnvelope(head, item.bytes)) {
          counts.alreadyEncrypted += 1;
          action = 'skipped';
          if (known && !known.has(decodeHeader(head).keyId)) foreign += 1;
        } else {
          if (!dryRun) {
            const plain = await inner.get(namespace, item.key);
            if (!plain) continue;
            // Read again in full: decide on the bytes that are written back.
            if (!isBlobEnvelope(plain.data)) await store.put(namespace, item.key, plain.data);
          }
          counts.encrypted += 1;
          plaintextBytes += item.bytes || 0;
          largestBytes = Math.max(largestBytes, item.bytes || 0);
          action = 'encrypted';
        }
      } catch (error) {
        counts.failed += 1;
        action = 'failed';
        logger.warn('A blob could not be encrypted in place', {
          component: COMPONENT,
          ns: namespace,
          key: item.key,
          code: error?.code,
          error: error?.message
        });
      }
      onProgress?.({ namespace, key: item.key, action });
    }
    for (const name of Object.keys(totals)) totals[name] += counts[name];
    if (aborted) break;
  }
  return {
    ...totals,
    remaining: totals.failed + (dryRun ? totals.encrypted : 0),
    aborted,
    foreign,
    plaintextBytes,
    largestBytes,
    namespaces: perNamespace
  };
}
