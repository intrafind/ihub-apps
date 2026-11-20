// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Multipart uploads are spooled to disk, not held in memory
 * (`services/uploads/uploadSpool.js`, `services/chatFiles/fileUploadRequest.js`).
 *
 * - What is stored is what the in-memory path stored: bytes, hash, sizes,
 *   media type, page count and text — on the filesystem and on an encrypted
 *   S3 bucket.
 * - The spool file is gone after success, after every refusal and after a
 *   client that went away mid-upload; an oversized upload is cut while it is
 *   received.
 * - The spool directory is private (0700, file 0600, a name of its own), and
 *   the sweep removes what a crash left behind.
 */
import { contentsDir } from './support/scratchContents.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FilesystemStorageProvider } from '../storage/index.js';
import { ChatFileRepository } from '../services/chatFiles/ChatFileRepository.js';
import { ingestChatFile } from '../services/chatFiles/ChatFileService.js';
import { normalizeChatFilePolicy } from '../services/chatFiles/chatFilePolicy.js';
import {
  CHAT_UPLOAD_SPOOL_AREA,
  SPOOL_FILE_NAME,
  SPOOL_MAX_AGE_MS,
  newSpoolDir,
  removeSpoolDir,
  spoolRoot,
  startSpoolSweeper,
  stopSpoolSweeper,
  sweepSpoolDirs
} from '../services/uploads/uploadSpool.js';
import { ExtractionLimiter, setExtractionLimiter } from '../services/uploads/extractionLimiter.js';
import { startFakeS3Server } from './support/fakeS3Server.js';
import { composeS3Provider, fixedKeys } from './support/blobTestSupport.js';
import { postFile, startUploadApp, streamUpload } from './support/uploadTestApp.js';
import { buildPdfBytes } from './helpers/structuredPdf.js';
import { buildDocx, p } from './helpers/docxFile.js';

const keyModule = await import('../crypto/KeyProvider.js');
const MIB = 1024 * 1024;
const BUCKET = 'upload-spool';
const SPOOL_ROOT = spoolRoot(CHAT_UPLOAD_SPOOL_AREA);

const policyOf = (overrides = {}) =>
  normalizeChatFilePolicy({ enabled: true, storageMode: 'original_and_text', ...overrides });

/** The spool directories that exist right now. */
async function spoolDirs() {
  try {
    return (await fs.readdir(SPOOL_ROOT)).sort();
  } catch {
    return [];
  }
}

/** Wait until no spool directory is left; the names that stayed otherwise. */
async function spoolEmptied(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let left = await spoolDirs();
  while (left.length > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
    left = await spoolDirs();
  }
  return left;
}

let scopeCounter = 0;
const newScope = () => ({ type: 'chat', id: `chat-${(scopeCounter += 1)}` });

/** The fields of a descriptor that must not depend on how the file arrived. */
const comparable = descriptor => ({
  name: descriptor.name,
  mimeType: descriptor.mimeType,
  bytes: descriptor.bytes,
  textBytes: descriptor.textBytes,
  originalBytes: descriptor.originalBytes,
  hasOriginal: descriptor.hasOriginal,
  sha256: descriptor.sha256,
  pages: descriptor.pages,
  pageImageCount: descriptor.pageImageCount,
  truncated: descriptor.truncated,
  storageMode: descriptor.storageMode,
  origin: descriptor.origin
});

/** A text file of `bytes` bytes that is not one repeated block. */
function textFile(bytes) {
  const lines = [];
  let size = 0;
  for (let n = 0; size < bytes; n += 1) {
    const line = `Line ${n}: ${crypto.createHash('md5').update(String(n)).digest('hex')}\n`;
    lines.push(line);
    size += line.length;
  }
  return Buffer.from(lines.join('').slice(0, bytes));
}

/**
 * The same file through the spool (multipart over HTTP) and through the
 * in-memory path (a Buffer handed to the ingest): everything recorded and
 * everything stored must agree.
 */
