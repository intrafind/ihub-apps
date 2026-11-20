// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The blob step of `storage:encrypt` when a write does not go through: the
 * source stream of a blob is released whatever the write does, and a write
 * that failed because the store was unavailable for a moment is repeated by
 * reading the blob again, a bounded number of times.
 */
import './support/scratchContents.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixedKeys } from './support/blobTestSupport.js';

const { FilesystemBlobStore } =
  await import('../storage/providers/filesystem/FilesystemBlobStore.js');
const { EncryptingBlobStore, isBlobEnvelope } = await import('../storage/EncryptingBlobStore.js');
const { encryptExistingBlobs } = await import('../storage/encryptExistingBlobs.js');
const { StorageError } = await import('../storage/errors.js');
const keyModule = await import('../crypto/KeyProvider.js');

const NS = 'chat-files';
let scratch;
let counter = 0;

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-encrypt-blobs-'));
});

after(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

/**
 * A filesystem store with plaintext blobs that records every stream it
 * opens, and whose `putStream` can be made to fail.
 *
 * @param {Record<string, Buffer>} payloads
 * @returns {Promise<{inner: FilesystemBlobStore, opened: import('node:stream').Readable[],
 *   failWrites: (errors: Error[]) => void, writes: () => number}>}
 */
async function recordingStore(payloads) {
  counter += 1;
  const inner = new FilesystemBlobStore(path.join(scratch, `store-${counter}`));
  for (const [key, data] of Object.entries(payloads)) await inner.put(NS, key, data);
  const opened = [];
  const openRead = inner.openRead.bind(inner);
  inner.openRead = async (ns, key) => {
    const blob = await openRead(ns, key);
    if (blob) opened.push(blob.stream);
    return blob;
  };
  let failures = [];
  let writes = 0;
  const putStream = inner.putStream.bind(inner);
  inner.putStream = async (ns, key, stream, opts) => {
    writes += 1;
    const failure = failures.shift();
    if (!failure) return putStream(ns, key, stream, opts);
    // What a backend does with a request that fails part-way.
    stream.resume();
    await new Promise(resolve => setImmediate(resolve));
    stream.destroy();
    throw failure;
  };
  return {
    inner,
    opened,
    failWrites: errors => {
      failures = [...errors];
    },
    writes: () => writes
  };
}

const unavailable = () =>
  new StorageError('The bucket did not answer', { code: 'STORAGE_UNAVAILABLE' });

/** Every stream that was opened is closed, once the event loop had a turn. */
async function assertAllReleased(opened, label) {
  await new Promise(resolve => setTimeout(resolve, 50));
  const open = opened.filter(stream => !stream.destroyed).length;
  assert.equal(open, 0, `${label}: ${open} of ${opened.length} source streams were left open`);
}

describe('storage:encrypt blob step: the source stream is released', () => {
  const payloads = Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [`k${index}`, Buffer.alloc(2000, index)])
  );

  it('when the data key cannot be wrapped (the key provider is down)', async () => {
    const { inner, opened } = await recordingStore(payloads);
    const down = Object.assign(new Error('KMS unreachable'), {
      name: 'KeyAccessDenied',
      reason: 'not-initialized'
    });
    const failing = async () => {
      throw down;
    };
    const store = new EncryptingBlobStore({
      inner,
      plaintextReads: 'accept',
      keyProvider: { id: 'local', wrap: failing, unwrap: failing }
    });

    const result = await encryptExistingBlobs(store, { namespaces: [NS] });

    assert.equal(result.failed, 12);
    assert.equal(opened.length, 12);
    await assertAllReleased(opened, 'key provider down');
  });

  it('when the blob is over the limit', async () => {
    const { inner, opened } = await recordingStore(payloads);
    const store = new EncryptingBlobStore({
      inner,
      plaintextReads: 'accept',
      maxBlobBytes: 100,
      keyProvider: fixedKeys(keyModule).provider
    });

    const result = await encryptExistingBlobs(store, { namespaces: [NS] });

    assert.equal(result.failed, 12);
    assert.equal(opened.length, 12);
    await assertAllReleased(opened, 'over the limit');
  });
});

describe('storage:encrypt blob step: a write that failed for a moment is repeated', () => {
  const payload = crypto.randomBytes(1024 * 1024 + 4321);

  async function converting() {
    const recording = await recordingStore({ k: payload });
    const store = new EncryptingBlobStore({
      inner: recording.inner,
      plaintextReads: 'accept',
      keyProvider: fixedKeys(keyModule).provider
    });
    return { ...recording, store };
  }

  it('reads the blob again and converts it when the store was unavailable twice', async () => {
    const { inner, store, opened, failWrites, writes } = await converting();
    failWrites([unavailable(), unavailable()]);

    const result = await encryptExistingBlobs(store, { namespaces: [NS] });

    assert.equal(result.encrypted, 1);
    assert.equal(result.failed, 0);
    assert.equal(writes(), 3);
    assert.equal(opened.length, 3, 'the source was opened again for every attempt');
    const stored = await inner.get(NS, 'k');
    assert.equal(isBlobEnvelope(stored.data, stored.bytes), true);
    assert.ok((await store.get(NS, 'k')).data.equals(payload));
    await assertAllReleased(opened, 'after the retries');
  });

  it('gives up after three attempts and leaves the plaintext blob as it was', async () => {
    const { inner, store, opened, failWrites, writes } = await converting();
    failWrites([unavailable(), unavailable(), unavailable(), unavailable()]);

    const result = await encryptExistingBlobs(store, { namespaces: [NS] });

    assert.equal(result.encrypted, 0);
    assert.equal(result.failed, 1);
    assert.equal(result.remaining, 1);
    assert.equal(writes(), 3, 'a bounded number of attempts');
    assert.ok((await inner.get(NS, 'k')).data.equals(payload), 'still the plaintext');
    await assertAllReleased(opened, 'after giving up');
  });

  it('does not repeat a write that failed for another reason', async () => {
    const { store, failWrites, writes } = await converting();
    failWrites([new StorageError('The disk is full', { code: 'IO_ERROR' })]);

    const result = await encryptExistingBlobs(store, { namespaces: [NS] });

    assert.equal(result.failed, 1);
    assert.equal(writes(), 1);
  });
});
