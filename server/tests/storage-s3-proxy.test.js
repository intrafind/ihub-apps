// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The S3 blob backend sends its requests through the platform's proxy
 * (`proxy.http` / `proxy.https` in platform.json) and goes direct for a host
 * on `proxy.noProxy`, with real requests through a recording proxy.
 *
 * `storage-s3-ssl-whitelist.test.js` checks which agent class is built for a
 * given configuration. This file checks where the bytes actually go: a wrong
 * agent wired into the SDK would pass there and fail here.
 *
 * The proxy settings come from the platform configuration handed to the
 * backend and, when that says nothing, from HTTP_PROXY / HTTPS_PROXY /
 * NO_PROXY. The environment of the machine running the tests must not decide
 * the outcome, so those variables are removed before anything is imported.
 */
for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY']) {
  delete process.env[name];
  delete process.env[name.toLowerCase()];
}

// First server-related import: it points CONTENTS_DIR at a scratch directory.
await import('./support/scratchContents.js');
const { spawnSync } = await import('node:child_process');
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const crypto = await import('node:crypto');
const { after, afterEach, before, describe, it } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { startFakeS3Server } = await import('./support/fakeS3Server.js');
const { startRecordingProxy } = await import('./support/recordingProxy.js');
const { fixedKeys, s3ConfigFor } = await import('./support/blobTestSupport.js');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-s3-proxy-'));
const keyModule = await import('../crypto/KeyProvider.js');
const { createS3BlobBackend } = await import('../storage/providers/s3/index.js');

const PROXY_SECRET = `proxy-pass-${crypto.randomBytes(6).toString('hex')}`;

let s3;
let proxy;
const backends = [];

before(async () => {
  s3 = await startFakeS3Server({ buckets: ['ihub-test'] });
  proxy = await startRecordingProxy();
});

afterEach(() => {
  s3.clearRequests();
  proxy.requests.length = 0;
});