async function assertSameAsBuffered({ store, url, bytes, filename, type, policy }) {
  const spooledScope = newScope();
  currentScope = spooledScope;
  const response = await postFile(url, bytes, { filename, type });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const spooled = response.body;

  const bufferedScope = newScope();
  const buffered = await ingestChatFile({
    scope: bufferedScope,
    ownerId: 'user-ada',
    name: filename,
    mimeType: type,
    buffer: bytes,
    policy,
    store
  });
  assert.deepEqual(comparable(spooled), comparable(buffered));

  const spooledText = await store.getText(spooledScope, spooled.id);
  const bufferedText = await store.getText(bufferedScope, buffered.id);
  assert.equal(spooledText.text, bufferedText.text);
  assert.deepEqual(spooledText.pageImages || null, bufferedText.pageImages || null);

  if (buffered.hasOriginal) {
    const original = await store.getOriginal(spooledScope, spooled.id);
    assert.ok(original.data.equals(bytes), 'the stored original is the uploaded file');
    assert.equal(
      spooled.sha256,
      crypto.createHash('sha256').update(bytes).digest('hex'),
      'sha256 is the hash of the plaintext original'
    );
    assert.equal(spooled.originalBytes, bytes.length);
  }
  assert.deepEqual(await spoolEmptied(), [], 'the spool file is gone after success');
  return { spooled, spooledScope };
}

let currentScope = newScope();
let currentPolicy = policyOf();

afterEach(() => {
  setExtractionLimiter(null);
  currentPolicy = policyOf();
});

