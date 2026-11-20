// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The S3 blob backend beyond the shared contract: what it sends, how it names
 * objects, how failures are classified, the start-up check with its key check
 * object, and the configuration rules. All on the in-repo fake S3 server.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FAKE_S3_ACCESS_KEY_ID, startFakeS3Server } from './support/fakeS3Server.js';
import {
  MASTER_KEY_A,
  MASTER_KEY_B,
  composeS3Provider,
  fixedKeys,
  s3ConfigFor
} from './support/blobTestSupport.js';

const scratch = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-s3-blobstore-'));
process.env.CONTENTS_DIR = path.join(scratch, 'contents');
const keyModule = await import('../crypto/KeyProvider.js');
const storage = await import('../storage/index.js');
const { resolveS3BlobConfig, createS3BlobBackend, S3BlobStore, classifyS3Error, isLoopbackHost } =
  await import('../storage/providers/s3/index.js');
const { default: tokenStorageService } = await import('../services/TokenStorageService.js');

const BUCKET = 'ihub-test';
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

const newPrefix = () => `t-${crypto.randomBytes(5).toString('hex')}`;

/** An initialized composed provider on a fresh prefix. */
async function started(options = {}) {
  const prefix = options.config?.prefix ?? newPrefix();
  const composed = await composeS3Provider({
    s3,
    keys: fixedKeys(keyModule),
    ...options,
    config: { ...options.config, prefix }
  });
  open.push(async () => {
    await composed.provider.shutdown();
    await fs.rm(composed.baseDir, { recursive: true, force: true });
  });
  await composed.provider.initialize();
  return { ...composed, prefix, blobs: composed.provider.blobs };
}

/** A backend that is not started, for the cases about starting. */
function backendFor(config = {}, context = {}) {
  const backend = createS3BlobBackend(s3ConfigFor(s3, { prefix: newPrefix(), ...config }), {
    loadKeys: async () => fixedKeys(keyModule),
    env: {},
    ...context
  });
  open.push(() => backend.shutdown());
  return backend;
}

