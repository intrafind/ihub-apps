// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * One-time encryption of blobs that were stored in plaintext before
 * `storage.encryption.enabled` was switched on.
 *
 * It walks the declared blob namespaces of an encrypting store's inner store,
 * leaves every object that already is an envelope alone, and writes every
 * other object back through the encrypting store, at the same key, as a
 * stream: no blob is held in memory, whatever its size. A blob is
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
import { Readable } from 'node:stream';
import logger from '../utils/logger.js';
import { ENVELOPE_HEADER_BYTES, decodeHeader } from '../crypto/blobEnvelope.js';
import { isBlobEnvelope } from './EncryptingBlobStore.js';
import { StorageError } from './errors.js';
import { BLOB_NAMESPACES } from './namespaces.js';

const COMPONENT = 'BlobEncryption';

/** A blob that was replaced between the look at it and its conversion; the next run sees it again. */
const changedMeanwhile = () =>
  new StorageError('The blob changed while it was being encrypted', { code: 'IO_ERROR' });

/**
 * A blob's stream that fails unless it starts with the bytes the blob was
 * judged by: what is encrypted is the object that was found in plaintext,
 * not one that replaced it since (which may be an envelope already).
 *
 * @param {import('node:stream').Readable} stream - The stored blob.
 * @param {Buffer} head - Its first bytes, as read before.
 * @returns {import('node:stream').Readable}
 */
function sameHead(stream, head) {
  async function* checked() {
    let seen = 0;
    for await (const chunk of stream) {
      if (seen < head.length) {
        const overlap = Math.min(chunk.length, head.length - seen);
        if (!chunk.subarray(0, overlap).equals(head.subarray(seen, seen + overlap))) {
          throw changedMeanwhile();
        }
        seen += overlap;
      }
      yield chunk;
    }
  }
  const out = Readable.from(checked(), { objectMode: false });
  // A write that is refused before it reads (the key cannot be wrapped, the
  // blob is over the limit) destroys `out` without ever starting the
  // generator, whose loop is what would release the source. Tied together
  // here, so the open file or the bucket request never outlives the wrapper.
  out.once('close', () => stream.destroy());
  return out;
}

/** How often one blob is sent before it is counted as failed. */
const WRITE_ATTEMPTS = 3;

/**
 * Write one plaintext blob back through the encrypting store, as a stream.
 *
 * A streamed write is sent once by the backend (a stream cannot be rewound),
 * so the retries a buffered `put` gets from the S3 client are made here, by
 * opening the source again: a transient failure of the bucket does not leave
 * the blob in plaintext until the next run. Only `STORAGE_UNAVAILABLE` is
 * tried again, at most {@link WRITE_ATTEMPTS} times in all.
 *
 * @param {import('./EncryptingBlobStore.js').EncryptingBlobStore} store
 * @param {string} namespace
 * @param {{key: string, bytes: number}} item - The blob as it was listed.
 * @param {Buffer} head - Its first bytes, by which it was judged plaintext.
 * @returns {Promise<boolean>} False when the blob is gone.
 * @throws {StorageError} `IO_ERROR` when the blob changed since it was looked
 *   at; else what the write failed with.
 */
async function encryptBlob(store, namespace, item, head) {
  for (let attempt = 1; ; attempt += 1) {
    // The stream reads the object as it was when it was opened, also while
    // its replacement is written to the same key.
    const plain = await store.inner.openRead(namespace, item.key);
    if (!plain) return false;
    if (plain.bytes !== item.bytes) {
      plain.stream.destroy();
      throw changedMeanwhile();
    }
    try {
      await store.putStream(namespace, item.key, sameHead(plain.stream, head), {
        bytes: plain.bytes
      });
      return true;
    } catch (error) {
      // Released by `putStream` already; again for a store that did not.
      plain.stream.destroy();
      if (attempt >= WRITE_ATTEMPTS || error?.code !== 'STORAGE_UNAVAILABLE') throw error;
    }
  }
}

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
            // As a stream, so the largest blob needs no more memory than the
            // smallest.
            if (!(await encryptBlob(store, namespace, item, head))) continue;
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
