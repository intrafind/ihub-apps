// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What happens when the bucket is not there, refuses, hangs or lies.
 *
 * Two levels:
 * - the storage provider in this process, on the in-repo fake S3 server with
 *   failures injected: every blob call must reject with a storage error within
 *   a bounded time, and must never answer "not found", return short data or
 *   write to local disk instead;
 * - the real server process (`server/server.js`) on a scratch contents
 *   directory: it must end with a non-zero exit code when the blob storage
 *   cannot be used at start, and must not have written a blob to disk.
 *
 * `storage-s3-blobstore.test.js` already covers the classification of a failed
 * `get` (403 codes, 5xx with retry, a response that never comes) and the
 * start-up check of the backend object. This file covers the other calls, the
 * bucket going away at runtime, bodies that stall or lie about their length,
 * and the process.
 *
 * Every call that could hang runs under {@link within}: a hang fails the test
 * with a clear message instead of timing out the job.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeS3Server } from './support/fakeS3Server.js';
import { composeS3Provider, fixedKeys, s3ConfigFor } from './support/blobTestSupport.js';
import {
  findFreePort,
  localBlobFiles,
  seedContents,
  startServer,
  writeStorageConfig
} from './support/serverProcess.js';

const scratch = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-s3-failures-'));
process.env.CONTENTS_DIR = path.join(scratch, 'contents');
const keyModule = await import('../crypto/KeyProvider.js');
const { ENVELOPE_HEADER_BYTES: HEADER_BYTES } = await import('../crypto/blobEnvelope.js');
const { S3BlobStore, sendBudgetMs } = await import('../storage/providers/s3/S3BlobStore.js');
const { LockTimeoutError } = await import('../storage/errors.js');

const BUCKET = 'ihub-test';
/** A secret that would be recognisable in an error or a log line. The fake accepts any. */
const SECRET = `SECRET-CANARY-${crypto.randomBytes(8).toString('hex')}`;

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

const newPrefix = () => `f-${crypto.randomBytes(5).toString('hex')}`;

/** An initialized composed provider on a fresh prefix of `server` (the shared fake by default). */
async function started({ server = s3, config = {}, ...options } = {}) {
  const prefix = config.prefix ?? newPrefix();
  const composed = await composeS3Provider({
    s3: server,
    keys: fixedKeys(keyModule),
    ...options,
    config: { secretAccessKey: SECRET, ...config, prefix }
  });
  open.push(async () => {
    await composed.provider.shutdown();
    await fs.rm(composed.baseDir, { recursive: true, force: true });
  });
  await composed.provider.initialize();
  return { ...composed, prefix, blobs: composed.provider.blobs };
}

/**
 * Settle with `promise`, or reject when it has not settled in time.
 *
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} what - For the failure message.
 * @returns {Promise<T>}
 * @template T
 */