describe('S3 blob store: what reaches the bucket', () => {
  it('names objects <prefix>/<tenant>/<ns>/<key> and stores them as opaque octet streams', async () => {
    const { blobs, prefix } = await started();
    s3.clearRequests();

    await blobs.put('chat-files', 'chat__c1__f1.txt', 'hello', { contentType: 'text/plain' });

    const names = s3.rawObjects(BUCKET, `${prefix}/`).map(object => object.key);
    assert.deepEqual(names, [
      `${prefix}/default/_ihub/keycheck`,
      `${prefix}/default/chat-files/chat__c1__f1.txt`
    ]);
    const [put] = s3.requests.filter(request => request.op === 'PutObject');
    assert.equal(put.headers['content-type'], 'application/octet-stream', 'the hint is not stored');
    const headerNames = Object.keys(put.headers);
    for (const forbidden of [
      /^x-amz-meta-/,
      /^x-amz-checksum-/,
      /^x-amz-acl$/,
      /^x-amz-server-side/
    ]) {
      assert.deepEqual(
        headerNames.filter(name => forbidden.test(name)),
        [],
        `no ${forbidden} header`
      );
    }
    assert.equal(put.headers['x-amz-sdk-checksum-algorithm'], undefined);
    assert.match(put.headers.authorization, /^AWS4-HMAC-SHA256 Credential=ihub-dev-not-a-secret\//);
  });

  it('never creates a bucket and sends only the six request kinds', async () => {
    const { blobs } = await started();
    await blobs.put('artifacts', 'a__b__c', 'x');
    await blobs.get('artifacts', 'a__b__c');
    await blobs.list('artifacts', { prefix: 'a__' });
    await blobs.delete('artifacts', 'a__b__c');
    await blobs.deletePrefix('artifacts', 'a__');
    const ops = new Set(s3.requests.map(request => request.op));
    for (const op of ops) {
      assert.ok(
        [
          'HeadBucket',
          'PutObject',
          'GetObject',
          'HeadObject',
          'DeleteObject',
          'ListObjectsV2'
        ].includes(op),
        `unexpected request ${op}`
      );
    }
  });

  it('refuses invalid names before any request is sent', async () => {
    const { blobs } = await started();
    s3.clearRequests();
    await assert.rejects(blobs.put('chat-files', '../x', 'x'), { code: 'INVALID_KEY' });
    await assert.rejects(blobs.get('chat-files', 'a/b'), { code: 'INVALID_KEY' });
    await assert.rejects(blobs.delete('chat-files', 'user@example.com'), { code: 'INVALID_KEY' });
    await assert.rejects(blobs.list('bad/ns'), { code: 'INVALID_KEY' });
    await assert.rejects(blobs.deletePrefix('chat-files', ''), { code: 'INVALID_KEY' });
    await assert.rejects(blobs.list('chat-files', { cursor: 'garbage' }), {
      code: 'INVALID_CURSOR'
    });
    assert.deepEqual((await blobs.list('chat-files', { prefix: 'a/b' })).items, []);
    assert.equal(s3.requests.length, 0);
  });

  it('pages with its own cursor, in key order, and keeps namespaces and prefixes apart', async () => {
    const { blobs, prefix } = await started();
    const keys = [
      'a',
      'a.',
      'a-',
      'a_',
      'A',
      '0',
      'a__b',
      'a___b',
      '.hidden',
      '-x',
      'k'.repeat(100)
    ];
    for (const key of keys) await blobs.put('ns', key, key);
    await blobs.put('ns-2', 'other', 'x');
    await blobs.put('ns.y', 'other', 'x');
    // A sibling installation's prefix that starts with ours.
    s3.rawPut(BUCKET, `${prefix}2/default/ns/intruder`, 'x');
    // Not a key of this store: a nested name.
    s3.rawPut(BUCKET, `${prefix}/default/ns/nested/name`, 'x');

    const paged = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = await blobs.list('ns', { limit: 3, ...(cursor ? { cursor } : {}) });
      paged.push(...page.items.map(item => item.key));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);
    assert.deepEqual(paged, [...keys].sort());
    assert.equal(pages, 4, 'no empty extra page');

    const whole = await blobs.list('ns', { limit: 5000 });
    assert.equal(whole.items.length, keys.length);
    assert.equal(whole.nextCursor, null);
    assert.deepEqual(
      (await blobs.list('ns', { prefix: 'a__' })).items.map(item => item.key),
      ['a___b', 'a__b']
    );
    assert.equal((await blobs.list('ns', { limit: 0 })).items.length, 1, 'limit is clamped to 1');
  });

  it('lists more than one backend page and removes all of it', async () => {
    const { blobs } = await started();
    const count = 1003;
    for (let start = 0; start < count; start += 50) {
      await Promise.all(
        Array.from({ length: Math.min(50, count - start) }, (_, index) =>
          blobs.put('many', `scope__${String(start + index).padStart(5, '0')}`, 'x')
        )
      );
    }
    let seen = 0;
    for await (const item of blobs.scan('many', { prefix: 'scope__' })) {
      seen += 1;
      assert.equal(item.bytes, 1);
    }
    assert.equal(seen, count);
    assert.equal(await blobs.deletePrefix('many', 'scope__'), count);
    assert.deepEqual((await blobs.list('many')).items, []);
  });

  it('reads no object for a listing and reports payload sizes', async () => {
    const { blobs } = await started();
    await blobs.put('sizes', 'empty', '');
    await blobs.put('sizes', 'three', 'abc');
    s3.clearRequests();
    assert.deepEqual((await blobs.list('sizes')).items, [
      { key: 'empty', bytes: 0 },
      { key: 'three', bytes: 3 }
    ]);
    assert.deepEqual(
      s3.requests.map(request => request.op),
      ['ListObjectsV2']
    );
  });
});

