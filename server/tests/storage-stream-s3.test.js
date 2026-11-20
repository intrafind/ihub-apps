// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Streamed reads and writes against S3 (`S3BlobStore.openRead` / `putStream`
 * under the encrypting blob store), on the in-repo fake S3 server: what
 * happens to the request when the reader leaves, when the body stalls or is
 * cut, when the object was changed in the bucket, and how much memory a
 * 100 MiB object takes.
 */
import './support/scratchContents.js';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeS3Server } from './support/fakeS3Server.js';
import { startFakeS3Process } from './support/fakeS3Process.js';
import { composeS3Provider, fixedKeys } from './support/blobTestSupport.js';

const scratch = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-s3-stream-'));
const keyModule = await import('../crypto/KeyProvider.js');
const { ENVELOPE_HEADER_BYTES, ENVELOPE_SEGMENT_BYTES, storedLength } =
  await import('../crypto/blobEnvelope.js');
const { boundedBodyStream } = await import('../storage/providers/s3/s3BodyStream.js');
const { FilesystemBlobStore } =
  await import('../storage/providers/filesystem/FilesystemBlobStore.js');
const { copyBlobs, openLocalBlobReader } = await import('../storage/commands/copyBlobs.js');

const BUCKET = 'ihub-test';
const NS = 'chat-files';
const SEGMENT = ENVELOPE_SEGMENT_BYTES;
const FIRST = SEGMENT - 56;
const NEXT = SEGMENT - 16;
const MIB = 1024 * 1024;

let s3;
const open = [];

before(async () => {
  s3 = await startFakeS3Server({ buckets: [BUCKET] });
});

afterEach(async () => {
  s3.clearInjections();
  s3.clearRequests();
  while (open.length > 0)
    await open
      .pop()()
      .catch(() => {});
});

after(async () => {
  await s3.close();
  await fs.rm(scratch, { recursive: true, force: true });
});

async function started({ config = {}, ...options } = {}) {
  const prefix = `s-${crypto.randomBytes(5).toString('hex')}`;
  const composed = await composeS3Provider({
    s3,
    keys: fixedKeys(keyModule),
    ...options,
    config: { maxAttempts: 1, ...config, prefix }
  });
  open.push(async () => {
    await composed.provider.shutdown();
    await fs.rm(composed.baseDir, { recursive: true, force: true });
  });
  await composed.provider.initialize();
  return { ...composed, prefix, blobs: composed.provider.blobs };
}

