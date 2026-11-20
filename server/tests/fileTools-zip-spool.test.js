// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `create_zip` builds its archive into a spool file
 * (`services/documents/files/fileTools.js`, `zipToFile` of
 * `services/artifacts/artifactZip.js`), with storage encryption on.
 *
 * - The archive is byte-valid and holds what the in-memory build held.
 * - Members stored in the chat are read as streams; the limits hold while the
 *   archive is written.
 * - The spool file is gone after success and after every failure.
 * - Building near the size limit holds about one archive in memory, not the
 *   members beside it.
 */
import './support/scratchContents.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import v8 from 'node:v8';
import vm from 'node:vm';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import configCache from '../configCache.js';
import { bootstrapStorage, shutdownStorageBootstrap } from '../storage/bootstrap.js';
import { getChatRepository } from '../services/chat/ChatRepository.js';
import { ZipLimitError, zipToBuffer, zipToFile } from '../services/artifacts/artifactZip.js';
import {
  MAX_GENERATED_FILE_BYTES,
  clearHeldGeneratedFiles,
  heldGeneratedFile
} from '../services/documents/generatedFiles.js';
import { runCreateFile, runCreateZip } from '../services/documents/files/fileTools.js';
import { ZIP_SPOOL_AREA, spoolRoot } from '../services/uploads/uploadSpool.js';

const ADA = { id: 'user-ada', name: 'Ada Lovelace', email: 'ada@example.com' };
const MIB = 1024 * 1024;
const ZIP_ROOT = spoolRoot(ZIP_SPOOL_AREA);

let baseDir;
let scratch;
let chatCounter = 0;

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-zip-spool-'));
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-zip-spool-files-'));
  await bootstrapStorage({
    storage: {
      provider: 'filesystem',
      filesystem: { baseDir, flushIntervalMs: 25 },
      encryption: { enabled: true }
    }
  });
  configCache.setCacheEntry('config/features.json', { chatPersistence: true });
});

after(async () => {
  await shutdownStorageBootstrap();
  const rm = dir => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await rm(baseDir);
  await rm(scratch);
});

beforeEach(() => {
  clearHeldGeneratedFiles();
  configCache.setCacheEntry('config/platform.json', { chats: { enabled: true } });
});

afterEach(() => {
  clearHeldGeneratedFiles();
});

/** The ZIP spool directories that exist right now. */
async function zipSpools() {
  try {
    return await fs.readdir(ZIP_ROOT);
  } catch {
    return [];
  }
}

/** Every file of an archive, as bytes. */
async function unzip(buffer) {
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  const files = {};
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir) files[name] = await entry.async('nodebuffer');
  }
  return files;
}

/** A stored chat of Ada's with the given artifacts (`{ name, data, mimeType?, kind? }`). */
async function chatWith(artifacts) {
  chatCounter += 1;
  const chatId = `zip-spool-chat-${chatCounter}`;
  const repository = getChatRepository();
  await repository.ensureChat({ chatId, ownerId: ADA.id, appId: 'chat', title: 'Zip' });
  const store = repository.artifactStore();
  const scope = repository.artifactScope(chatId);
  const stored = [];
  for (const artifact of artifacts) {
    const descriptor = await store.put(scope, {
      kind: artifact.kind || 'code',
      mimeType: artifact.mimeType || 'text/plain',
      data: artifact.data,
      name: artifact.name
    });
    assert.ok(descriptor?.id, `${artifact.name} was stored`);
    stored.push(descriptor);
  }
  return { chatId, store, scope, stored };
}

/** A forced garbage collection, also when the process was started without `--expose-gc`. */
const collect =
  globalThis.gc ||
  (() => {
    v8.setFlagsFromString('--expose-gc');
    return vm.runInNewContext('gc');
  })();