describe('S3 blob store: failures', () => {
  it('maps a missing key to null and a missing bucket to an error', async () => {
    const { blobs } = await started();
    assert.equal(await blobs.get('chat-files', 'missing'), null);
    assert.equal(await blobs.delete('chat-files', 'missing'), false);

    s3.removeBucket(BUCKET);
    try {
      await assert.rejects(blobs.get('chat-files', 'missing'), error => {
        assert.equal(error.code, 'STORAGE_UNAVAILABLE');
        assert.equal(error.probeCode, 'S3_BUCKET_NOT_FOUND');
        return true;
      });
      await assert.rejects(blobs.put('chat-files', 'k', 'x'), { probeCode: 'S3_BUCKET_NOT_FOUND' });
    } finally {
      s3.addBucket(BUCKET);
    }
    assert.equal(
      s3.requests.some(request => request.op === 'CreateBucket'),
      false
    );
  });

  it('does not treat access denied as "not found"', async () => {
    const { blobs } = await started();
    await blobs.put('chat-files', 'k', 'x');
    for (const [code, probeCode] of [
      ['AccessDenied', 'S3_ACCESS_DENIED'],
      ['InvalidAccessKeyId', 'S3_CREDENTIALS_REJECTED'],
      ['SignatureDoesNotMatch', 'S3_CREDENTIALS_REJECTED'],
      ['RequestTimeTooSkewed', 'S3_CLOCK_SKEW']
    ]) {
      s3.inject({ op: 'GetObject', status: 403, code, times: 1 });
      await assert.rejects(
        blobs.get('chat-files', 'k'),
        error => error.code === 'STORAGE_UNAVAILABLE' && error.probeCode === probeCode,
        code
      );
    }
    s3.inject({ op: 'HeadObject', status: 403, times: 1 });
    await assert.rejects(blobs.delete('chat-files', 'k'), { probeCode: 'S3_ACCESS_DENIED' });
    assert.equal((await blobs.get('chat-files', 'k')).data.toString(), 'x', 'still there');
  });

  it('retries a failing request a bounded number of times', async () => {
    const { blobs } = await started({ config: { maxAttempts: 2 } });
    await blobs.put('chat-files', 'k', 'x');

    s3.clearRequests();
    s3.inject({ op: 'GetObject', status: 503, code: 'SlowDown', times: 1 });
    assert.equal(
      (await blobs.get('chat-files', 'k')).data.toString(),
      'x',
      'succeeds on the retry'
    );
    assert.equal(s3.requests.filter(request => request.op === 'GetObject').length, 2);

    s3.clearRequests();
    s3.inject({ op: 'GetObject', status: 500 });
    await assert.rejects(blobs.get('chat-files', 'k'), {
      code: 'STORAGE_UNAVAILABLE',
      probeCode: 'S3_SERVICE_ERROR'
    });
    assert.equal(s3.requests.filter(request => request.op === 'GetObject').length, 2);
  });

  it('rejects a truncated body instead of returning a short payload', async () => {
    const { blobs } = await started({ config: { maxAttempts: 1 } });
    await blobs.put('chat-files', 'k', crypto.randomBytes(5000));
    s3.inject({ op: 'GetObject', truncateBody: 600 });
    await assert.rejects(blobs.get('chat-files', 'k'), error => {
      assert.ok(['STORAGE_UNAVAILABLE', 'IO_ERROR'].includes(error.code), error.code);
      return true;
    });
  });

  it('gives up on a server that does not answer, within the request timeout', async () => {
    const { blobs } = await started({ config: { maxAttempts: 1, requestTimeoutMs: 300 } });
    await blobs.put('chat-files', 'k', 'x');
    s3.inject({ op: 'GetObject', delayMs: 3000, times: 1 });
    const startedAt = Date.now();
    await assert.rejects(blobs.get('chat-files', 'k'), {
      code: 'STORAGE_UNAVAILABLE',
      probeCode: 'S3_ENDPOINT_UNREACHABLE'
    });
    assert.ok(Date.now() - startedAt < 2500, 'did not wait for the answer');
  });

  it('turns a malformed listing into a storage error', async () => {
    const { blobs } = await started({ config: { maxAttempts: 1 } });
    s3.inject({ op: 'ListObjectsV2', rawBody: '<ListBucketResult><Contents><Key>', times: 1 });
    await assert.rejects(blobs.list('chat-files'), error => {
      assert.equal(error.name, 'StorageError');
      return true;
    });
  });

  it('refuses a server that lists out of order', async () => {
    const { blobs, prefix } = await started({ config: { maxAttempts: 1 } });
    const body = name =>
      `<ListBucketResult><IsTruncated>false</IsTruncated>${['b', 'a']
        .map(key => `<Contents><Key>${name}${key}</Key><Size>568</Size></Contents>`)
        .join('')}</ListBucketResult>`;
    s3.inject({
      op: 'ListObjectsV2',
      rawBody: body(`${prefix}/default/chat-files/`),
      times: 1
    });
    await assert.rejects(blobs.list('chat-files'), { code: 'IO_ERROR' });
  });

  it('checks the object size before it reads the body', async () => {
    const { blobs, prefix } = await started({ config: { maxObjectBytes: 1000 } });
    await assert.rejects(blobs.put('chat-files', 'big', Buffer.alloc(1001)), {
      code: 'BLOB_TOO_LARGE'
    });
    assert.equal((await blobs.put('chat-files', 'fits', Buffer.alloc(1000))).bytes, 1000);
    // Someone with write access to the bucket plants an object far over the limit.
    s3.rawPut(BUCKET, `${prefix}/default/chat-files/planted`, Buffer.alloc(200000, 1));
    await assert.rejects(blobs.get('chat-files', 'planted'), { code: 'BLOB_TOO_LARGE' });

    // And without a size limit on the store itself, a read stops at the limit.
    const bare = new S3BlobStore({
      bucket: BUCKET,
      prefix,
      maxObjectBytes: 2000,
      connect: async () => {
        const { createS3Client } = await import('../storage/providers/s3/index.js');
        return createS3Client(resolveS3BlobConfig(s3ConfigFor(s3)), { platformConfig: {} });
      }
    });
    open.push(() => bare.destroy());
    await assert.rejects(bare.get('chat-files', 'planted'), { code: 'BLOB_TOO_LARGE' });
    assert.equal((await bare.get('chat-files', 'fits')).bytes, 1000 + 512 + 56);
  });

  it('excludes racing deletes per process when it has no lock manager', async () => {
    const bare = new S3BlobStore({
      bucket: BUCKET,
      prefix: newPrefix(),
      connect: async () => {
        const { createS3Client } = await import('../storage/providers/s3/index.js');
        return createS3Client(resolveS3BlobConfig(s3ConfigFor(s3)), { platformConfig: {} });
      }
    });
    open.push(() => bare.destroy());
    for (let round = 0; round < 10; round++) {
      await bare.put('ns', 'once', 'x');
      const removed = await Promise.all([bare.delete('ns', 'once'), bare.delete('ns', 'once')]);
      assert.deepEqual(removed.sort(), [false, true]);
    }
    await bare.destroy();
    await assert.rejects(bare.get('ns', 'once'), { code: 'STORAGE_SHUT_DOWN' });
  });

  it('classifies network and TLS failures', () => {
    const withCode = code => Object.assign(new Error('x'), { code });
    assert.equal(classifyS3Error(withCode('ECONNREFUSED')).probeCode, 'S3_ENDPOINT_UNREACHABLE');
    assert.equal(classifyS3Error(withCode('ENOTFOUND')).probeCode, 'S3_ENDPOINT_UNREACHABLE');
    assert.equal(
      classifyS3Error(withCode('DEPTH_ZERO_SELF_SIGNED_CERT')).probeCode,
      'S3_TLS_UNTRUSTED'
    );
    assert.equal(
      classifyS3Error(Object.assign(new Error('x'), { cause: withCode('CERT_HAS_EXPIRED') }))
        .probeCode,
      'S3_TLS_UNTRUSTED'
    );
    assert.equal(
      classifyS3Error(Object.assign(new Error('x'), { name: 'PermanentRedirect' })).probeCode,
      'S3_REGION_MISMATCH'
    );
    assert.deepEqual(classifyS3Error(new Error('odd')), {
      probeCode: 'S3_ERROR',
      storageCode: 'IO_ERROR',
      reason: 'Error'
    });
  });
});

