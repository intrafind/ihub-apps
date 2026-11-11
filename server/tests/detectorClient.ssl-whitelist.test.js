// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The detector call honours `ssl.ignoreInvalidCertificates` + `ssl.domainWhitelist`
 * (CLAUDE.md, "Outbound Connections and the SSL Whitelist"): a self-signed
 * detector works only when its host is whitelisted. Both calls go through
 * `DetectorClient`, so a bare `fetch` in it would fail this test.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import configCache from '../configCache.js';
import { shouldIgnoreSSLForURL } from '../utils/httpConfig.js';
import { callDetector } from '../services/provenance/watermark/DetectorClient.js';
import { startMockDetector } from './helpers/mockWatermarkDetector.js';

const setSsl = ssl => configCache.setCacheEntry('config/platform.json', { ssl });

describe('detector SSL whitelist: decision', () => {
  afterEach(() => configCache.setCacheEntry('config/platform.json', {}));

  test('whitelisted host skips verification; others and a disabled switch do not', () => {
    setSsl({ ignoreInvalidCertificates: true, domainWhitelist: ['detector.internal'] });
    expect(shouldIgnoreSSLForURL('https://detector.internal/detect')).toBe(true);
    expect(shouldIgnoreSSLForURL('https://other.example/detect')).toBe(false);
    setSsl({ ignoreInvalidCertificates: false, domainWhitelist: ['detector.internal'] });
    expect(shouldIgnoreSSLForURL('https://detector.internal/detect')).toBe(false);
  });
});

const opensslAvailable = spawnSync('openssl', ['version']).status === 0;

(opensslAvailable ? describe : describe.skip)('detector SSL whitelist: real TLS handshake', () => {
  let dir;
  let mock;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-wm-tls-'));
    const key = path.join(dir, 'key.pem');
    const cert = path.join(dir, 'cert.pem');
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
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1'
    ]);
    if (made.status !== 0) throw new Error(`openssl failed: ${made.stderr}`);
    const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) });
    mock = await startMockDetector({ token: 'tls-token-1234567', server });
    configCache.setCacheEntry('config/credentials.json', {
      credentials: { d: { id: 'd', type: 'bearer', token: 'tls-token-1234567' } }
    });
  });
  afterAll(async () => {
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
    configCache.setCacheEntry('config/platform.json', {});
  });

  const call = () =>
    callDetector({
      url: mock.url,
      credentialRef: 'd',
      text: 'a b c',
      keys: [{ keyId: 'k', key: 5 }],
      tokenizer: 't',
      timeoutMs: 3000
    });

  test('a whitelisted host with a self-signed certificate succeeds', async () => {
    setSsl({ ignoreInvalidCertificates: true, domainWhitelist: ['127.0.0.1'] });
    const answer = await call();
    expect(answer.results).toHaveLength(1);
  });

  test('a host that is not whitelisted fails the certificate check', async () => {
    setSsl({ ignoreInvalidCertificates: true, domainWhitelist: ['detector.internal'] });
    await expect(call()).rejects.toMatchObject({
      code: 'WATERMARK_DETECTOR_UNREACHABLE',
      details: { reason: 'network' }
    });
  });

  test('without the switch even a whitelisted host fails', async () => {
    setSsl({ ignoreInvalidCertificates: false, domainWhitelist: ['127.0.0.1'] });
    await expect(call()).rejects.toMatchObject({ code: 'WATERMARK_DETECTOR_UNREACHABLE' });
  });
});
