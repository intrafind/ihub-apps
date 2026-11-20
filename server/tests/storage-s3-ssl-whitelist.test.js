// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The S3 blob backend honours `ssl.ignoreInvalidCertificates` +
 * `ssl.domainWhitelist` and the proxy settings (CLAUDE.md, "Outbound
 * Connections and the SSL Whitelist"), and takes them from the platform
 * configuration it is handed, not from the configuration cache: it connects
 * at storage bootstrap, before the cache exists.
 *
 * One fake S3 server with a self-signed certificate is reached under two host
 * names. `localhost` is on the whitelist, `127.0.0.1` is not.
 */
import './support/scratchContents.js';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeS3Server } from './support/fakeS3Server.js';
import { fixedKeys, s3ConfigFor } from './support/blobTestSupport.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-s3-tls-'));
const keyModule = await import('../crypto/KeyProvider.js');
const { createS3BlobBackend } = await import('../storage/providers/s3/index.js');
const { createDedicatedAgent, shouldIgnoreSSLForURL, readSSLConfig, TlsForwardingHttpsProxyAgent } =
  await import('../utils/httpConfig.js');
const { default: configCache } = await import('../configCache.js');

const WHITELIST = { ssl: { ignoreInvalidCertificates: true, domainWhitelist: ['localhost'] } };

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe('S3 transport: decision from the configuration it is handed', () => {
  it('bypasses verification only for a whitelisted host with the switch on', () => {
    const ssl = readSSLConfig(WHITELIST);
    assert.equal(shouldIgnoreSSLForURL('https://localhost:9000', ssl), true);
    assert.equal(shouldIgnoreSSLForURL('https://127.0.0.1:9000', ssl), false);
    assert.equal(
      shouldIgnoreSSLForURL(
        'https://localhost:9000',
        readSSLConfig({ ssl: { ignoreInvalidCertificates: false, domainWhitelist: ['localhost'] } })
      ),
      false
    );
    assert.equal(
      shouldIgnoreSSLForURL(
        'https://localhost:9000',
        readSSLConfig({ ssl: { ignoreInvalidCertificates: true, domainWhitelist: [] } })
      ),
      false
    );
  });

  it('builds a keep-alive agent of its own, with the bypass only for the whitelisted host', () => {
    // The cache says nothing; everything comes from the argument.
    assert.equal(configCache.getPlatform()?.ssl, undefined);
    const allowed = createDedicatedAgent('https://localhost:9000', {
      maxSockets: 7,
      platformConfig: { ...WHITELIST, proxy: { enabled: false } }
    });
    const denied = createDedicatedAgent('https://127.0.0.1:9000', {
      platformConfig: { ...WHITELIST, proxy: { enabled: false } }
    });
    try {
      assert.ok(allowed.agent instanceof https.Agent);
      assert.equal(allowed.agent.options.keepAlive, true);
      assert.equal(allowed.agent.maxSockets, 7);
      assert.equal(allowed.agent.options.rejectUnauthorized, false);
      assert.equal(allowed.tlsBypass, true);
      assert.equal(denied.agent.options.rejectUnauthorized, undefined);
      assert.equal(denied.tlsBypass, false);
      assert.notEqual(allowed.agent, denied.agent);
      assert.notEqual(allowed.agent, https.globalAgent);
    } finally {
      allowed.agent.destroy();
      denied.agent.destroy();
    }
    const plain = createDedicatedAgent('http://127.0.0.1:9000', {
      platformConfig: { ...WHITELIST, proxy: { enabled: false } }
    });
    assert.ok(plain.agent instanceof http.Agent);
    assert.equal(plain.tlsBypass, false);
    plain.agent.destroy();
  });

  it('routes through the proxy of the configuration it is handed, and honours noProxy', () => {
    const proxied = createDedicatedAgent('https://s3.example.internal', {
      platformConfig: { proxy: { https: 'http://proxy.example.internal:3128' } }
    });
    assert.equal(proxied.routing.decision, 'proxied');
    assert.ok(proxied.agent instanceof TlsForwardingHttpsProxyAgent);
    assert.equal(JSON.stringify(proxied.routing).includes('proxy.example.internal'), false);
    proxied.agent.destroy();

    const bypassed = createDedicatedAgent('https://s3.example.internal', {
      platformConfig: {
        proxy: { https: 'http://proxy.example.internal:3128', noProxy: 's3.example.internal' }
      }
    });
    assert.equal(bypassed.routing.decision, 'bypassed');
    assert.ok(bypassed.agent instanceof https.Agent);
    bypassed.agent.destroy();

    const disabled = createDedicatedAgent('https://s3.example.internal', {
      platformConfig: { proxy: { enabled: false, https: 'http://proxy.example.internal:3128' } }
    });
    assert.equal(disabled.routing.decision, 'disabled');
    disabled.agent.destroy();
  });
});