function within(promise, ms, what) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`HANG: ${what} did not settle within ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Read a stream to its end; never rejects. */
async function drain(stream) {
  const chunks = [];
  let ended = false;
  stream.once('end', () => {
    ended = true;
  });
  try {
    for await (const chunk of stream) chunks.push(chunk);
    return { data: Buffer.concat(chunks), error: null, ended };
  } catch (error) {
    return { data: Buffer.concat(chunks), error, ended };
  }
}

function streamOf(buffer, pieceBytes = 70_001) {
  const pieces = [];
  for (let offset = 0; offset < buffer.length; offset += pieceBytes) {
    pieces.push(buffer.subarray(offset, offset + pieceBytes));
  }
  return Readable.from(pieces, { objectMode: false });
}

const unavailable = error => error?.name === 'StorageError' && error.code === 'STORAGE_UNAVAILABLE';
const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('S3 streamed read: the request follows the reader', () => {
  it('aborts the download when the reader leaves early', async () => {
    const { blobs } = await started();
    const payload = crypto.randomBytes(8 * MIB);
    await blobs.put(NS, 'k', payload);
    s3.clearRequests();
    s3.inject({ op: 'GetObject', meterBody: true });

    const opened = await blobs.openRead(NS, 'k');
    const first = await new Promise((resolve, reject) => {
      opened.stream.once('data', resolve);
      opened.stream.once('error', reject);
    });
    opened.stream.destroy();
    await settle(400);

    assert.ok(first.equals(payload.subarray(0, first.length)));
    const gets = s3.requests.filter(request => request.op === 'GetObject');
    assert.equal(gets.length, 1, 'one request, not one per segment');
    assert.equal(gets[0].bodyComplete, false, 'the whole object was downloaded');
    assert.ok(
      gets[0].bodyBytesSent < payload.length / 2,
      `${gets[0].bodyBytesSent} of ${storedLength(payload.length)} bytes were taken after the reader left`
    );
    // The store is as usable as before: nothing is left half-read on a pooled socket.
    assert.ok((await blobs.get(NS, 'k')).data.equals(payload));
  });

  it('does not download ahead of a reader that takes nothing', async () => {
    const { blobs } = await started();
    // Large against what the sockets of a loopback connection buffer by
    // themselves (several MiB), which the server counts as sent.
    const payload = crypto.randomBytes(48 * MIB);
    await blobs.put(NS, 'k', payload);
    s3.clearRequests();
    s3.inject({ op: 'GetObject', meterBody: true });

    const opened = await blobs.openRead(NS, 'k');
    await settle(400);

    const [request] = s3.requests.filter(entry => entry.op === 'GetObject');
    assert.equal(request.bodyComplete, false);
    assert.ok(
      request.bodyBytesSent < 24 * MIB,
      `${request.bodyBytesSent} bytes were taken although nothing was read`
    );
    const read = await drain(opened.stream);
    assert.equal(read.error, null);
    assert.ok(read.data.equals(payload));
  });

  it('refuses an oversized object by its declared length and does not download it', async () => {
    const LIMIT = 200_000;
    const PLANTED = 48 * MIB;
    const { blobs, prefix } = await started({ config: { maxObjectBytes: LIMIT } });
    s3.rawPut(BUCKET, `${prefix}/default/${NS}/planted`, Buffer.alloc(PLANTED, 7));
    s3.clearRequests();
    s3.inject({ op: 'GetObject', meterBody: true });
    await assert.rejects(within(blobs.openRead(NS, 'planted'), 8000, 'openRead'), {
      code: 'BLOB_TOO_LARGE'
    });
    await settle(300);
    const request = s3.requests.find(entry => entry.op === 'GetObject');
    assert.equal(request.bodyComplete, false);
    assert.ok(request.bodyBytesSent < PLANTED / 2);
  });
});

describe('S3 streamed read: a body that stalls or is cut', () => {
  const TIMEOUT = 400;

  it('rejects the open when the body stalls before the first segment', async () => {
    const { blobs } = await started({ config: { requestTimeoutMs: TIMEOUT } });
    await blobs.put(NS, 'k', crypto.randomBytes(3 * MIB));
    s3.inject({ op: 'GetObject', stallBody: 1000 });
    const startedAt = Date.now();
    await assert.rejects(within(blobs.openRead(NS, 'k'), 5000, 'openRead'), unavailable);
    assert.ok(Date.now() - startedAt < 3000, 'within the bound');
  });

  it('fails the stream, within the bound, when the body stalls further in', async () => {
    const { blobs } = await started({ config: { requestTimeoutMs: TIMEOUT } });
    const payload = crypto.randomBytes(3 * MIB);
    await blobs.put(NS, 'k', payload);
    s3.inject({ op: 'GetObject', stallBody: ENVELOPE_HEADER_BYTES + 2 * SEGMENT + 5000 });

    const opened = await within(blobs.openRead(NS, 'k'), 5000, 'openRead');
    const startedAt = Date.now();
    const read = await within(drain(opened.stream), 5000, 'the stalled stream');

    assert.ok(unavailable(read.error), `${read.error?.name}: ${read.error?.message}`);
    assert.equal(read.ended, false);
    assert.ok(Date.now() - startedAt < 3000, 'within the bound');
    // Two whole segments and the start of a third arrived: the two are known
    // not to be the last and were handed out, nothing of the third.
    assert.ok(read.data.equals(payload.subarray(0, FIRST + NEXT)));
  });

  it('fails the stream as STORAGE_UNAVAILABLE when the connection is cut mid-body', async () => {
    const { blobs } = await started();
    const payload = crypto.randomBytes(3 * MIB);
    await blobs.put(NS, 'k', payload);
    for (const cut of [
      600,
      ENVELOPE_HEADER_BYTES + SEGMENT + 100,
      storedLength(payload.length) - 1
    ]) {
      s3.inject({ op: 'GetObject', truncateBody: cut, times: 1 });
      let read;
      try {
        const opened = await within(blobs.openRead(NS, 'k'), 8000, `open, cut at ${cut}`);
        read = await within(drain(opened.stream), 8000, `stream, cut at ${cut}`);
      } catch (error) {
        read = { error, data: Buffer.alloc(0), ended: false };
      }
      assert.ok(
        unavailable(read.error),
        `cut at ${cut}: ${read.error?.name}: ${read.error?.message}`
      );
      assert.equal(read.ended, false, `cut at ${cut}`);
      assert.ok(read.data.length < payload.length);
      assert.ok(
        read.data.equals(payload.subarray(0, read.data.length)),
        `cut at ${cut}: a true prefix`
      );
    }
    assert.ok((await drain((await blobs.openRead(NS, 'k')).stream)).data.equals(payload));
  });

  it('fails the stream as CORRUPT_BLOB when the object was changed in the bucket', async () => {
    const { blobs, prefix } = await started();
    const payload = crypto.randomBytes(FIRST + 2 * NEXT + 1000);
    await blobs.put(NS, 'k', payload);
    const name = `${prefix}/default/${NS}/k`;
    const stored = s3.rawGet(BUCKET, name);
    const changed = Buffer.from(stored);
    changed[ENVELOPE_HEADER_BYTES + 2 * SEGMENT + 77] ^= 0x01;
    for (const [label, object, genuine] of [
      ['a byte flipped in the third segment', changed, FIRST + NEXT],
      ['shortened to two segments', stored.subarray(0, ENVELOPE_HEADER_BYTES + 2 * SEGMENT), FIRST]
    ]) {
      s3.rawPut(BUCKET, name, object);
      const opened = await blobs.openRead(NS, 'k');
      const read = await within(drain(opened.stream), 8000, label);
      assert.equal(read.error?.code, 'CORRUPT_BLOB', `${label}: ${read.error?.message}`);
      assert.equal(read.ended, false, label);
      assert.ok(read.data.equals(payload.subarray(0, genuine)), label);
    }
  });
});

describe('S3 response body stream: its bounds count waiting, not the reader', () => {
  /** A body whose chunks the test hands out by hand. */
  function manualBody() {
    const body = new Readable({ read() {} });
    return body;
  }
  const bounds = {
    mapError: error => error,
    timeoutError: message => Object.assign(new Error(message), { name: 'TimeoutError' }),
    lengthError: message => Object.assign(new Error(message), { name: 'LengthError' })
  };

  it('ends a read that gets nothing for the idle time', async () => {
    const body = manualBody();
    const stream = boundedBodyStream(body, { bytes: 10, idleMs: 60, budgetMs: null, ...bounds });
    body.push(Buffer.from('12345'));
    const startedAt = Date.now();
    const read = await drain(stream);
    assert.equal(read.error?.name, 'TimeoutError');
    assert.ok(Date.now() - startedAt < 1000);
    assert.equal(body.destroyed, true, 'the request is ended');
    assert.equal(read.data.toString(), '12345');
  });

  it('ends a read whose waiting adds up to more than the budget, however steadily it trickles', async () => {
    const body = manualBody();
    const stream = boundedBodyStream(body, { bytes: 1000, idleMs: 200, budgetMs: 150, ...bounds });
    const trickle = setInterval(() => body.push(Buffer.from('x')), 20);
    const startedAt = Date.now();
    const read = await drain(stream);
    clearInterval(trickle);
    assert.equal(read.error?.name, 'TimeoutError');
    assert.match(read.error.message, /waiting/);
    assert.ok(Date.now() - startedAt < 1000);
    assert.ok(read.data.length > 0 && read.data.length < 1000);
  });

  it('does not count the time a reader takes for itself', async () => {
    const body = manualBody();
    const stream = boundedBodyStream(body, { bytes: 6, idleMs: 80, budgetMs: 120, ...bounds });
    // More than the reader's buffer takes at once, so the body is paused.
    body.push(Buffer.from('abc'));
    const first = await new Promise(resolve =>
      stream.once('readable', () => resolve(stream.read()))
    );
    assert.equal(first.toString(), 'abc');
    // The reader now asks for nothing for longer than both bounds…
    stream.pause();
    await settle(30);
    body.push(Buffer.from('def'));
    body.push(null);
    await settle(250);
    // …and still gets the rest.
    const read = await drain(stream);
    assert.equal(read.error, null);
    assert.equal(read.data.toString(), 'def');
  });

  it('fails for a body that is shorter or longer than declared, and for one that just closes', async () => {
    for (const [label, feed] of [
      ['shorter', body => (body.push(Buffer.from('ab')), body.push(null))],
      ['longer', body => body.push(Buffer.from('abcdef'))],
      ['closed', body => (body.push(Buffer.from('ab')), body.destroy())]
    ]) {
      const body = manualBody();
      const stream = boundedBodyStream(body, { bytes: 4, ...bounds });
      feed(body);
      const read = await drain(stream);
      assert.equal(read.error?.name, 'LengthError', label);
      assert.equal(read.ended, false, label);
    }
  });
});

describe('S3 streamed write', () => {
  it('sends one PutObject with the stored length, and reads back as put would have written it', async () => {
    const { blobs, prefix } = await started();
    const payload = crypto.randomBytes(FIRST + NEXT + 4321);
    s3.clearRequests();

    const ref = await blobs.putStream(NS, 'k', streamOf(payload), { bytes: payload.length });

    assert.deepEqual(ref, {
      key: 'k',
      bytes: payload.length,
      sha256: crypto.createHash('sha256').update(payload).digest('hex')
    });
    const puts = s3.requests.filter(request => request.op === 'PutObject');
    assert.equal(puts.length, 1, 'no multipart upload');
    assert.equal(puts[0].headers['content-length'], String(storedLength(payload.length)));
    assert.equal(puts[0].headers['transfer-encoding'], undefined, 'not chunked');
    const stored = s3.rawGet(BUCKET, `${prefix}/default/${NS}/k`);
    assert.equal(stored.length, storedLength(payload.length));
    assert.equal(
      stored.includes(payload.subarray(0, 32)),
      false,
      'the payload is not in the bucket'
    );
    assert.ok((await blobs.get(NS, 'k')).data.equals(payload));
  });

  it('is sent once: a failed request rejects, is not repeated, and stores nothing', async () => {
    const { blobs, prefix } = await started({ config: { maxAttempts: 3 } });
    const payload = crypto.randomBytes(300_000);
    s3.clearRequests();
    s3.inject({ op: 'PutObject', status: 503, code: 'SlowDown', times: 1 });
    const source = streamOf(payload);
    await assert.rejects(
      within(blobs.putStream(NS, 'k', source, { bytes: payload.length }), 8000, 'putStream'),
      unavailable
    );
    assert.equal(s3.requests.filter(request => request.op === 'PutObject').length, 1);
    assert.equal(source.destroyed, true);
    assert.equal(s3.rawGet(BUCKET, `${prefix}/default/${NS}/k`), null);
    // The buffered put of the same store does retry.
    s3.inject({ op: 'PutObject', status: 503, code: 'SlowDown', times: 1 });
    await blobs.put(NS, 'k', payload);
  });

  it('ends the request, and stores nothing, when the source fails or is short', async () => {
    const { blobs, prefix } = await started();
    const broken = new Error('the source broke');
    const failing = Readable.from(
      (async function* source() {
        yield crypto.randomBytes(200_000);
        throw broken;
      })(),
      { objectMode: false }
    );
    await assert.rejects(
      within(blobs.putStream(NS, 'k', failing, { bytes: 2 * MIB }), 5000, 'a failing source'),
      error => error === broken
    );
    await assert.rejects(
      within(
        blobs.putStream(NS, 'k', streamOf(crypto.randomBytes(100_000)), { bytes: 100_001 }),
        5000,
        'a short source'
      ),
      { code: 'INVALID_DATA' }
    );
    await settle(100);
    assert.equal(s3.rawGet(BUCKET, `${prefix}/default/${NS}/k`), null);
    await blobs.put(NS, 'k', 'usable afterwards');
    assert.equal((await blobs.get(NS, 'k')).data.toString(), 'usable afterwards');
  });

  it('the copy command sends a blob again when its transfer failed for a moment', async () => {
    const { blobs } = await started();
    const dir = await fs.mkdtemp(path.join(scratch, 'local-'));
    const local = new FilesystemBlobStore(dir, { keyPrefixSegments: {} });
    const payload = crypto.randomBytes(FIRST + 5000);
    await local.put(NS, 'big', payload);
    await local.put(NS, 'small', Buffer.from('small'));
    s3.inject({ op: 'PutObject', status: 503, code: 'SlowDown', times: 1 });

    const result = await copyBlobs({
      source: openLocalBlobReader(local, () => fixedKeys(keyModule).provider),
      target: blobs,
      namespaces: [NS]
    });

    assert.equal(result.copied, 2, JSON.stringify(result.failures));
    assert.equal(result.failed, 0);
    assert.equal(result.bytes, payload.length + 5);
    assert.ok((await blobs.get(NS, 'big')).data.equals(payload));
    const again = await copyBlobs({
      source: openLocalBlobReader(local, () => fixedKeys(keyModule).provider),
      target: blobs,
      namespaces: [NS]
    });
    assert.equal(again.alreadyPresent, 2);
    assert.equal(again.copied, 0);
  });
});

describe('S3 streamed blobs: memory', () => {
  // The object is 100 MiB (the default cap of an artifact ZIP). Read whole it
  // is held twice (the stored object and the payload); as a stream it is held
  // a few segments at a time. The S3 server and the measured code run in two
  // further processes, so neither this test's buffers nor the server's copy
  // of the object are counted.
  const BYTES = 100 * MIB;
  const BOUND = 16 * SEGMENT;

  function runProbe(server, modes) {
    const probe = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'support',
      'streamMemoryProbe.js'
    );
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--expose-gc', probe], {
        env: {
          ...process.env,
          PROBE_S3_ENDPOINT: server.endpoint,
          PROBE_S3_BUCKET: server.bucket,
          PROBE_S3_ACCESS_KEY: server.accessKeyId,
          PROBE_S3_SECRET_KEY: server.secretAccessKey,
          PROBE_BYTES: String(BYTES),
          PROBE_MODES: modes
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => (stdout += chunk));
      child.stderr.on('data', chunk => (stderr += chunk));
      child.once('error', reject);
      child.once('exit', code => {
        const line = stdout.split('\n').find(text => text.startsWith('{"bytes"'));
        if (code !== 0 || !line) {
          return void reject(new Error(`The probe failed (${code}): ${stderr.slice(-2000)}`));
        }
        resolve(JSON.parse(line));
      });
    });
  }

  it('streams a 100 MiB sealed object in and out holding a few segments', async () => {
    const server = await startFakeS3Process({ dataDir: path.join(scratch, 'memory-bucket') });
    let result;
    try {
      result = await runProbe(server, 'stream,buffer');
    } finally {
      await server.close();
    }
    const mib = bytes => `${(bytes / MIB).toFixed(1)} MiB`;
    assert.equal(result.stream.intact, true, 'what was read is what was written');
    assert.ok(
      result.stream.read.peakBytes < BOUND,
      `the streamed read held ${mib(result.stream.read.peakBytes)}; the bound is ${mib(BOUND)}`
    );
    assert.ok(
      result.stream.write.peakBytes < BOUND,
      `the streamed write held ${mib(result.stream.write.peakBytes)}; the bound is ${mib(BOUND)}`
    );
    // The same probe sees the buffered calls hold the object, so a low number
    // above is not a probe that measures nothing.
    assert.equal(result.buffer.intact, true);
    assert.ok(result.buffer.read.peakBytes >= BYTES, mib(result.buffer.read.peakBytes));
    assert.ok(result.buffer.write.peakBytes >= BYTES, mib(result.buffer.write.peakBytes));
  });
});