describe('spooled uploads on the filesystem', () => {
  let baseDir;
  let provider;
  let store;
  let app;

  before(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-upload-spool-'));
    provider = new FilesystemStorageProvider({ baseDir });
    await provider.initialize();
    store = new ChatFileRepository({ documents: provider.documents, blobs: provider.blobs });
    app = await startUploadApp({ store, policy: () => currentPolicy, scope: () => currentScope });
  });

  after(async () => {
    await app.close();
    await provider.shutdown?.();
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('stores a text file exactly as the in-memory path did', async () => {
    await assertSameAsBuffered({
      store,
      url: app.url,
      bytes: textFile(3 * MIB + 17),
      filename: 'notes.txt',
      type: 'text/plain',
      policy: currentPolicy
    });
  });

  it('stores a Word file with the same media type and text', async () => {
    const docx = await buildDocx({ body: p('Mietvertrag') + p('Laufzeit: zwei Jahre') });
    const { spooled } = await assertSameAsBuffered({
      store,
      url: app.url,
      bytes: docx,
      filename: 'vertrag.docx',
      type: 'application/octet-stream',
      policy: currentPolicy
    });
    assert.match(spooled.mimeType, /wordprocessingml/);
  });

  it('stores a PDF with the same page count', async () => {
    const pdf = await buildPdfBytes([
      [{ text: 'First page', role: 'H1' }, { text: 'Some text on it.' }],
      [{ text: 'Second page' }],
      [{ text: 'Third page' }]
    ]);
    const { spooled } = await assertSameAsBuffered({
      store,
      url: app.url,
      bytes: pdf,
      filename: 'report.pdf',
      type: 'application/pdf',
      policy: currentPolicy
    });
    assert.equal(spooled.pages, 3);
    assert.equal(spooled.mimeType, 'application/pdf');
  });

  it('stores a scanned PDF (no text layer) with the same page images', async () => {
    const scanned = await buildPdfBytes([[], []]);
    const { spooled } = await assertSameAsBuffered({
      store,
      url: app.url,
      bytes: scanned,
      filename: 'scan.pdf',
      type: 'application/pdf',
      policy: currentPolicy
    });
    assert.equal(spooled.pages, 2);
    assert.equal(spooled.pageImageCount, 2);
  });

  it('keeps no original in server_text_only mode, and records the same hash', async () => {
    currentPolicy = policyOf({ storageMode: 'server_text_only' });
    const { spooled, spooledScope } = await assertSameAsBuffered({
      store,
      url: app.url,
      bytes: textFile(200_000),
      filename: 'notes.txt',
      type: 'text/plain',
      policy: currentPolicy
    });
    assert.equal(spooled.hasOriginal, false);
    const original = await store.getOriginal(spooledScope, spooled.id);
    assert.equal(original.data, null);
    assert.equal(original.originalDeleteReason, 'storage_mode');
  });

  it('spools into a private directory under the contents data temp area', async () => {
    const seen = {};
    const spy = {
      isAvailable: () => true,
      put: async (_scope, file) => {
        const filePath = file.originalFile.path;
        seen.filePath = filePath;
        seen.file = await fs.stat(filePath);
        seen.dir = await fs.stat(path.dirname(filePath));
        seen.root = await fs.stat(path.dirname(path.dirname(filePath)));
        seen.listing = await fs.readdir(path.dirname(filePath));
        return { id: 'spy', name: file.name };
      }
    };
    const spied = await startUploadApp({
      store: spy,
      policy: () => currentPolicy,
      scope: () => currentScope
    });
    try {
      const response = await postFile(spied.url, textFile(50_000), {
        filename: 'Geheimbericht Q3.txt'
      });
      assert.equal(response.status, 201);
    } finally {
      await spied.close();
    }
    assert.equal(seen.file.mode & 0o777, 0o600, 'the spool file is 0600');
    assert.equal(seen.dir.mode & 0o777, 0o700, 'its directory is 0700');
    assert.equal(seen.root.mode & 0o777, 0o700, 'the spool area is 0700');
    assert.equal(seen.file.size, 50_000);
    assert.deepEqual(seen.listing, [SPOOL_FILE_NAME]);
    assert.equal(
      path.dirname(path.dirname(seen.filePath)),
      path.join(contentsDir, 'data', 'tmp', CHAT_UPLOAD_SPOOL_AREA)
    );
    assert.doesNotMatch(seen.filePath, /Geheimbericht|Q3|\.txt/, 'the client name is not on disk');
    assert.match(path.basename(path.dirname(seen.filePath)), /^u-[A-Za-z0-9]{6}$/);
    assert.deepEqual(await spoolEmptied(), []);
  });

  it('removes the spool file after a validation error', async () => {
    const response = await postFile(app.url, Buffer.from('MZ\x90\x00binary'), {
      filename: 'setup.exe',
      type: 'application/x-msdownload'
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'UNSUPPORTED_TYPE');
    assert.deepEqual(await spoolEmptied(), []);
  });

  it('removes the spool file after a file that cannot be read', async () => {
    const response = await postFile(app.url, Buffer.from('%PDF-1.7\nnot a pdf at all'), {
      filename: 'broken.pdf',
      type: 'application/pdf'
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await spoolEmptied(), []);
  });

  it('removes the spool file after a quota error', async () => {
    currentPolicy = policyOf({ quotas: { maxChatBytes: 1000 } });
    currentScope = newScope();
    const response = await postFile(app.url, textFile(20_000));
    assert.equal(response.status, 413);
    assert.equal(response.body.code, 'QUOTA_CHAT_BYTES');
    assert.deepEqual(await spoolEmptied(), []);
    assert.deepEqual(await store.list(currentScope), [], 'nothing was stored');
  });

  it('removes the spool file after an exception in the store', async () => {
    const failing = {
      isAvailable: () => true,
      put: async () => {
        throw new Error('the disk is on fire');
      }
    };
    const broken = await startUploadApp({
      store: failing,
      policy: () => currentPolicy,
      scope: () => currentScope
    });
    try {
      const response = await postFile(broken.url, textFile(20_000));
      assert.equal(response.status, 500);
    } finally {
      await broken.close();
    }
    assert.deepEqual(await spoolEmptied(), []);
  });

  it('refuses an oversized upload while receiving, and keeps none of it', async () => {
    const limit = 1 * MIB;
    currentPolicy = policyOf({ quotas: { maxFileBytes: limit } });
    currentScope = newScope();
    // Watches the spool while the upload runs: the file must never grow past the limit.
    let largest = 0;
    let watching = true;
    const watcher = (async () => {
      while (watching) {
        for (const dir of await spoolDirs()) {
          const stat = await fs.stat(path.join(SPOOL_ROOT, dir, SPOOL_FILE_NAME)).catch(() => null);
          if (stat) largest = Math.max(largest, stat.size);
        }
        await new Promise(resolve => setImmediate(resolve));
      }
    })();
    const response = await streamUpload(app.port, 24 * MIB);
    watching = false;
    await watcher;
    assert.equal(response.status, 413);
    assert.equal(response.body.code, 'QUOTA_FILE_BYTES');
    assert.ok(largest <= limit + 1, `at most the limit was written (${largest} bytes)`);
    assert.deepEqual(await spoolEmptied(), []);
    assert.deepEqual(await store.list(currentScope), []);
  });

  it('removes the spool file when the client goes away mid-upload', async () => {
    currentScope = newScope();
    let dirsWhenStopped = [];
    const response = await streamUpload(app.port, 16 * MIB, {
      stopAfter: 6 * MIB,
      onStopped: () => {
        // Nothing awaited here: the listing is taken right after the cut.
        spoolDirs().then(dirs => {
          dirsWhenStopped = dirs;
        });
      }
    });
    assert.equal(response.status, null, 'the client got no response');
    assert.deepEqual(await spoolEmptied(), [], `left behind: ${dirsWhenStopped.join(', ')}`);
    assert.deepEqual(await store.list(currentScope), [], 'nothing was stored');
  });

  it('removes the spool file when the client goes away while its file waits to be read', async () => {
    const limiter = new ExtractionLimiter({ limits: () => ({ concurrency: 1, maxQueue: 5 }) });
    setExtractionLimiter(limiter);
    let release;
    const blocked = limiter.run(() => new Promise(resolve => (release = resolve)));
    currentScope = newScope();
    const controller = new AbortController();
    const form = new FormData();
    form.append('file', new Blob([textFile(100_000)], { type: 'text/plain' }), 'notes.txt');
    const pending = fetch(app.url, { method: 'POST', body: form, signal: controller.signal }).catch(
      error => error
    );
    // The upload is received and waits for the slot.
    while (limiter.stats().queued === 0) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await spoolDirs()).length, 1, 'the file waits on disk');
    controller.abort();
    await pending;
    assert.deepEqual(await spoolEmptied(), []);
    assert.equal(limiter.stats().queued, 0, 'it no longer waits for a slot');
    release();
    await blocked;
    assert.deepEqual(await store.list(currentScope), []);
  });

  it('answers a full extraction queue with a retryable 503 and Retry-After', async () => {
    const limiter = new ExtractionLimiter({ limits: () => ({ concurrency: 1, maxQueue: 0 }) });
    setExtractionLimiter(limiter);
    let release;
    const blocked = limiter.run(() => new Promise(resolve => (release = resolve)));
    currentScope = newScope();
    const bytes = textFile(40_000);
    const refused = await postFile(app.url, bytes);
    assert.equal(refused.status, 503);
    assert.equal(refused.body.code, 'UPLOAD_BUSY');
    assert.equal(refused.body.status, 503);
    assert.match(refused.headers.get('content-type'), /application\/problem\+json/);
    assert.ok(Number(refused.headers.get('retry-after')) >= 1, 'Retry-After in seconds');
    assert.ok(refused.body.details.retryAfterMs >= 1000);
    assert.deepEqual(await spoolEmptied(), [], 'the spool file is gone after the refusal');
    assert.deepEqual(await store.list(currentScope), []);

    release();
    await blocked;
    // The same request again, as the client would send it.
    const retried = await postFile(app.url, bytes);
    assert.equal(retried.status, 201);
  });

  it('applies the same cap to a JSON upload with base64 data', async () => {
    const limiter = new ExtractionLimiter({ limits: () => ({ concurrency: 1, maxQueue: 0 }) });
    setExtractionLimiter(limiter);
    let release;
    const blocked = limiter.run(() => new Promise(resolve => (release = resolve)));
    currentScope = newScope();
    const bytes = textFile(30_000);
    const send = () =>
      fetch(app.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'notes.txt',
          mimeType: 'text/plain',
          data: bytes.toString('base64')
        })
      });
    const refused = await send();
    assert.equal(refused.status, 503);
    assert.equal((await refused.json()).code, 'UPLOAD_BUSY');
    assert.ok(Number(refused.headers.get('retry-after')) >= 1);
    release();
    await blocked;
    const stored = await send();
    assert.equal(stored.status, 201);
    const descriptor = await stored.json();
    assert.equal(descriptor.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    const original = await store.getOriginal(currentScope, descriptor.id);
    assert.ok(original.data.equals(bytes));
  });
});

