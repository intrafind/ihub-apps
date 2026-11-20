// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `GET /api/admin/storage` and `POST /api/admin/storage/_test`
 * (server/routes/admin/storage.js) against a filesystem provider whose blobs
 * are on the in-repo fake S3 server.
 *
 * What the admin page depends on: the body shape; no credential and no
 * endpoint URL in any answer; only an administrator gets an answer; a read
 * does not contact the bucket more than once a minute; a failed test is a 200
 * that says so; a saved configuration that differs from the running one is
 * reported.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const scratch = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ihub-admin-storage-'));
process.env.CONTENTS_DIR = path.join(scratch, 'contents');
fsSync.mkdirSync(path.join(scratch, 'contents', 'config'), { recursive: true });

const keyModule = await import('../crypto/KeyProvider.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const {
  default: registerAdminStorageRoutes,
  createStorageStatusReader,
  hostOnly
} = await import('../routes/admin/storage.js');
const { composeBlobBackend } = await import('../storage/index.js');
const { FilesystemStorageProvider } = await import('../storage/providers/filesystem/index.js');
const { composeS3Provider, fixedKeys, s3ConfigFor } = await import('./support/blobTestSupport.js');
const { startFakeS3Server } = await import('./support/fakeS3Server.js');

const ACCESS_KEY_ID = 'AKIDSTORAGEROUTETEST';
const SECRET_ACCESS_KEY = 'wJalrXUtnFEMI-K7MDENG-routeTestSecret';
const CREDENTIALS = { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY };
const USERS = {
  admin: { id: 'root', name: 'Root', isAdmin: true, groups: ['admins'] },
  user: { id: 'u1', name: 'User', isAdmin: false, groups: ['users'] },
  anonymous: { id: 'anonymous', name: 'Anonymous', groups: ['anonymous'] }
};

let s3;
let provider;
let clock;
const servers = [];

/** `platform.json` as saved, matching the running backend unless overridden. */
const savedPlatform = (s3Overrides = {}, storageOverrides = {}) => ({
  storage: {
    encryption: { enabled: true },
    blobs: { provider: 's3', s3: s3ConfigFor(s3, { ...CREDENTIALS, ...s3Overrides }) },
    ...storageOverrides
  }
});

/**
 * An HTTP server with the routes, the real admin check and the real error
 * answers. The caller is named by the `x-test-user` header; none means no user.
 */
async function serve(deps) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const name = req.get('x-test-user');
    if (name) req.user = USERS[name];
    next();
  });
  registerAdminStorageRoutes(app, deps);
  app.use(errorHandler);
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  return async (method, route, user) => {
    const response = await fetch(`${origin}${route}`, {
      method,
      headers: user ? { 'x-test-user': user } : {}
    });
    const text = await response.text();
    return {
      status: response.status,
      type: response.headers.get('content-type') || '',
      cacheControl: response.headers.get('cache-control'),
      text,
      body: text ? JSON.parse(text) : null
    };
  };
}

/** How many requests the fake server has seen. */
const bucketRequests = () => s3.requests.length;