const opensslAvailable = spawnSync('openssl', ['version']).status === 0;

describe(
  'S3 transport: real TLS handshake with a self-signed certificate',
  { skip: opensslAvailable ? false : 'openssl is not installed' },
  () => {
    let s3;
    const backends = [];

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
      s3 = await startFakeS3Server({
        buckets: ['ihub-test'],
        tls: { key: fs.readFileSync(key), cert: fs.readFileSync(cert) }
      });
    });

    after(async () => {
      for (const backend of backends) await backend.shutdown();
      await s3?.close();
    });

    const backendFor = (hostname, platformConfig) => {
      const backend = createS3BlobBackend(
        s3ConfigFor(s3, {
          endpoint: s3.endpointFor(hostname),
          prefix: `tls-${hostname.replaceAll('.', '-')}-${backends.length}`,
          maxAttempts: 1
        }),
        { platformConfig, loadKeys: async () => fixedKeys(keyModule), env: {} }
      );
      backends.push(backend);
      return backend;
    };

    it('connects to the whitelisted host and stores a blob', async () => {
      const backend = backendFor('localhost', WHITELIST);
      await backend.initialize();
      await backend.blobs.put('chat-files', 'k', 'over tls');
      assert.equal((await backend.blobs.get('chat-files', 'k')).data.toString(), 'over tls');
    });

    it('rejects the certificate of the host that is not whitelisted', async () => {
      const backend = backendFor('127.0.0.1', WHITELIST);
      await assert.rejects(backend.initialize(), error => {
        assert.equal(error.code, 'STORAGE_UNAVAILABLE');
        assert.equal(error.probeCode, 'S3_TLS_UNTRUSTED');
        assert.equal(error.probe.error.step, 'connect');
        return true;
      });
    });

    it('rejects the whitelisted host too when the switch is off, or nothing was handed in', async () => {
      const off = backendFor('localhost', {
        ssl: { ignoreInvalidCertificates: false, domainWhitelist: ['localhost'] }
      });
      await assert.rejects(off.initialize(), { probeCode: 'S3_TLS_UNTRUSTED' });
      const none = backendFor('localhost', {});
      await assert.rejects(none.initialize(), { probeCode: 'S3_TLS_UNTRUSTED' });
    });
  }
);

describe('S3 provider: no certificate switch of its own', () => {
  it('holds no rejectUnauthorized literal; the bypass comes from httpConfig', () => {
    const dir = path.resolve(import.meta.dirname, '..', 'storage', 'providers', 's3');
    for (const name of fs.readdirSync(dir)) {
      const source = fs.readFileSync(path.join(dir, name), 'utf8');
      assert.equal(source.includes('rejectUnauthorized'), false, name);
      assert.equal(/NODE_TLS_REJECT_UNAUTHORIZED/.test(source), false, name);
    }
    const client = fs.readFileSync(path.join(dir, 's3Client.js'), 'utf8');
    assert.match(client, /createDedicatedAgent/);
    assert.equal(/logger\s*:/.test(client), false, 'no logger is handed to the SDK');
  });
});
