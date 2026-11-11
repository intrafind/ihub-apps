// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Where watermark keys may be sent (#3331): https always (except link-local),
 * plain http only to loopback and private addresses.
 */
import { describe, test, expect, afterEach } from '@jest/globals';
import configCache from '../configCache.js';
import { checkDetectorUrl } from '../services/provenance/watermark/detectorUrlPolicy.js';

afterEach(() => configCache.setCacheEntry('config/platform.json', {}));

const ok = async (url, resolve) => (await checkDetectorUrl(url, { resolve })).ok;

describe('checkDetectorUrl', () => {
  test('https to a public name is fine', async () => {
    expect(await ok('https://detector.example/detect', async () => ['93.184.216.34'])).toBe(true);
  });

  test.each([
    'http://127.0.0.1:9000/detect',
    'http://10.1.2.3/detect',
    'http://192.168.1.5/detect',
    'http://[::1]:9000/detect'
  ])('plain http to %s is fine', async url => {
    expect(await ok(url)).toBe(true);
  });

  test('plain http to a public IP or a public DNS name is refused', async () => {
    expect(await ok('http://93.184.216.34/detect')).toBe(false);
    expect(await ok('http://detector.example/detect', async () => ['93.184.216.34'])).toBe(false);
  });

  test('a name resolving to private and public addresses is refused for http', async () => {
    expect(await ok('http://mixed.example/detect', async () => ['10.0.0.5', '93.184.216.34'])).toBe(
      false
    );
  });

  test('a trusted host (ssl.domainWhitelist) may use http', async () => {
    configCache.setCacheEntry('config/platform.json', {
      ssl: { ignoreInvalidCertificates: true, domainWhitelist: ['detector.example'] }
    });
    expect(await ok('http://detector.example/detect', async () => ['93.184.216.34'])).toBe(true);
  });

  test('metadata and link-local addresses are refused, even over https', async () => {
    expect(await ok('http://169.254.169.254/latest')).toBe(false);
    expect(await ok('https://169.254.169.254/latest')).toBe(false);
    expect(await ok('https://meta.example/', async () => ['169.254.169.254'])).toBe(false);
    expect(await ok('https://[fe80::1]/')).toBe(false);
  });

  test('userinfo, other schemes and unresolvable names are refused', async () => {
    expect(await ok('https://user:pw@detector.example/', async () => ['93.184.216.34'])).toBe(
      false
    );
    expect(await ok('ftp://detector.example/')).toBe(false);
    expect(await ok('not a url')).toBe(false);
    expect(
      await ok('https://gone.example/', async () => {
        throw new Error('ENOTFOUND');
      })
    ).toBe(false);
  });
});
