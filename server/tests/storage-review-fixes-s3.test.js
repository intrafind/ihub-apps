// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Regression tests for the review of the S3 blob backend.
 *
 * - server S2 / security S3: plaintext blobs in a bucket when encryption is
 *   switched on (and off, then on): the start refuses and names the command,
 *   the command converts the bucket and writes its key check object;
 * - server S3: local blob leftovers are reported, not counted as encrypted,
 *   and removing the local blob tree does not block a start;
 * - server S6: only the S3 answer NoSuchKey means "no blob";
 * - server S7: the deadline of a call grows with the size of its payload;
 * - the worst case of one call and of a delete with the default settings;
 * - security N3: the endpoint rules.
 */
import { scratchRoot } from './support/scratchContents.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { describe, it, before, after } from 'node:test';
import { startFakeS3Server } from './support/fakeS3Server.js';
import { s3ConfigFor } from './support/blobTestSupport.js';
import { testKeys } from './support/atRestTestSupport.js';

const { prepareStorageEncryption } = await import('../storage/atRest/prepare.js');
const { readAtRestState } = await import('../storage/atRest/state.js');
const { createBlobBackend } = await import('../storage/index.js');
const { S3BlobStore, transferAllowanceMs } = await import('../storage/providers/s3/S3BlobStore.js');
const { createS3Client } = await import('../storage/providers/s3/s3Client.js');
const { resolveS3BlobConfig, isLoopbackHost, isLinkLocalHost, S3_DEFAULTS } =
  await import('../storage/providers/s3/s3Config.js');
const { isBlobEnvelope } = await import('../storage/EncryptingBlobStore.js');
const { refusingLookup } = await import('../utils/httpConfig.js');

const keys = testKeys();
const loadKeys = async () => keys;
const BUCKET = 'ihub-test';

let counter = 0;
async function scratch(s3, s3Overrides = {}) {
  counter += 1;
  const baseDir = path.join(scratchRoot, `s3-${counter}`, 'data');
  await fs.mkdir(baseDir, { recursive: true });
  const config = enabled => ({
    storage: {
      filesystem: { baseDir },
      encryption: { enabled },
      blobs: { provider: 's3', s3: s3ConfigFor(s3, { prefix: `p${counter}`, ...s3Overrides }) }
    }
  });
  return { baseDir, config, prefix: `p${counter}` };
}

/** The S3 backend as a server start builds it: encrypting, strict reads. */
const strictBackend = (config, keyLoader = loadKeys) =>
  createBlobBackend('s3', config.storage.blobs.s3, {
    platformConfig: {},
    locks: null,
    encryption: { enabled: true, plaintextReads: 'reject' },
    loadKeys: keyLoader,
    env: {}
  });

const start = (config, options = {}) =>
  prepareStorageEncryption({ platformConfig: config, env: {}, loadKeys, ...options });
const command = (config, options = {}) =>
  start(config, { force: true, convertRemoteBlobs: true, leaseWaitMs: 0, ...options });