/** Peak growth of the memory Buffers live in while `work` runs. */
async function peakArrayBuffers(work) {
  for (let round = 0; round < 5; round += 1) {
    collect();
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  const held = () => {
    collect();
    return process.memoryUsage().arrayBuffers;
  };
  const before = held();
  let peak = before;
  const timer = setInterval(() => {
    peak = Math.max(peak, held());
  }, 150);
  try {
    const value = await work();
    peak = Math.max(peak, held());
    return { value, peak: peak - before };
  } finally {
    clearInterval(timer);
  }
}

describe('zipToFile', () => {
  it('writes the archive the in-memory build wrote', async () => {
    const date = '2026-03-04T05:06:07Z';
    const big = crypto.randomBytes(2 * MIB + 5);
    const entries = () => [
      { path: 'readme.md', data: Buffer.from('# Hello\n'), date },
      { path: 'data/big.bin', date, open: async () => Readable.from([big], { objectMode: false }) },
      { path: 'src/a.js', data: Buffer.from('export const a = 1;\n'), date }
    ];
    const file = path.join(scratch, 'same.zip');
    const built = await zipToFile(entries(), file);
    const onDisk = await fs.readFile(file);
    assert.equal(built.bytes, onDisk.length);
    assert.equal(built.contentBytes, 8 + big.length + 20);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    const inMemory = await zipToBuffer([
      { path: 'readme.md', data: Buffer.from('# Hello\n'), date },
      { path: 'data/big.bin', data: big, date },
      { path: 'src/a.js', data: Buffer.from('export const a = 1;\n'), date }
    ]);
    assert.deepEqual(await unzip(onDisk), await unzip(inMemory));
    assert.deepEqual(Object.keys(await unzip(onDisk)), ['readme.md', 'data/big.bin', 'src/a.js']);
  });

  it('stops writing when the archive passes its size limit', async () => {
    const file = path.join(scratch, 'too-large.zip');
    let opened = 0;
    const member = index => ({
      path: `m${index}.bin`,
      open: async () => {
        opened += 1;
        return Readable.from([crypto.randomBytes(MIB)], { objectMode: false });
      }
    });
    await assert.rejects(
      zipToFile(
        Array.from({ length: 12 }, (_, index) => member(index)),
        file,
        { maxArchiveBytes: 3 * MIB }
      ),
      error => {
        assert.ok(error instanceof ZipLimitError);
        assert.equal(error.code, 'too-large');
        assert.equal(error.limit, 'archive');
        return true;
      }
    );
    assert.ok((await fs.stat(file)).size <= 3 * MIB, 'nothing past the limit is on disk');
    assert.ok(opened < 12, `the remaining members were never opened (${opened} were)`);
  });

  it('stops when the members are larger than the content limit says', async () => {
    const file = path.join(scratch, 'content.zip');
    await assert.rejects(
      zipToFile(
        [
          { path: 'a.txt', data: Buffer.alloc(600, 'a') },
          {
            path: 'b.txt',
            // Recorded as small, larger when read.
            open: async () => Readable.from([Buffer.alloc(900, 'b')], { objectMode: false })
          }
        ],
        file,
        { maxContentBytes: 1000 }
      ),
      error => error instanceof ZipLimitError && error.code === 'too-large'
    );
  });

  it('fails, and closes the file, when a member breaks part-way', async () => {
    const file = path.join(scratch, 'broken.zip');
    const failing = new Readable({
      read() {
        this.push(Buffer.alloc(1000, 'x'));
        this.destroy(new Error('the store went away'));
      }
    });
    await assert.rejects(
      zipToFile([{ path: 'a.bin', open: async () => failing }], file),
      /the store went away/
    );
    // The handle is closed: the caller can remove the file.
    await fs.rm(file);
  });
});

describe('create_zip through the spool', () => {
  it('packs new files and stored artifacts into a valid archive, and removes the spool', async () => {
    const report = crypto.randomBytes(1 * MIB + 321);
    const { chatId, store, scope, stored } = await chatWith([
      { name: 'data/report.bin', data: report },
      { name: 'notes.md', data: Buffer.from('stored notes\n'), mimeType: 'text/markdown' }
    ]);
    const held = await runCreateFile({
      user: ADA,
      chatId,
      name: 'src/held.js',
      content: 'export const held = true;\n'
    });
    assert.equal(held.success, true, held.error);

    // A stored member is read as a stream, never whole.
    const calls = { get: 0, openRead: 0 };
    const realGet = store.get.bind(store);
    const realOpen = store.openRead.bind(store);
    store.get = (...args) => {
      calls.get += 1;
      return realGet(...args);
    };
    store.openRead = (...args) => {
      calls.openRead += 1;
      return realOpen(...args);
    };
    let result;
    try {
      result = await runCreateZip({
        user: ADA,
        chatId,
        filename: 'bundle',
        include: ['report.bin', stored[1].id, 'held.js'],
        files: [{ name: 'new/fresh.txt', content: 'fresh\n' }]
      });
    } finally {
      store.get = realGet;
      store.openRead = realOpen;
    }
    assert.equal(result.success, true, result.error);
    assert.deepEqual(calls, { get: 0, openRead: 2 });
    assert.equal(result.file.name, 'bundle.zip');
    assert.equal(result.file.mimeType, 'application/zip');
    assert.deepEqual([...result.entries].sort(), [
      'data/report.bin',
      'new/fresh.txt',
      'notes.md',
      'src/held.js'
    ]);
    assert.equal(result.files.length, 1);
    assert.match(result.message, /Created the ZIP archive "bundle\.zip" with 4 files/);

    const archive = heldGeneratedFile(ADA, result.file.id, { chatId });
    assert.equal(result.file.bytes, archive.data.length);
    const files = await unzip(archive.data);
    assert.ok(files['data/report.bin'].equals(report), 'the stored artifact is unchanged');
    assert.equal(files['notes.md'].toString(), 'stored notes\n');
    assert.equal(files['src/held.js'].toString(), 'export const held = true;\n');
    assert.equal(files['new/fresh.txt'].toString(), 'fresh\n');
    assert.deepEqual(await zipSpools(), [], 'the spool file is gone');
    assert.equal((await store.list(scope)).length, 2, 'the tool stored nothing itself');
  });

  it('still inlines the libraries of a stored HTML file', async () => {
    const { chatId } = await chatWith([
      {
        name: 'index.html',
        data: Buffer.from('<html><head><script data-ihub-lib="d3"></script></head></html>'),
        mimeType: 'text/html',
        kind: 'file'
      }
    ]);
    const result = await runCreateZip({
      user: ADA,
      chatId,
      filename: 'site',
      include: ['index.html']
    });
    assert.equal(result.success, true, result.error);
    const files = await unzip(heldGeneratedFile(ADA, result.file.id, { chatId }).data);
    assert.match(files['index.html'].toString(), /data-ihub-lib-inlined="d3@/);
    assert.deepEqual(await zipSpools(), []);
  });

  it('names a member that is gone, and removes the spool', async () => {
    const { chatId, store, stored } = await chatWith([
      { name: 'a.txt', data: Buffer.from('a') },
      { name: 'b.txt', data: Buffer.from('b') }
    ]);
    const realOpen = store.openRead.bind(store);
    // Deleted between the listing and its turn in the archive.
    store.openRead = (scope, id, ...rest) =>
      id === stored[1].id ? Promise.resolve(null) : realOpen(scope, id, ...rest);
    let result;
    try {
      result = await runCreateZip({
        user: ADA,
        chatId,
        filename: 'x',
        include: ['a.txt', 'b.txt']
      });
    } finally {
      store.openRead = realOpen;
    }
    assert.equal(result.success, false);
    assert.equal(result.code, 'not-found');
    assert.match(result.error, /"b\.txt" is no longer available\./);
    assert.deepEqual(await zipSpools(), []);
  });

  it('removes the spool when a member breaks while it is read', async () => {
    const { chatId, store } = await chatWith([
      { name: 'a.bin', data: crypto.randomBytes(300_000) }
    ]);
    const realOpen = store.openRead.bind(store);
    store.openRead = async (...args) => {
      const opened = await realOpen(...args);
      const broken = new Readable({
        read() {
          this.push(Buffer.alloc(1000));
          this.destroy(new Error('a later part does not verify'));
        }
      });
      opened.stream.destroy();
      return { ...opened, stream: broken };
    };
    let result;
    try {
      result = await runCreateZip({ user: ADA, chatId, filename: 'x', include: ['a.bin'] });
    } finally {
      store.openRead = realOpen;
    }
    assert.equal(result.success, false);
    assert.deepEqual(await zipSpools(), []);
  });

  it('refuses an archive the chat could not keep, with its size, and removes the spool', async () => {
    configCache.setCacheEntry('config/platform.json', {
      chats: { enabled: true },
      artifacts: { maxBytes: 1024 }
    });
    const result = await runCreateZip({
      user: ADA,
      chatId: 'zip-spool-unsaved',
      filename: 'big',
      files: [{ name: 'noise.txt', content: crypto.randomBytes(4096).toString('base64') }]
    });
    assert.equal(result.success, false);
    assert.equal(result.code, 'too-large');
    assert.match(result.error, /The archive is 0\.0 MB, over the 0\.0 MB a chat keeps per file/);
    assert.match(result.error, /split them/);
    assert.deepEqual(await zipSpools(), []);
  });

  it('keeps to maxZipFiles and maxZipBytes before anything is written', async () => {
    configCache.setCacheEntry('config/platform.json', {
      chats: { enabled: true },
      artifacts: { maxZipFiles: 1 }
    });
    const tooMany = await runCreateZip({
      user: ADA,
      chatId: 'zip-spool-unsaved',
      filename: 'x',
      files: [
        { name: 'a.txt', content: 'a' },
        { name: 'b.txt', content: 'b' }
      ]
    });
    assert.equal(tooMany.code, 'too-many-files');
    configCache.setCacheEntry('config/platform.json', {
      chats: { enabled: true },
      artifacts: { maxZipBytes: 10 }
    });
    const tooLarge = await runCreateZip({
      user: ADA,
      chatId: 'zip-spool-unsaved',
      filename: 'x',
      files: [{ name: 'a.txt', content: 'more than ten bytes' }]
    });
    assert.equal(tooLarge.code, 'too-large');
    assert.deepEqual(await zipSpools(), []);
  });

  it('holds about one archive in memory near the size limit', async t => {
    // Four stored members of 6 MiB each, incompressible: 24 MiB of content, an
    // archive just under the 25 MiB a generated file may have. (By default a
    // chat keeps at most 10 MB per file, `artifacts.maxBytes`; lifted here.)
    configCache.setCacheEntry('config/platform.json', {
      chats: { enabled: true },
      artifacts: { maxBytes: 0 }
    });
    const each = 6 * MIB;
    const { chatId } = await chatWith(
      [0, 1, 2, 3].map(index => ({ name: `m${index}.bin`, data: crypto.randomBytes(each) }))
    );
    const { value: result, peak } = await peakArrayBuffers(() =>
      runCreateZip({ user: ADA, chatId, filename: 'near-limit', includeAll: true })
    );
    assert.equal(result.success, true, result.error);
    t.diagnostic(
      `create_zip: archive ${(result.file.bytes / MIB).toFixed(1)} MiB, peak ${(peak / MIB).toFixed(1)} MiB held`
    );
    assert.ok(result.file.bytes > 4 * each && result.file.bytes <= MAX_GENERATED_FILE_BYTES);
    // The archive itself (24 MiB) is handed to the chat from memory. Built in
    // memory from members read whole, the same call held about twice that
    // while it ran: the members and the archive.
    assert.ok(
      peak < result.file.bytes + 16 * MIB,
      `peak ${(peak / MIB).toFixed(1)} MiB for an archive of ${(result.file.bytes / MIB).toFixed(1)} MiB`
    );
    assert.deepEqual(await zipSpools(), []);
  });
});
