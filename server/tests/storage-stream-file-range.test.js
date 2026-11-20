// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A file that is read as a stream delivers exactly the number of bytes that
 * was announced for it, or fails: when it is replaced while it is opened
 * (an agent rewriting its report during a download), and when it turns out
 * shorter than its size said.
 */
import './support/scratchContents.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixedKeys } from './support/blobTestSupport.js';

const { fileRangeStream } = await import('../utils/fileRangeStream.js');
const { atomicWriteFile } = await import('../utils/atomicWrite.js');
const sealedFiles = await import('../storage/atRest/sealedFiles.js');
const { isSealedFile } = await import('../crypto/fileSeal.js');
const { FilesystemBlobStore } =
  await import('../storage/providers/filesystem/FilesystemBlobStore.js');
const keyModule = await import('../crypto/KeyProvider.js');

const STORE = 'agent-artifacts';
const NAME = 'run1/report.md';
let scratch;

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-file-range-'));
});

afterEach(() => {
  sealedFiles.resetSealedFiles();
});

after(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

/** Read a stream to its end; never rejects. */
async function drain(stream) {
  const chunks = [];
  try {
    for await (const chunk of stream) chunks.push(chunk);
    return { data: Buffer.concat(chunks), error: null };
  } catch (error) {
    return { data: Buffer.concat(chunks), error };
  }
}

/** Whether a file handle is closed. */
async function isClosed(handle) {
  try {
    await handle.stat();
    return false;
  } catch (error) {
    return error.code === 'EBADF';
  }
}

describe('fileRangeStream', () => {
  it('delivers the range and closes the handle at its end', async () => {
    const file = path.join(scratch, 'range.bin');
    const content = crypto.randomBytes(300_000);
    await fs.writeFile(file, content);

    for (const [start, end] of [
      [0, content.length],
      [512, content.length],
      [1000, 1001],
      [70_000, 70_000]
    ]) {
      const handle = await fs.open(file, 'r');
      const read = await drain(fileRangeStream(handle, { start, end, chunkBytes: 64_000 }));
      assert.equal(read.error, null);
      assert.ok(read.data.equals(content.subarray(start, end)), `${start} to ${end}`);
      assert.equal(await isClosed(handle), true, 'the handle is closed');
    }
  });

  it('closes the handle when the reader leaves early', async () => {
    const file = path.join(scratch, 'left.bin');
    await fs.writeFile(file, crypto.randomBytes(500_000));
    const handle = await fs.open(file, 'r');
    const stream = fileRangeStream(handle, { end: 500_000, chunkBytes: 1000 });
    await new Promise(resolve => stream.once('data', resolve));
    stream.destroy();
    await new Promise(resolve => stream.once('close', resolve));
    assert.equal(await isClosed(handle), true);
  });

  it('fails, and does not end, when the file is shorter than the range', async () => {
    const file = path.join(scratch, 'short.bin');
    await fs.writeFile(file, Buffer.alloc(1000, 1));
    const handle = await fs.open(file, 'r');
    const mapped = new Error('mapped');
    const stream = fileRangeStream(handle, {
      end: 5000,
      mapError: error => Object.assign(mapped, { cause: error })
    });
    let ended = false;
    stream.once('end', () => (ended = true));

    const read = await drain(stream);

    assert.equal(read.error, mapped);
    assert.equal(read.error.cause.code, 'ERR_FILE_SHORTER_THAN_EXPECTED');
    assert.equal(ended, false);
    assert.equal(read.data.length, 1000);
    assert.equal(await isClosed(handle), true);
  });
});

describe('openSealedStream: the announced length and the bytes are one file', () => {
  /**
   * Download a file again and again while it is replaced by files of another
   * length, as `agents/runtime/artifactStore.js` replaces an artifact.
   *
   * @param {string} file
   * @param {(index: number) => Promise<Buffer>} version - What the writer puts there.
   * @returns {Promise<{reads: number, wrong: string[], errors: string[]}>}
   */
  async function downloadWhileReplaced(file, version) {
    await atomicWriteFile(file, await version(0));
    let stop = false;
    const writer = (async () => {
      for (let index = 1; !stop; index += 1) await atomicWriteFile(file, await version(index));
    })();
    const wrong = [];
    const errors = [];
    let reads = 0;
    try {
      // Until the file was replaced often enough between two reads for an
      // open that looks at the path twice to have met two different files.
      for (; reads < 1500; reads += 1) {
        const opened = await sealedFiles.openSealedStream(STORE, NAME, file);
        const read = await drain(opened.stream);
        if (read.error) errors.push(`${read.error.code}: ${read.error.message}`);
        else if (read.data.length !== opened.bytes) {
          wrong.push(`announced ${opened.bytes}, delivered ${read.data.length}`);
        }
      }
    } finally {
      stop = true;
      await writer;
    }
    return { reads, wrong, errors };
  }

  it('for a plaintext file that is replaced while it is downloaded', async () => {
    sealedFiles.configureSealedFiles({ enabled: false });
    const file = path.join(scratch, 'report-plain.md');
    const versions = [Buffer.alloc(10, 97), Buffer.alloc(200_000, 98)];

    const outcome = await downloadWhileReplaced(file, async index => versions[index % 2]);

    assert.deepEqual(outcome.errors.slice(0, 3), []);
    assert.deepEqual(
      outcome.wrong.slice(0, 3),
      [],
      `${outcome.wrong.length} of ${outcome.reads} downloads had another length than announced`
    );
  });

  it('for a sealed file that is replaced while it is downloaded', async () => {
    sealedFiles.configureSealedFiles({
      enabled: true,
      keyProvider: fixedKeys(keyModule).provider
    });
    const file = path.join(scratch, 'report-sealed.md');
    const versions = [
      await sealedFiles.sealForDisk(STORE, NAME, Buffer.alloc(10, 97)),
      await sealedFiles.sealForDisk(STORE, NAME, Buffer.alloc(200_000, 98))
    ];
    assert.equal(isSealedFile(versions[0]), true, 'the file is sealed on disk');

    const outcome = await downloadWhileReplaced(file, async index => versions[index % 2]);

    // The header of one version with the body of the other would not verify.
    assert.deepEqual(
      outcome.errors.slice(0, 3),
      [],
      `${outcome.errors.length} of ${outcome.reads} downloads failed`
    );
    assert.deepEqual(outcome.wrong.slice(0, 3), []);
  });

  it('fails the stream when a plaintext file turns out shorter than announced', async () => {
    sealedFiles.configureSealedFiles({ enabled: false });
    const file = path.join(scratch, 'report-cut.md');
    await fs.writeFile(file, Buffer.alloc(600_000, 97));

    const opened = await sealedFiles.openSealedStream(STORE, NAME, file);
    assert.equal(opened.bytes, 600_000);
    // Cut in place (never done by the stores themselves, which rename).
    await fs.truncate(file, 1000);
    const read = await drain(opened.stream);

    assert.ok(read.error, 'the stream must not end as if the file were complete');
    assert.ok(read.data.length < 600_000);
  });
});

describe('FilesystemBlobStore.openRead: a blob that turns out shorter than reported', () => {
  it('fails the stream with IO_ERROR instead of ending it short', async () => {
    const dir = path.join(scratch, 'blobs');
    const store = new FilesystemBlobStore(dir);
    const payload = crypto.randomBytes(3 * 1024 * 1024);
    await store.put('chat-files', 'k', payload);

    const opened = await store.openRead('chat-files', 'k');
    assert.equal(opened.bytes, payload.length);
    await fs.truncate(path.join(dir, 'blobs', 'chat-files', 'k'), 1024 * 1024 + 5);
    const read = await drain(opened.stream);

    assert.equal(read.error?.name, 'StorageError');
    assert.equal(read.error.code, 'IO_ERROR');
    assert.ok(read.data.equals(payload.subarray(0, read.data.length)), 'a true prefix');

    // A blob that is replaced (a rename) while it is read is read to its end as it was.
    await store.put('chat-files', 'k', payload);
    const again = await store.openRead('chat-files', 'k');
    await store.put('chat-files', 'k', Buffer.from('replaced'));
    const whole = await drain(again.stream);
    assert.equal(whole.error, null);
    assert.ok(whole.data.equals(payload));
  });
});