describe('S3 blob backend: start-up check', () => {
  it('writes the key check object into an empty prefix and verifies it on the next start', async () => {
    const config = { prefix: newPrefix() };
    const first = backendFor(config);
    await first.initialize();
    assert.equal(first.lastProbe.status, 'ok');
    assert.deepEqual(
      first.lastProbe.steps.map(step => `${step.name}:${step.status}`),
      ['key:ok', 'connect:ok', 'keycheck:ok', 'roundtrip:ok']
    );
    assert.match(first.lastProbe.steps[2].detail, /created/);
    assert.deepEqual(
      s3.rawObjects(BUCKET, `${config.prefix}/`).map(object => object.key),
      [`${config.prefix}/default/_ihub/keycheck`],
      'the probe object is removed again'
    );

    const second = backendFor(config);
    await second.initialize();
    assert.match(second.lastProbe.steps[2].detail, /verified/);
    assert.deepEqual(second.describe().location, {
      endpointHost: `127.0.0.1:${s3.port}`,
      bucket: BUCKET,
      region: 'us-east-1',
      prefix: `${config.prefix}/default/`
    });
    assert.equal(JSON.stringify(second.describe()).includes(s3.secretAccessKey), false);
  });

  it('refuses to start with another master key, and starts again with it as the previous key', async () => {
    const config = { prefix: newPrefix() };
    await backendFor(config).initialize();

    const other = backendFor(config, {
      loadKeys: async () => fixedKeys(keyModule, { master: MASTER_KEY_B })
    });
    await assert.rejects(other.initialize(), error => {
      assert.equal(error.code, 'STORAGE_UNAVAILABLE');
      assert.equal(error.probeCode, 'BLOB_KEY_MISMATCH');
      assert.equal(error.probe.error.step, 'keycheck');
      assert.equal(error.message.includes(MASTER_KEY_A), false);
      assert.equal(error.message.includes(MASTER_KEY_B), false);
      return true;
    });
    // Nothing was written under the wrong key.
    assert.equal(s3.rawObjects(BUCKET, `${config.prefix}/`).length, 1);

    const rotated = backendFor(config, {
      loadKeys: async () => fixedKeys(keyModule, { master: MASTER_KEY_B, previous: MASTER_KEY_A })
    });
    await rotated.initialize();
  });

  it('refuses to start without a master key or with one that was not saved', async () => {
    const none = backendFor({}, { loadKeys: async () => fixedKeys(keyModule, { master: null }) });
    await assert.rejects(none.initialize(), { probeCode: 'BLOB_KEY_MISSING' });
    assert.equal(none.lastProbe.error.step, 'key');
    assert.deepEqual(
      none.lastProbe.steps.map(step => step.status),
      ['failed', 'skipped', 'skipped', 'skipped']
    );

    const unsaved = backendFor(
      {},
      { loadKeys: async () => fixedKeys(keyModule, { source: 'generated-unpersisted' }) }
    );
    await assert.rejects(unsaved.initialize(), { probeCode: 'BLOB_KEY_MISSING' });
    assert.equal(
      s3.requests.some(request => request.op === 'PutObject'),
      false
    );
  });

  it('refuses a prefix that holds objects but no key check object, unless adopted for one start', async () => {
    const config = { prefix: newPrefix() };
    s3.rawPut(BUCKET, `${config.prefix}/default/chat-files/from-somewhere`, 'x');

    const refused = backendFor(config);
    await assert.rejects(refused.initialize(), { probeCode: 'BLOB_KEY_CHECK_MISSING' });
    assert.equal(s3.rawObjects(BUCKET, `${config.prefix}/`).length, 1, 'nothing was written');

    // Leftover probe objects alone do not make a prefix "in use".
    const leftovers = { prefix: newPrefix() };
    s3.rawPut(BUCKET, `${leftovers.prefix}/default/_ihub/probe-left-behind`, 'x');
    await backendFor(leftovers).initialize();

    const adopted = backendFor(config, { env: { IHUB_S3_ADOPT_BUCKET: 'true' } });
    await adopted.initialize();
    assert.match(adopted.lastProbe.steps[2].detail, /adopted/);
    await backendFor(config).initialize();
  });

  it('names the failing step for a missing bucket, rejected credentials and a closed port', async () => {
    const missing = backendFor({ bucket: 'no-such-bucket' });
    await assert.rejects(missing.initialize(), error => {
      assert.equal(error.probeCode, 'S3_BUCKET_NOT_FOUND');
      assert.equal(error.probe.error.step, 'connect');
      assert.match(error.message, /check failed at step "connect"/);
      return true;
    });

    const wrongKey = backendFor({
      accessKeyId: 'someone-else',
      secretAccessKey: 'very-secret-value'
    });
    await assert.rejects(wrongKey.initialize(), error => {
      // A HEAD has no error body, so the SDK only sees the 403.
      assert.ok(['S3_ACCESS_DENIED', 'S3_CREDENTIALS_REJECTED'].includes(error.probeCode));
      assert.equal(error.message.includes('very-secret-value'), false);
      assert.equal(JSON.stringify(error.probe).includes('very-secret-value'), false);
      return true;
    });

    const closed = await startFakeS3Server({ buckets: [BUCKET] });
    const endpoint = closed.endpoint;
    await closed.close();
    const unreachable = backendFor({ endpoint, maxAttempts: 1, connectTimeoutMs: 1000 });
    const startedAt = Date.now();
    await assert.rejects(unreachable.initialize(), { probeCode: 'S3_ENDPOINT_UNREACHABLE' });
    assert.ok(Date.now() - startedAt < 8000, 'bounded');
    assert.equal(unreachable.lastProbe.status, 'error');
  });

  it('checks without changing anything through probe()', async () => {
    const config = { prefix: newPrefix() };
    const backend = backendFor(config);
    const result = await backend.probe();
    assert.equal(result.status, 'ok');
    assert.match(result.steps[2].detail, /first start writes it/);
    assert.deepEqual(s3.rawObjects(BUCKET, `${config.prefix}/`), []);
    assert.match(result.checkedAt, /^\d{4}-\d\d-\d\dT/);
  });

  it('with encryption off: uploads as they are, no key check object, still decrypts older blobs', async () => {
    const config = { prefix: newPrefix() };
    const encrypted = await started({ config });
    await encrypted.blobs.put('chat-files', 'old', 'written encrypted');
    await encrypted.provider.shutdown();

    const off = await started({ config, encryption: { enabled: false, plaintextReads: 'accept' } });
    assert.deepEqual(
      off.backend.lastProbe.steps.map(step => step.name),
      ['connect', 'detect', 'roundtrip']
    );
    assert.equal(off.backend.describe().encryption.scope, 'none');
    await off.blobs.put(
      'chat-files',
      'new',
      'written in plaintext, long enough to matter '.repeat(20)
    );
    assert.equal(
      s3
        .rawGet(BUCKET, `${config.prefix}/default/chat-files/new`)
        .toString()
        .startsWith('written in plaintext'),
      true
    );
    assert.equal((await off.blobs.get('chat-files', 'old')).data.toString(), 'written encrypted');
    assert.deepEqual((await off.blobs.list('chat-files')).items, [
      { key: 'new', bytes: 880 },
      { key: 'old', bytes: 17 }
    ]);

    // A bucket that never held an encrypted blob is not inspected at all.
    const plain = await started({ encryption: { enabled: false, plaintextReads: 'accept' } });
    await plain.blobs.put('chat-files', 'k', 'x'.repeat(2000));
    assert.equal(s3.rawObjects(BUCKET, `${plain.prefix}/`).length, 1, 'no key check object');
    s3.clearRequests();
    assert.deepEqual((await plain.blobs.list('chat-files')).items, [{ key: 'k', bytes: 2000 }]);
    assert.deepEqual(
      s3.requests.map(request => request.op),
      ['ListObjectsV2']
    );
  });
});