/** Nothing an admin answer may hold. */
function assertNoSecrets(text) {
  assert.equal(text.includes(SECRET_ACCESS_KEY), false, 'the secret key is not in the answer');
  assert.equal(text.includes(ACCESS_KEY_ID), false, 'the access key ID is not in the answer');
  assert.equal(/https?:\/\//.test(text), false, 'no URL is in the answer');
  assert.equal(text.includes('REDACTED'), false, 'no redaction marker is in the answer');
  assert.equal(/secretAccessKey|accessKeyId/.test(text), false, 'no credential field is named');
}

before(async () => {
  s3 = await startFakeS3Server({ buckets: ['ihub-test'], accessKeyId: ACCESS_KEY_ID });
  const composed = await composeS3Provider({
    s3,
    keys: fixedKeys(keyModule),
    config: CREDENTIALS
  });
  provider = composed.provider;
  // A blob from before the switch, still on local disk.
  await provider.base.blobs.put('chat-files', 'chat__a__f1.txt', 'left behind');
  await provider.initialize();
  clock = { now: Date.now() };
});

after(async () => {
  for (const server of servers) await new Promise(resolve => server.close(resolve));
  await provider.shutdown();
  await s3.close();
  await fs.rm(scratch, { recursive: true, force: true });
});

const deps = (overrides = {}) => ({
  getProvider: () => provider,
  loadPlatformConfig: async () => savedPlatform(),
  env: {},
  now: () => clock.now,
  ...overrides
});

describe('GET /api/admin/storage', () => {
  it('answers an administrator with the status of the running blob storage', async () => {
    const call = await serve(deps());
    const response = await call('GET', '/api/admin/storage', 'admin');

    assert.equal(response.status, 200);
    assert.equal(response.cacheControl, 'no-store');
    const { blobs } = response.body;
    assert.equal(blobs.provider, 's3');
    assert.equal(blobs.status, 'ok');
    assert.equal(typeof blobs.latencyMs, 'number');
    assert.ok(!Number.isNaN(Date.parse(blobs.checkedAt)));
    assert.deepEqual(blobs.location, {
      endpointHost: new URL(s3.endpoint).host,
      bucket: 'ihub-test',
      region: 'us-east-1',
      prefix: 'default/'
    });
    assert.equal(blobs.encryption.scope, 'all');
    assert.equal(typeof blobs.encryption.format, 'string');
    assert.equal(blobs.encryption.keySource, 'local-file');
    assert.equal(blobs.source, 'platform.json');
    assert.equal(blobs.error, undefined);
    assert.deepEqual(
      blobs.steps.map(step => [step.name, step.status]),
      [
        ['key', 'ok'],
        ['connect', 'ok'],
        ['keycheck', 'ok'],
        ['roundtrip', 'ok']
      ]
    );
    assert.deepEqual(response.body.documents, { provider: 'filesystem' });
    assert.equal(response.body.restartRequired, false);
    assert.equal(response.body.configuredBlobProvider, 's3');
    assert.deepEqual(response.body.localLeftovers, [
      { namespace: 'chat-files', count: 1, capped: false }
    ]);
    assert.equal(response.body.encryption.enabled, true);
    assert.equal(response.body.encryption.scope, 'blobs');
    assert.equal(response.body.encryption.conversion.state, 'none');
    assertNoSecrets(response.text);
  });

  it('refuses a caller who is not an administrator, and one who is not signed in', async () => {
    const call = await serve(deps());
    const before = bucketRequests();
    for (const user of ['user', 'anonymous', null]) {
      for (const [method, route] of [
        ['GET', '/api/admin/storage'],
        ['POST', '/api/admin/storage/_test']
      ]) {
        const response = await call(method, route, user);
        assert.equal(response.status, 403, `${method} ${route} as ${user}`);
        assert.match(response.type, /application\/problem\+json/);
        assert.equal(response.body.code, 'FORBIDDEN');
        assert.equal(response.body.blobs, undefined);
        assertNoSecrets(response.text);
      }
    }
    assert.equal(bucketRequests(), before, 'a refused caller never reaches the bucket');
  });

  it('does not contact the bucket on a read, and refreshes at most once a minute', async () => {
    clock.now = Date.now();
    const call = await serve(deps());
    const first = await call('GET', '/api/admin/storage', 'admin');
    const before = bucketRequests();
    for (let i = 0; i < 5; i += 1) await call('GET', '/api/admin/storage', 'admin');
    assert.equal(bucketRequests(), before, 'reads within a minute serve the held result');

    clock.now += 61_000;
    const refreshed = await call('GET', '/api/admin/storage', 'admin');
    const afterRefresh = bucketRequests();
    assert.ok(afterRefresh > before, 'a held result older than a minute is refreshed');
    assert.notEqual(refreshed.body.blobs.checkedAt, undefined);
    assert.ok(Date.parse(refreshed.body.blobs.checkedAt) >= Date.parse(first.body.blobs.checkedAt));

    for (let i = 0; i < 5; i += 1) await call('GET', '/api/admin/storage', 'admin');
    assert.equal(bucketRequests(), afterRefresh, 'and then held again');
  });

  it('answers with the held result when a refresh takes too long', async () => {
    let release;
    const slow = {
      name: 's3',
      remote: true,
      lastProbe: { status: 'ok', latencyMs: 5, checkedAt: '2020-01-01T00:00:00.000Z', steps: [] },
      describe: () => ({ provider: 's3', location: {}, encryption: { scope: 'all' } }),
      probe: () => new Promise(resolve => (release = resolve))
    };
    const reader = createStorageStatusReader(
      deps({
        getProvider: () => ({ name: 'filesystem', blobBackendHandle: slow }),
        waitMs: 20
      })
    );
    const body = await reader.read();
    assert.equal(body.blobs.status, 'ok');
    assert.equal(body.blobs.checkedAt, '2020-01-01T00:00:00.000Z');
    release(null);
  });

  it('reports a saved configuration that differs from the running one', async () => {
    const restart = async loadPlatformConfig => {
      const call = await serve(deps({ loadPlatformConfig }));
      const response = await call('GET', '/api/admin/storage', 'admin');
      assert.equal(response.status, 200);
      assertNoSecrets(response.text);
      return response.body;
    };
    assert.equal((await restart(async () => savedPlatform())).restartRequired, false);
    assert.equal(
      (await restart(async () => savedPlatform({ bucket: 'another-bucket' }))).restartRequired,
      true
    );
    assert.equal(
      (await restart(async () => savedPlatform({ prefix: 'prod' }))).restartRequired,
      true
    );
    assert.equal(
      (await restart(async () => savedPlatform({}, { encryption: { enabled: false } })))
        .restartRequired,
      true
    );
    // A saved block that is not valid is not what the server runs with either.
    assert.equal(
      (await restart(async () => savedPlatform({ bucket: undefined }))).restartRequired,
      true
    );
    const backToDisk = await restart(async () => ({ storage: { encryption: { enabled: true } } }));
    assert.equal(backToDisk.restartRequired, true);
    assert.equal(backToDisk.configuredBlobProvider, 'filesystem');
    assert.equal(backToDisk.blobs.provider, 's3', 'the running backend is still reported');
    // No file at all: the defaults, which are not what runs here.
    assert.equal((await restart(async () => null)).restartRequired, true);
  });

  it('names the environment when it decides the backend', async () => {
    const call = await serve(
      deps({
        env: { IHUB_STORAGE_BLOBS_PROVIDER: 's3' },
        loadPlatformConfig: async () => {
          const platform = savedPlatform();
          delete platform.storage.blobs.provider;
          return platform;
        }
      })
    );
    const response = await call('GET', '/api/admin/storage', 'admin');
    assert.equal(response.body.blobs.source, 'environment');
    assert.equal(response.body.restartRequired, false);
  });

  it('describes blobs the storage provider keeps itself', async () => {
    const baseDir = path.join(scratch, 'local-only', 'data');
    const local = composeBlobBackend(
      new FilesystemStorageProvider({ baseDir, fenceSweepIntervalMs: 0 }),
      { provider: 'default', encryption: { enabled: false, plaintextReads: 'accept' } }
    );
    await local.initialize();
    try {
      const call = await serve(
        deps({ getProvider: () => local, loadPlatformConfig: async () => ({}) })
      );
      const response = await call('GET', '/api/admin/storage', 'admin');
      assert.equal(response.status, 200);
      assert.equal(response.body.blobs.provider, 'filesystem');
      assert.equal(response.body.blobs.status, 'ok');
      assert.equal(response.body.blobs.location.path, path.join(baseDir, 'blobs'));
      assert.equal(response.body.blobs.location.endpointHost, undefined);
      assert.deepEqual(response.body.blobs.encryption, { scope: 'none' });
      assert.equal(response.body.blobs.source, 'default');
      assert.equal(response.body.configuredBlobProvider, 'filesystem');
      assert.equal(response.body.restartRequired, false);
      assert.deepEqual(response.body.localLeftovers, []);
      assert.equal(response.body.encryption.enabled, false);
      assert.equal(response.body.encryption.scope, 'none');
      assert.equal(response.body.encryption.conversion.state, 'none');
      assert.equal(JSON.stringify(response.body).includes('null'), false, 'no null members');
    } finally {
      await local.shutdown();
    }
  });

  it('passes on what the provider says about encryption, and falls back when it says nothing', async () => {
    const backend = {
      name: 'default',
      remote: false,
      lastProbe: null,
      describe: () => ({ provider: 'default', encryption: { scope: 'all' } }),
      probe: async () => null
    };
    const described = {
      enabled: true,
      scope: 'storage',
      conversion: { state: 'converting', facets: { blobs: 1 }, keyId: null, skipped: 0 },
      sealedDataExists: true
    };
    const read = getProvider =>
      createStorageStatusReader(
        deps({
          getProvider,
          loadPlatformConfig: async () => ({ storage: { encryption: { enabled: true } } })
        })
      ).read();
    const own = await read(() => ({
      name: 'filesystem',
      blobBackendHandle: backend,
      describeEncryption: () => described
    }));
    assert.deepEqual(own.encryption, {
      enabled: true,
      scope: 'storage',
      conversion: { state: 'converting', facets: { blobs: 1 }, skipped: 0 },
      sealedDataExists: true
    });
    assert.equal(own.blobs.status, 'unknown');

    const silent = await read(() => ({ name: 'filesystem', blobBackendHandle: backend }));
    assert.deepEqual(silent.encryption, {
      enabled: true,
      scope: 'blobs',
      conversion: { state: 'none' }
    });
  });

  it('answers 503 as a problem when the storage provider is not running', async () => {
    const call = await serve(deps({ getProvider: () => null }));
    for (const [method, route] of [
      ['GET', '/api/admin/storage'],
      ['POST', '/api/admin/storage/_test']
    ]) {
      const response = await call(method, route, 'admin');
      assert.equal(response.status, 503);
      assert.match(response.type, /application\/problem\+json/);
      assert.equal(response.body.code, 'STORAGE_UNAVAILABLE');
    }
  });
});

describe('POST /api/admin/storage/_test', () => {
  it('runs the check against the bucket and answers with the same body as the read', async () => {
    const call = await serve(deps());
    const before = bucketRequests();
    const response = await call('POST', '/api/admin/storage/_test', 'admin');
    assert.equal(response.status, 200);
    assert.equal(response.cacheControl, 'no-store');
    assert.equal(response.body.blobs.status, 'ok');
    assert.equal(response.body.blobs.provider, 's3');
    assert.ok(bucketRequests() > before, 'the test contacts the bucket');
    assert.deepEqual(Object.keys(response.body).sort(), [
      'blobs',
      'configuredBlobProvider',
      'documents',
      'encryption',
      'localLeftovers',
      'restartRequired'
    ]);
    assertNoSecrets(response.text);
    // The test object is gone again.
    assert.deepEqual(
      s3.rawObjects('ihub-test').map(object => object.key),
      ['default/_ihub/keycheck']
    );
  });

  it('answers 200 with the failure when the bucket does not answer, and the read shows it', async () => {
    const call = await serve(deps());
    s3.removeBucket('ihub-test');
    try {
      const response = await call('POST', '/api/admin/storage/_test', 'admin');
      assert.equal(response.status, 200, 'a failed test is still a test that ran');
      assert.equal(response.body.blobs.status, 'error');
      assert.equal(response.body.blobs.error.code, 'S3_BUCKET_NOT_FOUND');
      assert.equal(response.body.blobs.error.step, 'connect');
      assert.equal(typeof response.body.blobs.error.detail, 'string');
      assert.match(response.body.blobs.error.hint, /does not create buckets/);
      assert.deepEqual(
        response.body.blobs.steps.map(step => step.status),
        ['ok', 'failed', 'skipped', 'skipped']
      );
      assertNoSecrets(response.text);

      const read = await call('GET', '/api/admin/storage', 'admin');
      assert.equal(read.body.blobs.status, 'error');
      assert.equal(read.body.blobs.error.code, 'S3_BUCKET_NOT_FOUND');
      assertNoSecrets(read.text);
    } finally {
      s3.addBucket('ihub-test');
    }
  });

  it('reports refused access without repeating the credentials', async () => {
    const call = await serve(deps());
    // A HeadBucket answer has no body, so a 403 there is "access denied".
    const stop = s3.inject({ status: 403, code: 'AccessDenied' });
    try {
      const response = await call('POST', '/api/admin/storage/_test', 'admin');
      assert.equal(response.status, 200);
      assert.equal(response.body.blobs.status, 'error');
      assert.equal(response.body.blobs.error.code, 'S3_ACCESS_DENIED');
      assertNoSecrets(response.text);
    } finally {
      if (typeof stop === 'function') stop();
      s3.clearInjections();
    }
  });

  it('shares one check between concurrent calls', async () => {
    let probes = 0;
    const backend = {
      name: 's3',
      remote: true,
      lastProbe: null,
      describe: () => ({ provider: 's3', location: {}, encryption: { scope: 'all' } }),
      probe: async () => {
        probes += 1;
        await new Promise(resolve => setTimeout(resolve, 20));
        backend.lastProbe = {
          status: 'ok',
          latencyMs: 20,
          checkedAt: new Date().toISOString(),
          steps: []
        };
        return backend.lastProbe;
      }
    };
    const reader = createStorageStatusReader(
      deps({ getProvider: () => ({ name: 'filesystem', blobBackendHandle: backend }) })
    );
    const results = await Promise.all([reader.test(), reader.test(), reader.test()]);
    assert.equal(probes, 1);
    assert.ok(results.every(body => body.blobs.status === 'ok'));
  });
});

describe('hostOnly', () => {
  it('keeps the host and port and drops everything else', () => {
    assert.equal(hostOnly('s3.example.internal:9000'), 's3.example.internal:9000');
    assert.equal(
      hostOnly('https://key:secret@s3.example.internal:9000/bucket?x=1#y'),
      's3.example.internal:9000'
    );
    assert.equal(hostOnly('key:secret@s3.example.internal'), 's3.example.internal');
    assert.equal(hostOnly(''), undefined);
    assert.equal(hostOnly(undefined), undefined);
    assert.equal(hostOnly('http://'), undefined);
  });
});