describe('spooled uploads on encrypted S3', () => {
  let s3;
  let composed;
  let store;
  let app;

  before(async () => {
    s3 = await startFakeS3Server({ buckets: [BUCKET] });
    composed = await composeS3Provider({
      s3,
      keys: fixedKeys(keyModule),
      config: { bucket: BUCKET }
    });
    await composed.provider.initialize();
    store = new ChatFileRepository({
      documents: composed.provider.documents,
      blobs: composed.provider.blobs
    });
    app = await startUploadApp({ store, policy: () => currentPolicy, scope: () => currentScope });
  });

  after(async () => {
    await app.close();
    await composed.provider.shutdown?.();
    await s3.close();
    await fs.rm(composed.baseDir, { recursive: true, force: true });
  });

  it('stores the same bytes, hash and text, encrypted in the bucket', async () => {
    const bytes = textFile(5 * MIB + 333);
    const marker = bytes.subarray(1000, 1064);
    await assertSameAsBuffered({
      store,
      url: app.url,
      bytes,
      filename: 'notes.txt',
      type: 'text/plain',
      policy: currentPolicy
    });
    const keys = s3.rawObjects(BUCKET);
    assert.ok(keys.length > 0, 'the bucket holds the blobs');
    for (const { key } of keys) {
      const body = s3.rawGet(BUCKET, key);
      assert.equal(body.subarray(0, 4).toString('ascii'), 'IHB1', `${key} is encrypted`);
      assert.equal(body.indexOf(marker), -1, `${key} holds no plaintext of the upload`);
    }
  });

  it('stores a PDF with the same page count', async () => {
    const pdf = await buildPdfBytes([[{ text: 'One' }], [{ text: 'Two' }]]);
    const { spooled } = await assertSameAsBuffered({
      store,
      url: app.url,
      bytes: pdf,
      filename: 'report.pdf',
      type: 'application/pdf',
      policy: currentPolicy
    });
    assert.equal(spooled.pages, 2);
  });
});