after(async () => {
  for (const backend of backends) await backend.shutdown().catch(() => {});
  await proxy.close();
  await s3.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** A backend on the fake (or `server`) with this platform configuration. */
function backendFor(platformConfig, { server = s3, config = {} } = {}) {
  const backend = createS3BlobBackend(
    s3ConfigFor(server, {
      prefix: `proxy-${crypto.randomBytes(4).toString('hex')}`,
      maxAttempts: 1,
      connectTimeoutMs: 2000,
      requestTimeoutMs: 5000,
      ...config
    }),
    { platformConfig, loadKeys: async () => fixedKeys(keyModule), env: {} }
  );
  backends.push(backend);
  return backend;
}

/** Start, write, read, list and delete one blob. */
async function roundTrip(backend) {
  await backend.initialize();
  await backend.blobs.put('chat-files', 'k', 'through or around the proxy');
  assert.equal(
    (await backend.blobs.get('chat-files', 'k')).data.toString(),
    'through or around the proxy'
  );
  assert.equal((await backend.blobs.list('chat-files')).items.length, 1);
  assert.equal(await backend.blobs.delete('chat-files', 'k'), true);
}

describe('S3 blob backend and the platform proxy (plain http endpoint)', () => {
  it('sends every request through proxy.http', async () => {
    await roundTrip(backendFor({ proxy: { http: proxy.url } }));
    assert.ok(s3.requests.length >= 6, `${s3.requests.length} requests reached the bucket`);
    assert.equal(
      proxy.requests.length,
      s3.requests.length,
      'every request the bucket saw came through the proxy'
    );
    for (const request of proxy.requests) {
      assert.equal(request.kind, 'forward');
      assert.ok(request.target.startsWith(`${s3.endpoint}/ihub-test`), request.target);
    }
    assert.deepEqual([...new Set(s3.requests.map(request => request.op))].sort(), [
      'DeleteObject',
      'GetObject',
      'HeadBucket',
      'HeadObject',
      'ListObjectsV2',
      'PutObject'
    ]);
  });

  it('goes direct for a host on proxy.noProxy, and when the proxy is switched off', async () => {
    await roundTrip(backendFor({ proxy: { http: proxy.url, noProxy: '127.0.0.1' } }));
    assert.ok(s3.requests.length >= 6);
    assert.deepEqual(proxy.requests, [], 'a no-proxy host went through the proxy');

    s3.clearRequests();
    await roundTrip(
      backendFor({ proxy: { http: proxy.url, noProxy: ['localhost', '127.0.0.1'] } })
    );
    assert.deepEqual(proxy.requests, []);

    s3.clearRequests();
    await roundTrip(backendFor({ proxy: { enabled: false, http: proxy.url } }));
    assert.ok(s3.requests.length >= 6);
    assert.deepEqual(proxy.requests, []);
  });

  it('does not treat another host on noProxy as a reason to bypass', async () => {
    await roundTrip(backendFor({ proxy: { http: proxy.url, noProxy: 'localhost,.internal' } }));
    assert.equal(proxy.requests.length, s3.requests.length);
  });

  it('only uses the proxy for URLs that match proxy.urlPatterns, when patterns are set', async () => {
    await roundTrip(
      backendFor({ proxy: { http: proxy.url, urlPatterns: ['^https://only\\.this\\.example/'] } })
    );
    assert.deepEqual(proxy.requests, []);
  });

  it('fails as STORAGE_UNAVAILABLE when the proxy is down, and does not go around it', async () => {
    const dead = await startRecordingProxy();
    const url = dead.url;
    await dead.close();
    const backend = backendFor({ proxy: { http: url } });
    await assert.rejects(backend.initialize(), error => {
      assert.equal(error.code, 'STORAGE_UNAVAILABLE', error.message);
      assert.equal(error.probeCode, 'S3_ENDPOINT_UNREACHABLE', error.message);
      return true;
    });
    assert.deepEqual(s3.requests, [], 'the bucket was reached without the proxy');
  });

  it('authenticates to the proxy with the credentials of its URL and keeps them out of errors', async () => {
    const withCredentials = proxy.url.replace('http://', `http://ihub:${PROXY_SECRET}@`);
    await roundTrip(backendFor({ proxy: { http: withCredentials } }));
    const expected = `Basic ${Buffer.from(`ihub:${PROXY_SECRET}`).toString('base64')}`;
    for (const request of proxy.requests) {
      assert.equal(request.headers['proxy-authorization'], expected, request.target);
    }
    for (const request of s3.requests) {
      assert.equal(request.headers['proxy-authorization'], undefined);
    }

    const backend = backendFor(
      { proxy: { http: withCredentials } },
      { config: { bucket: 'no-such-bucket' } }
    );
    await assert.rejects(backend.initialize(), error => {
      const text = [
        error.message,
        JSON.stringify(error.probe),
        String(error.cause?.message)
      ].join();
      assert.equal(text.includes(PROXY_SECRET), false, 'the proxy password is in the error');
      return true;
    });
    assert.equal(JSON.stringify(backend.describe()).includes(PROXY_SECRET), false);
  });
});

const opensslAvailable = spawnSync('openssl', ['version']).status === 0;

describe(
  'S3 blob backend and the platform proxy (https endpoint, CONNECT tunnel)',
  { skip: opensslAvailable ? false : 'openssl is not installed' },
  () => {
    let tlsS3;

    before(async () => {
      const key = path.join(scratch, 'key.pem');
      const cert = path.join(scratch, 'cert.pem');
      const made = spawnSync('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1'
      ]);
      if (made.status !== 0) throw new Error(`openssl failed: ${made.stderr}`);
      tlsS3 = await startFakeS3Server({
        buckets: ['ihub-test'],
        tls: { key: fs.readFileSync(key), cert: fs.readFileSync(cert) }
      });
    });

    after(() => tlsS3?.close());

    const WHITELIST = { ignoreInvalidCertificates: true, domainWhitelist: ['localhost'] };
    const viaLocalhost = () => ({
      server: tlsS3,
      config: { endpoint: tlsS3.endpointFor('localhost') }
    });

    it('tunnels through proxy.https and applies the SSL whitelist inside the tunnel', async () => {
      await roundTrip(backendFor({ ssl: WHITELIST, proxy: { https: proxy.url } }, viaLocalhost()));
      assert.ok(tlsS3.requests.length >= 6);
      assert.ok(proxy.requests.length >= 1, 'no tunnel was opened');
      for (const request of proxy.requests) {
        assert.equal(request.kind, 'connect');
        assert.equal(request.target, `localhost:${tlsS3.port}`);
      }
    });

    it('still rejects a certificate that is not whitelisted when the request goes through the proxy', async () => {
      const backend = backendFor(
        {
          ssl: { ignoreInvalidCertificates: true, domainWhitelist: ['other.example'] },
          proxy: { https: proxy.url }
        },
        viaLocalhost()
      );
      await assert.rejects(backend.initialize(), { probeCode: 'S3_TLS_UNTRUSTED' });
      assert.ok(proxy.requests.length >= 1, 'the attempt did not go through the proxy');
    });

    it('goes direct for an https host on proxy.noProxy', async () => {
      tlsS3.clearRequests();
      await roundTrip(
        backendFor(
          { ssl: WHITELIST, proxy: { https: proxy.url, noProxy: 'localhost' } },
          viaLocalhost()
        )
      );
      assert.ok(tlsS3.requests.length >= 6);
      assert.deepEqual(proxy.requests, []);
    });
  }
);