describe('plaintext blobs in a bucket when encryption is switched on (server S2, security S3)', () => {
  let s3;
  before(async () => {
    s3 = await startFakeS3Server();
  });
  after(async () => {
    await s3.close();
  });

  it('the start refuses and names the command; the command converts and writes the key check object', async () => {
    const { baseDir, config, prefix } = await scratch(s3);
    const payload = Buffer.alloc(2000, 7);
    s3.rawPut(BUCKET, `${prefix}/default/chat-files/f1`, payload);
    s3.rawPut(BUCKET, `${prefix}/default/artifacts/a1`, Buffer.from('small plaintext artifact'));

    const refused = await start(config(true)).catch(error => error);
    assert.equal(refused.code, 'REMOTE_BLOBS_PLAINTEXT');
    assert.match(refused.message, /npm run storage:encrypt/);
    assert.doesNotMatch(refused.message, /IHUB_S3_ADOPT_BUCKET/);
    assert.deepEqual(s3.rawGet(BUCKET, `${prefix}/default/chat-files/f1`), payload, 'untouched');
    assert.equal(s3.rawGet(BUCKET, `${prefix}/default/_ihub/keycheck`), null);

    const dry = await command(config(true), { dryRun: true });
    assert.equal(dry.remoteBlobs.plaintext, 2);
    assert.deepEqual(s3.rawGet(BUCKET, `${prefix}/default/chat-files/f1`), payload);

    const done = await command(config(true));
    assert.equal(done.remoteBlobs.converted, 2);
    assert.equal(done.remoteBlobs.keyCheck, 'created');
    assert.equal(isBlobEnvelope(s3.rawGet(BUCKET, `${prefix}/default/chat-files/f1`)), true);
    assert.ok(s3.rawGet(BUCKET, `${prefix}/default/_ihub/keycheck`), 'key check object written');
    const state = await readAtRestState(baseDir);
    assert.equal(state.facets.remoteBlobs, 1);
    assert.match(state.remoteBlobStore, new RegExp(`^s3:.*/${BUCKET}/${prefix}/`));

    // The start now goes through, without looking at every object again.
    s3.clearRequests();
    assert.equal((await start(config(true))).action, 'verified');
    assert.deepEqual(
      s3.requests.map(request => request.op),
      [],
      'a recorded bucket is not scanned at a start'
    );
    // What a server start puts in front of the bucket: strict reads.
    const backend = strictBackend(config(true));
    try {
      await backend.initialize();
      assert.deepEqual((await backend.blobs.get('chat-files', 'f1')).data, payload);
    } finally {
      await backend.shutdown();
    }
  });

  it('off and on again: blobs written in between are found, and reads stay lenient while off', async () => {
    const { baseDir, config, prefix } = await scratch(s3);
    assert.equal((await start(config(true))).action, 'converted');
    assert.equal((await readAtRestState(baseDir)).facets.remoteBlobs, 1);

    // Switched off: the record forgets the bucket, plaintext is written.
    assert.equal((await start(config(false))).action, 'disabled');
    assert.equal((await readAtRestState(baseDir)).facets.remoteBlobs, undefined);
    s3.rawPut(BUCKET, `${prefix}/default/chat-files/while-off`, Buffer.alloc(1500, 3));

    const refused = await start(config(true)).catch(error => error);
    assert.equal(refused.code, 'REMOTE_BLOBS_PLAINTEXT');
    await command(config(true));
    assert.equal((await start(config(true))).action, 'verified');
    assert.equal(isBlobEnvelope(s3.rawGet(BUCKET, `${prefix}/default/chat-files/while-off`)), true);
  });

  it('refuses a bucket of another master key, with and without its key check object', async () => {
    const { config, prefix } = await scratch(s3);
    const other = testKeys({ master: 'b2'.repeat(32) });
    // Another installation, another key: it writes the key check object and a blob.
    const theirs = strictBackend(config(true), async () => other);
    await theirs.initialize();
    await theirs.blobs.put('chat-files', 'theirs', Buffer.alloc(1000, 5));
    await theirs.shutdown();

    const mine = await scratch(s3, { prefix });
    await assert.rejects(start(mine.config(true)), { code: 'KEY_UNAVAILABLE' });
    await assert.rejects(command(mine.config(true)), { code: 'KEY_UNAVAILABLE' });

    s3.rawDelete(BUCKET, `${prefix}/default/_ihub/keycheck`);
    const refused = await command(mine.config(true)).catch(error => error);
    assert.equal(refused.code, 'REMOTE_BLOBS_FOREIGN_KEY');
    assert.equal(
      s3.rawGet(BUCKET, `${prefix}/default/_ihub/keycheck`),
      null,
      'no key check written'
    );
  });

  it('local blob leftovers are reported as plaintext, and removing the blob tree blocks nothing (server S3)', async () => {
    const { baseDir, config } = await scratch(s3);
    await fs.mkdir(path.join(baseDir, 'blobs', 'chat-files'), { recursive: true });
    await fs.writeFile(path.join(baseDir, 'blobs', 'chat-files', 'old1'), 'left over local blob');
    const lines = [];
    const result = await start(config(true), { onLog: line => lines.push(line) });
    assert.equal(result.action, 'converted');
    assert.equal(result.localPlaintextBlobs, 1);
    assert.equal(result.state.converted.blobs, 0, 'not counted as encrypted');
    assert.deepEqual(result.state.plaintextLeftovers, { localBlobs: 1 });
    assert.ok(
      lines.some(line => /1 blob files .* still in plaintext/.test(line)),
      'the summary names them'
    );
    assert.equal(
      await fs.readFile(path.join(baseDir, 'blobs', 'chat-files', 'old1'), 'utf8'),
      'left over local blob'
    );
    // What the copy command tells the operator to do afterwards.
    await fs.rm(path.join(baseDir, 'blobs'), { recursive: true });
    assert.equal((await start(config(true))).action, 'verified');
  });
});