function within(promise, ms, what) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`HANG: ${what} did not settle within ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Everything of an error a log line or an API answer could carry. */
function everythingOf(error) {
  const parts = [];
  for (let current = error, depth = 0; current && depth < 6; current = current.cause, depth++) {
    parts.push(String(current.message), String(current.stack), JSON.stringify(current));
  }
  return parts.join('\n');
}

/** Assert a rejection is the storage error for `probeCode`, and holds no secret. */
function storageFailure(probeCode, { code = 'STORAGE_UNAVAILABLE' } = {}) {
  return error => {
    assert.equal(error.name, 'StorageError', `${error.name}: ${error.message}`);
    assert.equal(error.code, code, error.message);
    assert.equal(error.probeCode, probeCode, error.message);
    const text = everythingOf(error);
    assert.equal(text.includes(SECRET), false, 'the secret access key is in the error');
    assert.equal(/AWS4-HMAC-SHA256|Signature=/.test(text), false, 'a signature is in the error');
    return true;
  };
}

/** The five calls of the facet, each as a thunk, against a key that exists. */
const calls = blobs => ({
  put: () => blobs.put('chat-files', 'new', 'payload'),
  get: () => blobs.get('chat-files', 'k'),
  list: () => blobs.list('chat-files'),
  delete: () => blobs.delete('chat-files', 'k'),
  deletePrefix: () => blobs.deletePrefix('chat-files', 'k')
});

describe('S3 blob backend: the bucket goes away while the server runs', () => {
  it('rejects every call with STORAGE_UNAVAILABLE, writes nothing to disk, and recovers without a restart', async () => {
    const port = await findFreePort();
    const dataDir = path.join(scratch, `own-${crypto.randomBytes(3).toString('hex')}`);
    let own = await startFakeS3Server({ port, buckets: [BUCKET], dataDir });
    open.push(() => own.close());
    const { blobs, baseDir, provider } = await started({
      server: own,
      config: { maxAttempts: 1, connectTimeoutMs: 1000, requestTimeoutMs: 2000 }
    });
    await blobs.put('chat-files', 'k', 'kept in the bucket');

    await own.close();
    for (const [name, call] of Object.entries(calls(blobs))) {
      await assert.rejects(
        within(call(), 8000, name),
        storageFailure('S3_ENDPOINT_UNREACHABLE'),
        name
      );
    }
    assert.equal(fsSync.existsSync(path.join(baseDir, 'blobs')), false, 'no local blob copy');
    assert.equal((await provider.healthCheck()).status, 'degraded');

    // The same endpoint comes back with what it held.
    own = await startFakeS3Server({ port, buckets: [BUCKET], dataDir });
    open.push(() => own.close());
    assert.equal(
      (await within(blobs.get('chat-files', 'k'), 8000, 'get after recovery')).data.toString(),
      'kept in the bucket'
    );
    assert.equal((await blobs.put('chat-files', 'new', 'payload')).bytes, 7);
    assert.equal(await blobs.delete('chat-files', 'k'), true);
    assert.equal((await provider.healthCheck()).status, 'ok');
  });
});

describe('S3 blob backend: refused requests are errors, never "not there"', () => {
  it('rejects put, list, delete and deletePrefix on 403 and leaves the object alone', async () => {
    const { blobs, prefix } = await started({ config: { maxAttempts: 1 } });
    await blobs.put('chat-files', 'k', 'x');
    const name = `${prefix}/default/chat-files/k`;
    const cases = [
      ['put', 'PutObject', () => blobs.put('chat-files', 'new', 'payload')],
      ['list', 'ListObjectsV2', () => blobs.list('chat-files')],
      [
        'scan',
        'ListObjectsV2',
        async () => {
          for await (const item of blobs.scan('chat-files')) void item;
        }
      ],
      // HeadObject succeeds, DeleteObject is refused: not "true", not "false".
      ['delete', 'DeleteObject', () => blobs.delete('chat-files', 'k')],
      // The listing succeeds, the deletes are refused: not a count.
      ['deletePrefix', 'DeleteObject', () => blobs.deletePrefix('chat-files', 'k')],
      [
        'deletePrefix (listing refused)',
        'ListObjectsV2',
        () => blobs.deletePrefix('chat-files', 'k')
      ]
    ];
    for (const [label, op, call] of cases) {
      const release = s3.inject({ op, status: 403, code: 'AccessDenied' });
      try {
        await assert.rejects(
          within(call(), 8000, label),
          storageFailure('S3_ACCESS_DENIED'),
          label
        );
      } finally {
        release();
      }
      assert.ok(s3.rawGet(BUCKET, name), `${label}: the object is still in the bucket`);
    }
    assert.equal(s3.rawGet(BUCKET, `${prefix}/default/chat-files/new`), null);
  });

  it('rejects put, get, list and deletePrefix when the bucket is gone, and never creates one', async () => {
    const own = await startFakeS3Server({ buckets: [BUCKET] });
    open.push(() => own.close());
    const { blobs, baseDir } = await started({ server: own, config: { maxAttempts: 1 } });
    await blobs.put('chat-files', 'k', 'x');
    own.removeBucket(BUCKET);
    own.clearRequests();
    for (const [name, call] of Object.entries(calls(blobs))) {
      if (name === 'delete') continue; // its own test, below
      await assert.rejects(within(call(), 8000, name), storageFailure('S3_BUCKET_NOT_FOUND'), name);
    }
    assert.deepEqual(
      own.requests.filter(request => request.op === 'CreateBucket'),
      []
    );
    assert.equal(fsSync.existsSync(path.join(baseDir, 'blobs')), false, 'no local blob copy');
  });

  // `delete` asks HeadObject first. A HEAD answer has no body, so a 404 for a
  // missing BUCKET looks like one for a missing key; the store confirms with
  // HeadBucket before it answers "nothing to delete". A caller that sweeps or
  // claims by `delete` must not take a lost bucket for an empty one.
  it('delete rejects when the bucket is gone instead of answering "nothing to delete"', async () => {
    const own = await startFakeS3Server({ buckets: [BUCKET] });
    open.push(() => own.close());
    const { blobs } = await started({ server: own, config: { maxAttempts: 1 } });
    await blobs.put('chat-files', 'k', 'x');
    own.removeBucket(BUCKET);
    await assert.rejects(
      within(blobs.delete('chat-files', 'k'), 8000, 'delete'),
      storageFailure('S3_BUCKET_NOT_FOUND')
    );
  });

  it('delete of a key that is not there answers false after asking for the bucket', async () => {
    const { blobs } = await started({ config: { maxAttempts: 1 } });
    s3.clearRequests();
    assert.equal(await blobs.delete('chat-files', 'never-written'), false);
    assert.deepEqual(
      s3.requests.map(request => request.op),
      ['HeadObject', 'HeadBucket']
    );
  });
});

describe('S3 blob backend: a server that does not answer', () => {
  const TIMEOUT = 400;

  it('throws for every call within the request timeout instead of hanging', async () => {
    const { blobs } = await started({ config: { maxAttempts: 1, requestTimeoutMs: TIMEOUT } });
    await blobs.put('chat-files', 'k', 'x');
    const cases = [
      ['put', 'PutObject', calls(blobs).put],
      ['get', 'GetObject', calls(blobs).get],
      ['list', 'ListObjectsV2', calls(blobs).list],
      ['delete (HeadObject hangs)', 'HeadObject', calls(blobs).delete],
      ['delete (DeleteObject hangs)', 'DeleteObject', calls(blobs).delete],
      ['deletePrefix', 'DeleteObject', calls(blobs).deletePrefix]
    ];
    for (const [label, op, call] of cases) {
      const release = s3.inject({ op, delayMs: 6000 });
      const startedAt = Date.now();
      try {
        await assert.rejects(
          within(call(), 4000, label),
          storageFailure('S3_ENDPOINT_UNREACHABLE'),
          label
        );
      } finally {
        release();
      }
      const elapsed = Date.now() - startedAt;
      assert.ok(
        elapsed >= TIMEOUT - 50,
        `${label}: gave up after ${elapsed} ms, before the timeout`
      );
      assert.ok(elapsed < 3000, `${label}: took ${elapsed} ms`);
    }
  });

  it('retries a hanging request a bounded number of times', async () => {
    const { blobs } = await started({ config: { maxAttempts: 3, requestTimeoutMs: TIMEOUT } });
    await blobs.put('chat-files', 'k', 'x');
    s3.clearRequests();
    s3.inject({ op: 'GetObject', delayMs: 6000 });
    await assert.rejects(
      within(blobs.get('chat-files', 'k'), 10_000, 'get with retries'),
      storageFailure('S3_ENDPOINT_UNREACHABLE')
    );
    assert.equal(s3.requests.filter(request => request.op === 'GetObject').length, 3);
  });

  // The `requestTimeout` of @smithy/node-http-handler ends when the response
  // headers arrive. The body is watched by the handler's `socketTimeout` (idle
  // time) and by the deadline of the store's own body read; without them a
  // server that sends the headers and then stops makes `get` wait forever.
  it('throws when the body stalls after the headers arrived', async () => {
    const { blobs } = await started({ config: { maxAttempts: 1, requestTimeoutMs: TIMEOUT } });
    await blobs.put('chat-files', 'k', crypto.randomBytes(200_000));
    s3.inject({ op: 'GetObject', stallBody: 1000 });
    const startedAt = Date.now();
    await assert.rejects(
      within(blobs.get('chat-files', 'k'), 5000, 'get with a stalled body'),
      error => {
        assert.equal(error.name, 'StorageError', `${error.name}: ${error.message}`);
        assert.equal(error.code, 'STORAGE_UNAVAILABLE', error.message);
        return true;
      }
    );
    assert.ok(Date.now() - startedAt < 3000);
  });

  // The lock manager waits 5 s for a held lock by default, while one S3
  // request may take `requestTimeoutMs` (default 60 s). `delete` therefore
  // waits for the key's lock as long as a delete in front may take, so the
  // loser of a delete race on a slow server gets the `false` the contract
  // promises and not a `LockTimeoutError`.
  it('a second delete of the same key waits for a first one that is slow, and answers false', async () => {
    // The first delete holds the lock for the key while its HeadObject is slow
    // (slower than the lock wait, faster than the request timeout).
    const { blobs } = await started({ config: { maxAttempts: 1, requestTimeoutMs: 20_000 } });
    await blobs.put('chat-files', 'k', 'x');
    s3.inject({ op: 'HeadObject', delayMs: 6500, times: 1 });
    const results = await within(
      Promise.allSettled([blobs.delete('chat-files', 'k'), blobs.delete('chat-files', 'k')]),
      20_000,
      'two deletes on a slow server'
    );
    const values = results.map(result =>
      result.status === 'fulfilled' ? result.value : `${result.reason.name}/${result.reason.code}`
    );
    assert.deepEqual([...values].sort(), [false, true], JSON.stringify(values));
  });
});

describe('S3 blob store: its own deadlines, with a client that never settles', () => {
  /** A store over a stub client; `send` decides what every command does. */
  const stubStore = (send, options = {}) => {
    const store = new S3BlobStore({
      bucket: BUCKET,
      requestTimeoutMs: 150,
      connectTimeoutMs: 50,
      maxAttempts: 1,
      connect: async () => ({
        client: { send },
        commands: new Proxy(
          {},
          {
            get: (_, name) =>
              class {
                static op = name;
              }
          }
        ),
        destroy() {}
      }),
      ...options
    });
    open.push(() => store.destroy());
    return store;
  };
  const unavailable = error => {
    assert.equal(error.name, 'StorageError', `${error.name}: ${error.message}`);
    assert.equal(error.code, 'STORAGE_UNAVAILABLE', error.message);
    return true;
  };

  it('derives the longest duration of one command from the timeouts and the attempts', () => {
    assert.equal(sendBudgetMs({}), null);
    assert.equal(sendBudgetMs({ requestTimeoutMs: 400, maxAttempts: 1 }), 400 + 1000);
    assert.equal(
      sendBudgetMs({ requestTimeoutMs: 60_000, connectTimeoutMs: 5000, maxAttempts: 3 }),
      3 * 65_000 + 500 + 1000 + 1000
    );
    // The pause between attempts is capped at 20 s.
    assert.equal(
      sendBudgetMs({ requestTimeoutMs: 1000, maxAttempts: 10 }),
      10 * 1000 + (500 + 1000 + 2000 + 4000 + 8000 + 16_000 + 3 * 20_000) + 1000
    );
  });

  it('aborts a command that does not settle and rejects', async () => {
    let signal;
    const store = stubStore((_command, options) => {
      signal = options.abortSignal;
      return new Promise(() => {});
    });
    const startedAt = Date.now();
    await assert.rejects(within(store.get('chat-files', 'k'), 4000, 'get'), error => {
      assert.equal(error.probeCode, 'S3_ENDPOINT_UNREACHABLE');
      return unavailable(error);
    });
    assert.equal(signal.aborted, true, 'the request was aborted');
    assert.ok(Date.now() - startedAt >= 1200 - 50, 'not before the deadline');
  });

  it('ends a body that keeps trickling in, which no idle timeout notices', async () => {
    let destroyed = false;
    const trickle = {
      destroy: () => void (destroyed = true),
      async *[Symbol.asyncIterator]() {
        while (!destroyed) {
          await new Promise(resolve => setTimeout(resolve, 20));
          yield Buffer.from('x');
        }
      }
    };
    for (const read of [
      store => store.get('chat-files', 'k'),
      store => store.readHead('chat-files', 'k', 512)
    ]) {
      destroyed = false;
      const store = stubStore(async () => ({ ContentLength: 100_000, Body: trickle }));
      const startedAt = Date.now();
      await assert.rejects(within(read(store), 4000, 'read'), unavailable);
      assert.equal(destroyed, true, 'the body was destroyed');
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed >= 100 && elapsed < 1500, `gave up after ${elapsed} ms`);
    }
  });

  it('waits for the delete lock as long as a delete may take, and maps a lock timeout', async () => {
    const waits = [];
    const locks = {
      withLock: async (_name, _fn, opts) => {
        waits.push(opts.waitMs);
        throw new LockTimeoutError('held elsewhere');
      }
    };
    const store = stubStore(async () => ({}), { locks });
    await assert.rejects(store.delete('chat-files', 'k'), error => {
      assert.equal(error.cause.code, 'LOCK_TIMEOUT');
      return unavailable(error);
    });
    // HeadObject and DeleteObject (or HeadBucket), each 50 + 150 ms and the slack.
    assert.deepEqual(waits, [2 * 1200 + 1000]);
  });
});

describe('S3 blob backend: a body that is shorter than it says', () => {
  it('rejects a connection cut mid-body as STORAGE_UNAVAILABLE and returns no bytes', async () => {
    const { blobs } = await started({ config: { maxAttempts: 1 } });
    const payload = crypto.randomBytes(300_000);
    await blobs.put('chat-files', 'k', payload);
    for (const cut of [0, 1, 511, 512, 600, 250_000]) {
      s3.inject({ op: 'GetObject', truncateBody: cut, times: 1 });
      await assert.rejects(within(blobs.get('chat-files', 'k'), 8000, `cut at ${cut}`), error => {
        assert.equal(error.name, 'StorageError', `cut at ${cut}: ${error.name}: ${error.message}`);
        assert.equal(error.code, 'STORAGE_UNAVAILABLE', `cut at ${cut}: ${error.message}`);
        return true;
      });
    }
    assert.ok((await blobs.get('chat-files', 'k')).data.equals(payload), 'intact afterwards');
  });

  it('rejects an object that was shortened in the bucket as CORRUPT_BLOB, at every boundary', async () => {
    // The server is honest about the length here; only the encryption can tell.
    const { blobs, prefix } = await started({ config: { maxAttempts: 1 } });
    const payload = crypto.randomBytes(3 * 1024 * 1024);
    await blobs.put('chat-files', 'k', payload);
    const name = `${prefix}/default/chat-files/k`;
    const stored = s3.rawGet(BUCKET, name);
    const segment = 1024 * 1024;
    const cuts = [
      stored.length - 1,
      stored.length - 16,
      HEADER_BYTES + segment, // exactly after the first segment
      HEADER_BYTES + 2 * segment, // exactly after the second
      HEADER_BYTES + 40,
      HEADER_BYTES,
      HEADER_BYTES - 1,
      4,
      0
    ];
    for (const cut of cuts) {
      s3.rawPut(BUCKET, name, stored.subarray(0, cut));
      await assert.rejects(
        blobs.get('chat-files', 'k'),
        error => {
          assert.equal(
            error.code,
            'CORRUPT_BLOB',
            `cut at ${cut}: ${error.code}: ${error.message}`
          );
          return true;
        },
        `cut at ${cut}`
      );
    }
    s3.rawPut(BUCKET, name, stored);
    assert.ok((await blobs.get('chat-files', 'k')).data.equals(payload));
  });
});

describe('S3 blob backend: an object over the size limit', () => {
  const LIMIT = 64 * 1024;
  const PLANTED = 48 * 1024 * 1024;

  it('refuses an oversized put without sending a request', async () => {
    const { blobs } = await started({ config: { maxObjectBytes: LIMIT } });
    s3.clearRequests();
    await assert.rejects(blobs.put('chat-files', 'big', Buffer.alloc(LIMIT + 1)), {
      code: 'BLOB_TOO_LARGE'
    });
    assert.deepEqual(s3.requests, []);
    assert.equal((await blobs.put('chat-files', 'fits', Buffer.alloc(LIMIT))).bytes, LIMIT);
  });

  it('refuses an oversized object by its declared length and does not download it', async () => {
    const { blobs, prefix } = await started({ config: { maxObjectBytes: LIMIT, maxAttempts: 1 } });
    s3.rawPut(BUCKET, `${prefix}/default/chat-files/planted`, Buffer.alloc(PLANTED, 7));
    s3.clearRequests();
    s3.inject({ op: 'GetObject', meterBody: true });
    await assert.rejects(within(blobs.get('chat-files', 'planted'), 8000, 'get'), {
      code: 'BLOB_TOO_LARGE'
    });
    // Give the fake a moment to notice the closed connection.
    await new Promise(resolve => setTimeout(resolve, 300));
    const request = s3.requests.find(entry => entry.op === 'GetObject');
    assert.equal(request.bodyComplete, false, 'the whole object was downloaded');
    assert.ok(
      request.bodyBytesSent < PLANTED / 4,
      `${request.bodyBytesSent} of ${PLANTED} bytes were taken before the client stopped`
    );
  });

  it('stops reading at the limit when the server sends no length', async () => {
    const { blobs, prefix } = await started({ config: { maxObjectBytes: LIMIT, maxAttempts: 1 } });
    s3.rawPut(BUCKET, `${prefix}/default/chat-files/planted`, Buffer.alloc(PLANTED, 7));
    s3.clearRequests();
    s3.inject({ op: 'GetObject', chunked: true, meterBody: true });
    await assert.rejects(within(blobs.get('chat-files', 'planted'), 8000, 'get'), {
      code: 'BLOB_TOO_LARGE'
    });
    await new Promise(resolve => setTimeout(resolve, 300));
    const request = s3.requests.find(entry => entry.op === 'GetObject');
    assert.equal(request.headers['content-length'], undefined);
    assert.equal(request.bodyComplete, false, 'the whole object was downloaded');
    assert.ok(
      request.bodyBytesSent < PLANTED / 4,
      `${request.bodyBytesSent} of ${PLANTED} bytes were taken before the client stopped`
    );
  });
});

describe('the server process and its blob storage at start', () => {
  /** A seeded contents directory configured for S3 with encryption on. */
  async function contentsFor(s3Block) {
    const dir = await seedContents(await fs.mkdtemp(path.join(scratch, 'server-contents-')));
    await writeStorageConfig(dir, {
      encryption: { enabled: true },
      blobs: {
        provider: 's3',
        s3: { bucket: BUCKET, maxAttempts: 1, connectTimeoutMs: 1000, ...s3Block }
      }
    });
    return dir;
  }

  /** Start, wait until the process serves or ends, and stop it. */
  async function boot(contentsDir, env = {}) {
    const server = await startServer({ contentsDir, env, readyTimeoutMs: 60_000 });
    const outcome = await server.settled;
    const end = await server.stop();
    return { ...outcome, exitCode: outcome.ready ? null : end.exitCode, output: server.output() };
  }

  /** User blobs on local disk: must stay empty. The storage layer's own `_ihub` files must be envelopes. */
  const localBlobs = async dir => {
    const local = await localBlobFiles(dir);
    assert.deepEqual(local.internalNotEncrypted, [], 'an internal blob file is not encrypted');
    return local.user;
  };
  const credentials = () => ({ accessKeyId: s3.accessKeyId, secretAccessKey: SECRET });

  it('exits non-zero when the endpoint is unreachable, in single-process and cluster mode', async () => {
    const closed = await startFakeS3Server({ buckets: [BUCKET] });
    const endpoint = closed.endpoint;
    await closed.close();
    const dir = await contentsFor({ endpoint, prefix: newPrefix(), ...credentials() });

    for (const workers of ['1', '2']) {
      const startedAt = Date.now();
      const result = await boot(dir, { WORKERS: workers });
      assert.equal(
        result.ready,
        false,
        `WORKERS=${workers}: the server came up without its bucket`
      );
      assert.ok(
        Number.isInteger(result.exitCode) && result.exitCode !== 0,
        `WORKERS=${workers}: exit code ${result.exitCode}`
      );
      assert.ok(Date.now() - startedAt < 30_000, 'bounded');
      assert.match(result.output, /S3_ENDPOINT_UNREACHABLE/);
      assert.equal(result.output.includes(SECRET), false, 'the secret access key is in the log');
      assert.deepEqual(await localBlobs(dir), [], 'a blob was written to local disk');
    }
  });

  it('exits non-zero when the bucket does not exist, and does not create it', async () => {
    const dir = await contentsFor({
      endpoint: s3.endpoint,
      bucket: 'no-such-bucket',
      prefix: newPrefix(),
      ...credentials()
    });
    const result = await boot(dir);
    assert.equal(result.ready, false);
    assert.ok(
      Number.isInteger(result.exitCode) && result.exitCode !== 0,
      `exit ${result.exitCode}`
    );
    assert.match(result.output, /S3_BUCKET_NOT_FOUND/);
    assert.equal(result.output.includes(SECRET), false);
    assert.deepEqual(
      s3.requests.filter(request => ['CreateBucket', 'PutObject'].includes(request.op)),
      []
    );
    assert.deepEqual(await localBlobs(dir), []);
  });

  it('refuses to start with another master key than the one the bucket was written with', async () => {
    const prefix = newPrefix();
    const dir = await contentsFor({ endpoint: s3.endpoint, prefix, ...credentials() });
    const first = await boot(dir);
    assert.equal(first.ready, true, first.output.slice(-1500));
    assert.equal(first.health.storage.blobs.provider, 's3');
    assert.equal(first.health.storage.blobs.status, 'ok');
    const marker = `${prefix}/default/_ihub/keycheck`;
    assert.deepEqual(
      s3.rawObjects(BUCKET, `${prefix}/`).map(object => object.key),
      [marker]
    );
    const markerBytes = s3.rawGet(BUCKET, marker);

    // The key file is lost and a new one appears in its place.
    const keyFile = path.join(dir, '.encryption-key');
    const original = await fs.readFile(keyFile, 'utf8');
    assert.match(original.trim(), /^[0-9a-f]{64}$/);
    await fs.writeFile(keyFile, crypto.randomBytes(32).toString('hex'));
    s3.clearRequests();

    const second = await boot(dir);
    assert.equal(second.ready, false, 'the server started with a key that cannot read the bucket');
    assert.ok(
      Number.isInteger(second.exitCode) && second.exitCode !== 0,
      `exit ${second.exitCode}`
    );
    // Whichever key check sees it first refuses: the bucket's (BLOB_KEY_MISMATCH)
    // or the one of the documents and logs on disk, which runs earlier.
    assert.match(second.output, /BLOB_KEY_MISMATCH|written with another master key/);
    assert.equal(second.output.includes(original.trim()), false, 'the old key is in the log');
    assert.deepEqual(
      s3.requests.filter(request => request.op === 'PutObject'),
      [],
      'nothing was written under the wrong key'
    );
    assert.ok(s3.rawGet(BUCKET, marker).equals(markerBytes), 'the key check object is unchanged');
    assert.deepEqual(await localBlobs(dir), []);

    // The right key back: the installation starts again.
    await fs.writeFile(keyFile, original);
    assert.equal((await boot(dir)).ready, true);
  });

  it('refuses a prefix that holds objects but no key check object, unless IHUB_S3_ADOPT_BUCKET=true is set for that start', async () => {
    const prefix = newPrefix();
    const dir = await contentsFor({ endpoint: s3.endpoint, prefix, ...credentials() });
    const foreign = `${prefix}/default/chat-files/from-somewhere`;
    s3.rawPut(BUCKET, foreign, 'not written by this installation');
    const marker = `${prefix}/default/_ihub/keycheck`;

    const refused = await boot(dir);
    assert.equal(refused.ready, false);
    assert.ok(
      Number.isInteger(refused.exitCode) && refused.exitCode !== 0,
      `exit ${refused.exitCode}`
    );
    assert.match(refused.output, /BLOB_KEY_CHECK_MISSING/);
    assert.equal(s3.rawGet(BUCKET, marker), null, 'the key check object was written anyway');

    // Only the value "true" adopts; "1" does not.
    for (const value of ['1']) {
      const still = await boot(dir, { IHUB_S3_ADOPT_BUCKET: value });
      assert.equal(still.ready, false, `IHUB_S3_ADOPT_BUCKET=${JSON.stringify(value)} adopted`);
    }
    assert.equal(s3.rawGet(BUCKET, marker), null);

    const adopted = await boot(dir, { IHUB_S3_ADOPT_BUCKET: 'true' });
    assert.equal(adopted.ready, true, adopted.output.slice(-1500));
    assert.ok(s3.rawGet(BUCKET, marker), 'adopting writes the key check object');
    assert.equal(
      s3.rawGet(BUCKET, foreign).toString(),
      'not written by this installation',
      'adopting changes no object'
    );
    const warning = adopted.output
      .split('\n')
      .find(line => /adopt/i.test(line) && /"level":"warn"/.test(line));
    assert.ok(warning, 'adopting a bucket is logged as a warning');

    // The override is for one start: the next one needs nothing.
    assert.equal((await boot(dir)).ready, true);
    assert.deepEqual(await localBlobs(dir), []);
  });
});

it('the fake S3 server accepts the settings these tests hand to the backend', () => {
  // Guards the fixture: a typo in s3ConfigFor would turn every case above
  // into "unreachable" and let the classification tests pass for the wrong reason.
  const config = s3ConfigFor(s3, { secretAccessKey: SECRET });
  assert.equal(config.endpoint, s3.endpoint);
  assert.equal(config.bucket, BUCKET);
});