describe('S3 blob backend: composed provider', () => {
  it('keeps documents and locks on the base provider and never serves blobs from local disk', async () => {
    const { provider, baseDir, blobs } = await started();
    assert.equal(provider.name, 'filesystem');
    assert.equal(provider.blobBackend, 's3');
    assert.equal(provider.getCapabilities().blobStore, true);

    await provider.documents.put('some-docs', 'k', { ok: true });
    await blobs.put('chat-files', 'chat__c__f.txt', 'payload');
    assert.equal(fsSync.existsSync(path.join(baseDir, 'some-docs', 'k.json')), true);
    assert.equal(fsSync.existsSync(path.join(baseDir, 'blobs')), false, 'no local blob copy');

    const health = await provider.healthCheck();
    assert.equal(health.status, 'ok');
    assert.equal(health.provider, 'filesystem');
    assert.equal(health.details.blobs.provider, 's3');
    assert.equal(health.details.blobs.status, 'ok');

    s3.inject({ op: 'HeadBucket', status: 503 });
    const degraded = await provider.healthCheck();
    assert.equal(degraded.status, 'degraded');
    assert.equal(degraded.details.blobs.code, 'S3_SERVICE_ERROR');
  });

  it('warns about blobs still on the base provider, with counts', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-s3-leftovers-'));
    const { FilesystemStorageProvider } = await import('../storage/providers/filesystem/index.js');
    // With the switch on, as the provider composed below has it: a start
    // refuses a data directory with plaintext that was not converted.
    const keys = fixedKeys(keyModule);
    const before = new FilesystemStorageProvider({
      baseDir,
      fenceSweepIntervalMs: 0,
      encryption: { mode: 'auto', loadKeys: async () => keys }
    });
    await before.initialize();
    await before.blobs.put('chat-files', 'chat__a__1.txt', 'x');
    await before.blobs.put('chat-files', 'chat__a__2.txt', 'x');
    await before.blobs.put('artifacts', 'chat__a__art', 'x');
    await before.shutdown();

    const { provider, blobs } = await started({ baseDir });
    assert.deepEqual(provider.localBlobLeftovers, [
      { namespace: 'chat-files', count: 2, capped: false },
      { namespace: 'artifacts', count: 1, capped: false }
    ]);
    // Not read through: what is on disk is not served.
    assert.equal(await blobs.get('chat-files', 'chat__a__1.txt'), null);
  });

  it('fails the start instead of falling back when the backend cannot start', async () => {
    const composed = await composeS3Provider({
      s3,
      keys: fixedKeys(keyModule),
      config: { bucket: 'no-such-bucket' }
    });
    open.push(async () => {
      await composed.provider.shutdown();
      await fs.rm(composed.baseDir, { recursive: true, force: true });
    });
    await assert.rejects(composed.provider.initialize(), { probeCode: 'S3_BUCKET_NOT_FOUND' });
    await assert.rejects(composed.provider.blobs.put('chat-files', 'k', 'x'));
    assert.equal(fsSync.existsSync(path.join(composed.baseDir, 'blobs')), false);
  });
});