describe('only the S3 answer NoSuchKey means "no blob" (server S6)', () => {
  let s3;
  let proxy;
  let mode = 'html404';
  before(async () => {
    s3 = await startFakeS3Server();
    proxy = http.createServer((req, res) => {
      req.resume();
      if (mode === 'html404') {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<html><body>404 page not found</body></html>');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  });
  after(async () => {
    await s3.close();
    await new Promise(resolve => proxy.close(resolve));
  });

  const storeFor = endpoint => {
    const config = resolveS3BlobConfig({
      endpoint,
      bucket: BUCKET,
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey,
      maxAttempts: 1
    });
    return new S3BlobStore({
      bucket: config.bucket,
      connect: () => createS3Client(config, { platformConfig: {} }),
      requestTimeoutMs: 5000,
      maxAttempts: 1
    });
  };

  it('a missing key on an S3 server is null', async () => {
    const store = storeFor(s3.endpoint);
    try {
      assert.equal(await store.get('chat-files', 'nothing-here'), null);
      assert.equal(await store.readHead('chat-files', 'nothing-here', 512), null);
      assert.equal(await store.delete('chat-files', 'nothing-here'), false);
    } finally {
      await store.destroy();
    }
  });

  for (const kind of ['html404', 'empty404']) {
    it(`a 404 that does not come from S3 (${kind}) is an error for get and readHead`, async () => {
      mode = kind;
      const store = storeFor(`http://127.0.0.1:${proxy.address().port}`);
      try {
        const got = await store.get('chat-files', 'f1').catch(error => error);
        assert.ok(got instanceof Error, `get answered ${JSON.stringify(got)}`);
        assert.ok(['IO_ERROR', 'STORAGE_UNAVAILABLE'].includes(got.code), got.code);
        const head = await store.readHead('chat-files', 'f1', 512).catch(error => error);
        assert.ok(head instanceof Error, `readHead answered ${JSON.stringify(head)}`);
      } finally {
        await store.destroy();
      }
    });
  }
});

describe('the deadline of a call (server S7 and the outage numbers)', () => {
  let s3;
  before(async () => {
    s3 = await startFakeS3Server();
  });
  after(async () => {
    await s3.close();
  });

  const storeWith = (options, locks) => {
    const config = resolveS3BlobConfig(s3ConfigFor(s3, { maxAttempts: 1 }));
    return new S3BlobStore({
      bucket: config.bucket,
      connect: () => createS3Client({ ...config, ...options }, { platformConfig: {} }),
      maxAttempts: 1,
      locks,
      ...options
    });
  };

  /** A client that answers after `delayMs`, or when its request is aborted. */
  const slowClient = delayMs => {
    const sent = [];
    const client = {
      send: (command, options = {}) => {
        sent.push({ name: command.constructor.name, requestTimeout: options.requestTimeout });
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({}), delayMs);
          options.abortSignal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      }
    };
    class PutObjectCommand {
      constructor(input) {
        this.input = input;
      }
    }
    return { sent, connection: { client, commands: { PutObjectCommand }, destroy() {} } };
  };

  it('grows with the payload: a slow upload of a large object passes, of a small one fails', async () => {
    assert.equal(transferAllowanceMs(64 * 1024 * 1024, 1024 * 1024), 64000);
    assert.equal(transferAllowanceMs(0, 1024 * 1024), 0);
    // 200 ms per request and per call (1200 ms with the slack), and 1000
    // bytes per second as the slowest transfer. Every upload takes 1600 ms.
    const { sent, connection } = slowClient(1600);
    const store = new S3BlobStore({
      bucket: BUCKET,
      connect: async () => connection,
      requestTimeoutMs: 200,
      connectTimeoutMs: 0,
      maxAttempts: 1,
      operationTimeoutMs: 200,
      minThroughputBytesPerSecond: 1000
    });
    // 3000 bytes: 3 s on top, for the call and for the client's request timeout.
    assert.equal((await store.put('chat-files', 'large', Buffer.alloc(3000, 1))).bytes, 3000);
    assert.equal(sent[0].requestTimeout, 200 + 3000);
    // 10 bytes: 10 ms on top. The call is ended at its deadline.
    const startedAt = Date.now();
    await assert.rejects(store.put('chat-files', 'small', Buffer.alloc(10, 1)), {
      code: 'STORAGE_UNAVAILABLE'
    });
    assert.ok(Date.now() - startedAt < 1550, 'ended by the deadline, not by the answer');
    assert.equal(sent[1].requestTimeout, 200 + 10);
    await store.destroy();
  });

  it('a download may take what its length needs, and a stalled one still ends', async () => {
    const store = storeWith({
      requestTimeoutMs: 300,
      connectTimeoutMs: 300,
      operationTimeoutMs: 300,
      minThroughputBytesPerSecond: 1000
    });
    try {
      await store.put('chat-files', 'body', Buffer.alloc(3000, 1));
      assert.equal(store._bodyDeadlineMs(Date.now(), 3000) >= 3000 + 1000, true);
      assert.equal(store._bodyDeadlineMs(Date.now(), 0) <= 1300, true);
      s3.inject({ op: 'GetObject', key: /body/, stallBody: 1000, times: 1 });
      const stalled = await store.get('chat-files', 'body').catch(error => error);
      assert.ok(stalled instanceof Error, 'a body that stalls still ends the call');
      s3.clearInjections();
      assert.equal((await store.get('chat-files', 'body')).bytes, 3000);
    } finally {
      s3.clearInjections();
      await store.destroy();
    }
  });

  it('with the defaults one call ends after 31 s plus its transfer time, a delete after 63 s', async () => {
    const defaults = resolveS3BlobConfig(s3ConfigFor(s3, { maxAttempts: undefined }));
    assert.equal(defaults.operationTimeoutMs, 30000);
    assert.equal(defaults.minThroughputBytesPerSecond, 1024 * 1024);
    assert.equal(defaults.requestTimeoutMs, 60000);
    assert.equal(defaults.maxAttempts, S3_DEFAULTS.maxAttempts);
    const waits = [];
    const locks = {
      withLock: async (name, fn, options) => {
        waits.push(options.waitMs);
        return fn();
      }
    };
    const store = storeWith(
      {
        requestTimeoutMs: defaults.requestTimeoutMs,
        connectTimeoutMs: defaults.connectTimeoutMs,
        maxAttempts: defaults.maxAttempts,
        operationTimeoutMs: defaults.operationTimeoutMs,
        minThroughputBytesPerSecond: defaults.minThroughputBytesPerSecond
      },
      locks
    );
    try {
      // One call: 30 s and 1 s of slack, where three attempts added up to 197.5 s.
      assert.equal(store._sendBudgetMs, 31000);
      assert.equal(await store.delete('chat-files', 'nothing'), false);
      // The wait for the delete lock covers the delete in front: 32 s.
      // Waiting and deleting together: at most 63 s, where it was 396 s + 197.5 s.
      assert.deepEqual(waits, [32000]);
    } finally {
      await store.destroy();
    }
  });

  it('the two requests of a delete share one deadline', async () => {
    const store = storeWith({
      requestTimeoutMs: 2000,
      connectTimeoutMs: 500,
      operationTimeoutMs: 400,
      minThroughputBytesPerSecond: 1024 * 1024
    });
    try {
      await store.put('chat-files', 'slow-delete', 'x');
      // HeadObject uses up most of the time; DeleteObject gets what is left.
      s3.inject({ op: 'HeadObject', delayMs: 900, times: 1 });
      s3.inject({ op: 'DeleteObject', delayMs: 1500, times: 1 });
      const startedAt = Date.now();
      await assert.rejects(store.delete('chat-files', 'slow-delete'), {
        code: 'STORAGE_UNAVAILABLE'
      });
      const took = Date.now() - startedAt;
      assert.ok(took < 2000, `the delete took ${took} ms, more than one deadline (1400 ms)`);
    } finally {
      s3.clearInjections();
      await store.destroy();
    }
  });
});

describe('the endpoint rules (security N3)', () => {
  const base = { bucket: BUCKET, accessKeyId: 'a', secretAccessKey: 'b' };
  const refusedField = raw => {
    try {
      resolveS3BlobConfig({ ...base, ...raw });
      return null;
    } catch (error) {
      return error.field;
    }
  };

  it('refuses a link-local address in every spelling, also with allowInsecureHttp', () => {
    for (const host of [
      '169.254.169.254',
      '[::ffff:169.254.169.254]',
      '[::ffff:a9fe:a9fe]',
      '[0:0:0:0:0:ffff:a9fe:a9fe]',
      '[fe80::1]'
    ]) {
      assert.equal(
        refusedField({ endpoint: `http://${host}`, allowInsecureHttp: true }),
        'endpoint',
        host
      );
      assert.equal(isLinkLocalHost(host), true, host);
    }
    assert.equal(isLinkLocalHost('10.0.0.1'), false);
    assert.equal(isLinkLocalHost('[::ffff:10.0.0.1]'), false);
  });

  it('treats only the name localhost and loopback addresses as this machine', () => {
    assert.equal(refusedField({ endpoint: 'http://localhost:9000' }), null);
    assert.equal(refusedField({ endpoint: 'http://127.0.0.1:9000' }), null);
    assert.equal(refusedField({ endpoint: 'http://[::1]:9000' }), null);
    assert.equal(refusedField({ endpoint: 'http://anything.localhost:9000' }), 'endpoint');
    assert.equal(
      refusedField({ endpoint: 'http://anything.localhost:9000', allowInsecureHttp: true }),
      null
    );
    assert.equal(isLoopbackHost('x.localhost'), false);
    assert.equal(isLoopbackHost('[::ffff:127.0.0.1]'), true);
  });

  it('refuses a name that resolves to a link-local address', async () => {
    const answers = {
      'metadata.example': [{ address: '169.254.169.254', family: 4 }],
      'mapped.example': '::ffff:169.254.169.254',
      's3.example': '10.1.2.3'
    };
    const inner = (hostname, options, callback) => {
      const answer = answers[hostname];
      if (Array.isArray(answer)) callback(null, answer);
      else callback(null, answer, answer.includes(':') ? 6 : 4);
    };
    const lookup = refusingLookup(inner, address =>
      isLinkLocalHost(address) ? 'resolves to a link-local address' : null
    );
    const resolve = (hostname, options = {}) =>
      new Promise(done => lookup(hostname, options, (error, address) => done(error || address)));
    assert.equal((await resolve('metadata.example', { all: true })).code, 'ERR_ADDRESS_REFUSED');
    assert.equal((await resolve('mapped.example')).code, 'ERR_ADDRESS_REFUSED');
    assert.equal(await resolve('s3.example'), '10.1.2.3');
  });
});
