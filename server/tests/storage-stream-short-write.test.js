// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A file system that takes fewer bytes than it was handed (a disk that fills
 * up inside a chunk): the streamed write must put the whole content in place
 * or nothing, and the blob conversion of `storage:encrypt` must never replace
 * a plaintext blob with a truncated envelope.
 *
 * The short writes are produced by wrapping `write` of the file handles the
 * scratch files are written through, so the tests need no full disk.
 */
import './support/scratchContents.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixedKeys } from './support/blobTestSupport.js';

const { atomicWriteStream, writeFully } = await import('../utils/atomicWrite.js');
const { FilesystemBlobStore } =
  await import('../storage/providers/filesystem/FilesystemBlobStore.js');
const { EncryptingBlobStore, isBlobEnvelope } = await import('../storage/EncryptingBlobStore.js');
const { encryptExistingBlobs } = await import('../storage/encryptExistingBlobs.js');
const keyModule = await import('../crypto/KeyProvider.js');

const NS = 'chat-files';
let scratch;
let restoreOpen = null;

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-short-write-'));
});

afterEach(() => {
  restoreOpen?.();
  restoreOpen = null;
});

after(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

/**
 * Make every scratch file of `atomicWrite` (`.tmp_…`) that is opened from now
 * on write through `write`, which gets the real write and its arguments.
 *
 * @param {(real: Function, buffer: Buffer, offset: number, length: number, position: number|null) => Promise<{bytesWritten: number}>} write
 */
function shortWrites(write) {
  const open = fs.open;
  fs.open = async function openWithShortWrites(file, ...rest) {
    const handle = await open.call(this, file, ...rest);
    if (!path.basename(String(file)).startsWith('.tmp_')) return handle;
    const real = handle.write.bind(handle);
    handle.write = (buffer, offset, length, position) => {
      const from = offset ?? 0;
      return write(real, buffer, from, length ?? buffer.length - from, position ?? null);
    };
    return handle;
  };
  restoreOpen = () => {
    fs.open = open;
  };
}

/** What `write(2)` does when the disk fills up inside the buffer: part of it, reported truthfully. */
const truthfulShort = limit => (real, buffer, offset, length, position) =>
  real(buffer, offset, Math.min(length, limit), position);

/** A file system that drops the tail of every write and reports all of it as written. */
const lyingShort = keep => async (real, buffer, offset, length, position) => {
  await real(buffer, offset, Math.min(length, keep), position);
  return { bytesWritten: length, buffer };
};

/** A file system that takes nothing more and says so without an error. */
const stuck = () => async (_real, buffer) => ({ bytesWritten: 0, buffer });

const streamOf = (buffer, pieceBytes = 70_001) => {
  const pieces = [];
  for (let offset = 0; offset < buffer.length; offset += pieceBytes) {
    pieces.push(buffer.subarray(offset, offset + pieceBytes));
  }
  return Readable.from(pieces, { objectMode: false });
};

/** The scratch files a failed write left in a directory. */
const leftovers = async dir =>
  (await fs.readdir(dir)).filter(name => name.startsWith('.tmp_')).sort();

describe('atomicWriteStream on a file system that writes short', () => {
  it('writes the rest of a chunk the file system took only part of', async () => {
    const target = path.join(scratch, 'whole.bin');
    const content = crypto.randomBytes(300_000);
    shortWrites(truthfulShort(1000));

    await atomicWriteStream(target, streamOf(content));

    assert.ok((await fs.readFile(target)).equals(content), 'the file holds every byte');
  });

  it('never renames a file that is shorter than what was handed in', async () => {
    const target = path.join(scratch, 'kept.bin');
    const previous = Buffer.from('the previous content');
    await fs.writeFile(target, previous);
    shortWrites(lyingShort(60_000));
    const source = streamOf(crypto.randomBytes(300_000));

    await assert.rejects(atomicWriteStream(target, source), { code: 'EIO' });

    assert.ok((await fs.readFile(target)).equals(previous), 'the target is as it was');
    assert.deepEqual(await leftovers(scratch), [], 'no scratch file is left');
  });

  it('fails instead of spinning when the file system takes nothing more', async () => {
    const target = path.join(scratch, 'stuck.bin');
    shortWrites(stuck());

    await assert.rejects(atomicWriteStream(target, streamOf(crypto.randomBytes(1000))), {
      code: 'EIO'
    });

    await assert.rejects(fs.access(target), { code: 'ENOENT' });
  });

  it('writeFully writes a string or a buffer to its end through a handle that writes short', async () => {
    const file = path.join(scratch, 'fully.txt');
    const text = `${'zeile äöü\n'.repeat(5000)}ende`;
    const handle = await fs.open(file, 'w');
    const real = handle.write.bind(handle);
    handle.write = (buffer, offset, length, position) =>
      real(buffer, offset, Math.min(length, 777), position);
    try {
      await writeFully(handle, 'kopf\n');
      await writeFully(handle, text);
      await writeFully(handle, Buffer.from('\nfuss'));
    } finally {
      await handle.close();
    }
    assert.equal(await fs.readFile(file, 'utf8'), `kopf\n${text}\nfuss`);
  });
});

describe('FilesystemBlobStore.putStream on a file system that writes short', () => {
  it('stores the whole blob, or rejects and keeps the previous one', async () => {
    const store = new FilesystemBlobStore(path.join(scratch, 'blobs-a'));
    const first = crypto.randomBytes(250_000);
    shortWrites(truthfulShort(4096));
    const ref = await store.putStream(NS, 'k', streamOf(first), { bytes: first.length });
    assert.equal(ref.sha256, crypto.createHash('sha256').update(first).digest('hex'));
    assert.ok((await store.get(NS, 'k')).data.equals(first));
    restoreOpen();

    shortWrites(lyingShort(100_000));
    const second = crypto.randomBytes(250_000);
    await assert.rejects(store.putStream(NS, 'k', streamOf(second), { bytes: second.length }));
    restoreOpen();
    restoreOpen = null;

    const kept = await store.get(NS, 'k');
    assert.equal(kept.bytes, first.length);
    assert.ok(kept.data.equals(first), 'a short file was not put in place of the blob');
  });
});

describe('storage:encrypt blob step on a file system that writes short', () => {
  /** A store with plaintext blobs and the encrypting store over it. */
  async function plaintextStore(name, payloads) {
    const inner = new FilesystemBlobStore(path.join(scratch, name));
    for (const [key, data] of Object.entries(payloads)) await inner.put(NS, key, data);
    const store = new EncryptingBlobStore({
      inner,
      plaintextReads: 'accept',
      keyProvider: fixedKeys(keyModule).provider
    });
    return { inner, store };
  }

  it('never replaces a plaintext blob with a truncated envelope', async () => {
    const payloads = {
      large: crypto.randomBytes(3 * 1024 * 1024 + 4321),
      small: crypto.randomBytes(900)
    };
    const { inner, store } = await plaintextStore('convert-lying', payloads);
    // Of every write only the first 512 bytes arrive: the envelope's header
    // is on disk, most of its content is not.
    shortWrites(lyingShort(512));

    const result = await encryptExistingBlobs(store, { namespaces: [NS] });
    restoreOpen();
    restoreOpen = null;

    assert.equal(result.encrypted, 0);
    assert.equal(result.failed, 2);
    assert.equal(result.remaining, 2);
    for (const [key, data] of Object.entries(payloads)) {
      const stored = await inner.get(NS, key);
      assert.ok(stored.data.equals(data), `${key}: the plaintext original is untouched`);
      assert.ok((await store.get(NS, key)).data.equals(data), `${key}: still readable`);
    }

    // The next run, on a file system that works, converts them.
    const again = await encryptExistingBlobs(store, { namespaces: [NS] });
    assert.equal(again.encrypted, 2);
    assert.equal(again.failed, 0);
    for (const [key, data] of Object.entries(payloads)) {
      const stored = await inner.get(NS, key);
      assert.equal(isBlobEnvelope(stored.data, stored.bytes), true, `${key} is sealed`);
      assert.ok((await store.get(NS, key)).data.equals(data), `${key} opens`);
    }
  });

  it('converts completely when the file system takes each chunk in parts', async () => {
    const payloads = { large: crypto.randomBytes(2 * 1024 * 1024 + 99) };
    const { inner, store } = await plaintextStore('convert-truthful', payloads);
    shortWrites(truthfulShort(50_000));

    const result = await encryptExistingBlobs(store, { namespaces: [NS] });
    restoreOpen();
    restoreOpen = null;

    assert.equal(result.encrypted, 1);
    assert.equal(result.failed, 0);
    const stored = await inner.get(NS, 'large');
    assert.equal(isBlobEnvelope(stored.data, stored.bytes), true);
    assert.ok((await store.get(NS, 'large')).data.equals(payloads.large));
  });
});