describe('S3 blob backend: configuration', () => {
  const valid = {
    endpoint: 'https://s3.example.internal:7070',
    bucket: 'ihub-blobs',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secret'
  };
  const invalid = (overrides, field) =>
    assert.throws(
      () => resolveS3BlobConfig({ ...valid, ...overrides }),
      error =>
        error.code === 'INVALID_STORAGE_CONFIG' &&
        error.field === field &&
        error.probeCode === 'S3_CONFIG_INCOMPLETE',
      `${field}: ${JSON.stringify(overrides)}`
    );

  it('fills in the defaults', () => {
    assert.deepEqual(resolveS3BlobConfig(valid), {
      endpoint: 'https://s3.example.internal:7070',
      endpointHost: 's3.example.internal:7070',
      insecureHttp: false,
      region: 'us-east-1',
      bucket: 'ihub-blobs',
      prefix: '',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'secret',
      forcePathStyle: true,
      allowInsecureHttp: false,
      maxObjectBytes: 128 * 1024 * 1024,
      connectTimeoutMs: 5000,
      requestTimeoutMs: 60000,
      maxAttempts: 3
    });
    const aws = resolveS3BlobConfig({ ...valid, endpoint: undefined, region: 'eu-central-1' });
    assert.equal(aws.endpoint, 'https://s3.eu-central-1.amazonaws.com');
    assert.equal(resolveS3BlobConfig({ ...valid, prefix: 'team/ihub/' }).prefix, 'team/ihub');
  });

  it('refuses a block that is missing or malformed, naming the field', () => {
    assert.throws(() => resolveS3BlobConfig(undefined), { code: 'INVALID_STORAGE_CONFIG' });
    invalid({ bucket: undefined }, 'bucket');
    invalid({ bucket: 'Has/Slash' }, 'bucket');
    invalid({ accessKeyId: '' }, 'accessKeyId');
    invalid({ secretAccessKey: undefined }, 'secretAccessKey');
    invalid({ secretAccessKey: '${IHUB_S3_SECRET_NOT_SET}' }, 'secretAccessKey');
    invalid({ endpoint: 'not a url' }, 'endpoint');
    invalid({ endpoint: 'ftp://host' }, 'endpoint');
    invalid({ endpoint: 'https://user:pass@host' }, 'endpoint');
    invalid({ endpoint: 'https://host/bucket' }, 'endpoint');
    invalid({ endpoint: 'https://host?x=1' }, 'endpoint');
    invalid({ endpoint: 'http://169.254.169.254' }, 'endpoint');
    invalid({ prefix: '../up' }, 'prefix');
    invalid({ prefix: '/leading' }, 'prefix');
    invalid({ prefix: 'a b' }, 'prefix');
    invalid({ region: 'EU West' }, 'region');
    invalid({ forcePathStyle: 'yes' }, 'forcePathStyle');
    invalid({ maxObjectBytes: -1 }, 'maxObjectBytes');
    invalid({ requestTimeoutMs: 0 }, 'requestTimeoutMs');
    invalid({ maxAttempts: 11 }, 'maxAttempts');
    assert.throws(
      () => resolveS3BlobConfig({ ...valid, secretAccessKey: '${IHUB_S3_SECRET_NOT_SET}' }),
      /IHUB_S3_SECRET_NOT_SET/
    );
  });

  it('refuses plain http unless the host is this machine or it was allowed', () => {
    invalid({ endpoint: 'http://s3.example.internal:7070' }, 'endpoint');
    assert.throws(
      () => resolveS3BlobConfig({ ...valid, endpoint: 'http://10.0.0.5:9000' }),
      /allowInsecureHttp/
    );
    for (const endpoint of [
      'http://127.0.0.1:9000',
      'http://localhost:9000',
      'http://[::1]:9000'
    ]) {
      assert.equal(resolveS3BlobConfig({ ...valid, endpoint }).insecureHttp, true, endpoint);
    }
    const allowed = resolveS3BlobConfig({
      ...valid,
      endpoint: 'http://s3.example.internal:7070',
      allowInsecureHttp: true
    });
    assert.equal(allowed.endpoint, 'http://s3.example.internal:7070');
    assert.equal(isLoopbackHost('127.0.0.2'), true);
    assert.equal(isLoopbackHost('127.0.0.1.example.com'), false);
    assert.equal(isLoopbackHost('localhost.example.com'), false);
  });

  it('resolves the backend from the file and the environment override', () => {
    const { resolveBlobStorageConfig } = storage;
    assert.deepEqual(resolveBlobStorageConfig({}, {}), {
      provider: 'default',
      source: 'default',
      config: {},
      platformConfig: { ssl: {}, proxy: {} },
      encryption: { enabled: false, plaintextReads: 'accept' }
    });
    process.env.IHUB_TEST_S3_BUCKET_NAME = 'from-env';
    try {
      const platform = {
        ssl: { ignoreInvalidCertificates: true, domainWhitelist: ['s3.internal'] },
        proxy: { https: '${IHUB_TEST_S3_BUCKET_NAME}' },
        storage: {
          encryption: { enabled: true },
          blobs: { provider: 's3', s3: { bucket: '${IHUB_TEST_S3_BUCKET_NAME}' } }
        }
      };
      const fromFile = resolveBlobStorageConfig(platform, {});
      assert.equal(fromFile.provider, 's3');
      assert.equal(fromFile.source, 'platform.json');
      assert.deepEqual(fromFile.config, { bucket: 'from-env' });
      assert.deepEqual(fromFile.platformConfig.ssl.domainWhitelist, ['s3.internal']);
      assert.equal(fromFile.platformConfig.proxy.https, 'from-env');
      assert.deepEqual(fromFile.encryption, { enabled: true, plaintextReads: 'reject' });

      const overridden = resolveBlobStorageConfig(platform, {
        IHUB_STORAGE_BLOBS_PROVIDER: 'default'
      });
      assert.equal(overridden.provider, 'default');
      assert.equal(overridden.source, 'environment');
      assert.deepEqual(overridden.encryption, { enabled: true, plaintextReads: 'accept' });
      assert.equal(
        resolveBlobStorageConfig({}, { IHUB_STORAGE_BLOBS_PROVIDER: 's3' }).provider,
        's3'
      );
      assert.equal(
        resolveBlobStorageConfig({ storage: { encryption: { enabled: 'yes' } } }, {}).encryption
          .enabled,
        false,
        'only the boolean true switches encryption on'
      );
    } finally {
      delete process.env.IHUB_TEST_S3_BUCKET_NAME;
    }
  });

  it('opens a secret stored as ENC[...] when it connects', async () => {
    await tokenStorageService.initializeEncryptionKey();
    const prefix = newPrefix();
    const backend = createS3BlobBackend(
      s3ConfigFor(s3, {
        prefix,
        secretAccessKey: tokenStorageService.encryptString(s3.secretAccessKey)
      }),
      { loadKeys: async () => keyModule, env: {} }
    );
    open.push(() => backend.shutdown());
    await backend.initialize();
    assert.equal(backend.lastProbe.status, 'ok');

    const broken = createS3BlobBackend(
      s3ConfigFor(s3, {
        prefix,
        secretAccessKey: 'ENC[AES256_GCM,data:AAAA,iv:AAAA,tag:AAAA,type:str]'
      }),
      { loadKeys: async () => keyModule, env: {} }
    );
    open.push(() => broken.shutdown());
    await assert.rejects(broken.initialize(), error => {
      assert.equal(error.probeCode, 'S3_CONFIG_INCOMPLETE');
      assert.match(error.message, /secretAccessKey/);
      return true;
    });
  });
});

