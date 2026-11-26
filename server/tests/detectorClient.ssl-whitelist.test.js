// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The detector call honours `ssl.ignoreInvalidCertificates` + `ssl.domainWhitelist`
 * (CLAUDE.md, "Outbound Connections and the SSL Whitelist"): a self-signed
 * detector works only when its host is whitelisted. Both calls go through
 * `DetectorClient`, so a bare `fetch` in it would fail this test.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import https from 'node:https';
import configCache from '../configCache.js';
import { shouldIgnoreSSLForURL } from '../utils/httpConfig.js';
import { callDetector } from '../services/provenance/watermark/DetectorClient.js';
import { startMockDetector } from './helpers/mockWatermarkDetector.js';
import { createSelfSignedCertificate, opensslAvailable } from './helpers/selfSignedCertificate.js';

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

(opensslAvailable ? describe : describe.skip)('detector SSL whitelist: real TLS handshake', () => {
  let certificate;
  let mock;

  beforeAll(async () => {
    certificate = createSelfSignedCertificate('ihub-wm-tls-');
    const server = https.createServer({ key: certificate.key, cert: certificate.cert });
    mock = await startMockDetector({ token: 'tls-token-1234567', server });
    configCache.setCacheEntry('config/credentials.json', {
      credentials: { d: { id: 'd', type: 'bearer', token: 'tls-token-1234567' } }
    });
  });
  afterAll(async () => {
    await mock.close();
    certificate.remove();
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