describe('spool sweep', () => {
  let root;

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-spool-sweep-'));
  });

  after(async () => {
    stopSpoolSweeper();
    await fs.rm(root, { recursive: true, force: true });
  });

  /** A spool directory as a crashed process left it: on disk, known to nobody. */
  async function leftover(base, name, ageMs) {
    const dir = path.join(base, name);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(dir, SPOOL_FILE_NAME), 'plaintext of an upload', { mode: 0o600 });
    const when = new Date(Date.now() - ageMs);
    await fs.utimes(dir, when, when);
    return dir;
  }

  it('removes old leftovers and leaves fresh ones', async () => {
    const old = await leftover(root, 'u-old001', SPOOL_MAX_AGE_MS + 60_000);
    const fresh = await leftover(root, 'u-new001', 60_000);
    const removed = await sweepSpoolDirs(root);
    assert.equal(removed, 1);
    await assert.rejects(fs.stat(old), { code: 'ENOENT' });
    assert.ok(await fs.stat(path.join(fresh, SPOOL_FILE_NAME)));
    await fs.rm(fresh, { recursive: true, force: true });
  });

  it('keeps a directory this process is using, whatever its age', async () => {
    const dir = await newSpoolDir(root);
    const when = new Date(Date.now() - 2 * SPOOL_MAX_AGE_MS);
    await fs.utimes(dir, when, when);
    assert.equal(await sweepSpoolDirs(root), 0);
    assert.ok(await fs.stat(dir));
    await removeSpoolDir(dir);
    await assert.rejects(fs.stat(dir), { code: 'ENOENT' });
  });

  it('does nothing when the area does not exist', async () => {
    assert.equal(await sweepSpoolDirs(path.join(root, 'missing')), 0);
  });

  it('sweeps the upload and ZIP spool areas at start-up', async () => {
    const upload = await leftover(SPOOL_ROOT, 'u-crash1', SPOOL_MAX_AGE_MS + 1000);
    const zip = await leftover(spoolRoot('zip-spool'), 'u-crash2', SPOOL_MAX_AGE_MS + 1000);
    const fresh = await leftover(SPOOL_ROOT, 'u-fresh1', 1000);
    const removed = await startSpoolSweeper({ intervalMs: 60 * 60 * 1000 });
    stopSpoolSweeper();
    assert.equal(removed, 2);
    await assert.rejects(fs.stat(upload), { code: 'ENOENT' });
    await assert.rejects(fs.stat(zip), { code: 'ENOENT' });
    assert.ok(await fs.stat(fresh));
    await fs.rm(fresh, { recursive: true, force: true });
  });
});