describe('storage registry: blob backend', () => {
  afterEach(async () => {
    await storage.shutdownStorage();
  });

  const platformFor = (blobs, extra = {}) => ({
    storage: {
      provider: 'filesystem',
      filesystem: { baseDir: path.join(scratch, `data-${crypto.randomBytes(4).toString('hex')}`) },
      blobs,
      ...extra
    }
  });

  it('starts the composed provider from platform.json and reports it', async () => {
    const platformConfig = platformFor(
      { provider: 's3', s3: s3ConfigFor(s3, { prefix: newPrefix() }) },
      { encryption: { enabled: true } }
    );
    const check = await storage.probeBlobStorage({ platformConfig, env: {} });
    assert.equal(check.status, 'ok');
    assert.equal(check.provider, 's3');
    assert.equal(check.source, 'platform.json');

    const provider = await storage.initializeStorage({ platformConfig, env: {} });
    assert.equal(provider.blobBackend, 's3');
    assert.equal(provider.blobBackendHandle.describe().encryption.scope, 'all');
    await provider.blobs.put('chat-files', 'k', 'PLAINTEXT-CANARY');
    assert.equal((await provider.blobs.get('chat-files', 'k')).data.toString(), 'PLAINTEXT-CANARY');
  });

  it('fails like an unknown provider for an unknown or misconfigured blob backend', async () => {
    await assert.rejects(
      storage.initializeStorage({ platformConfig: platformFor({ provider: 'gcs' }), env: {} }),
      { code: 'UNKNOWN_PROVIDER' }
    );
    await assert.rejects(
      storage.initializeStorage({
        platformConfig: platformFor({ provider: 's3', s3: { bucket: 'ihub-test' } }),
        env: {}
      }),
      { code: 'INVALID_STORAGE_CONFIG' }
    );
    await assert.rejects(
      storage.initializeStorage({
        platformConfig: platformFor({
          provider: 's3',
          s3: s3ConfigFor(s3, { bucket: 'no-such-bucket' })
        }),
        env: {}
      }),
      { code: 'STORAGE_UNAVAILABLE', probeCode: 'S3_BUCKET_NOT_FOUND' }
    );
    assert.throws(() => storage.getStorageProvider(), { code: 'STORAGE_NOT_INITIALIZED' });

    const unknown = await storage.probeBlobStorage({
      platformConfig: platformFor({ provider: 'gcs' }),
      env: {}
    });
    assert.deepEqual(
      [unknown.status, unknown.error.code, unknown.error.step],
      ['error', 'BLOB_PROVIDER_UNKNOWN', 'config']
    );
    const incomplete = await storage.probeBlobStorage({
      platformConfig: platformFor({ provider: 's3', s3: {} }),
      env: {}
    });
    assert.equal(incomplete.error.code, 'S3_CONFIG_INCOMPLETE');
    assert.match(incomplete.error.detail, /storage\.blobs\.s3\.bucket is missing/);
  });

  it('uses the same access key the development server prints', () => {
    assert.equal(FAKE_S3_ACCESS_KEY_ID, 'ihub-dev-not-a-secret');
  });
});
