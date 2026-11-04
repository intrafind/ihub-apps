// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The whitelist decision behind `enhanceFetchOptions`, which `read_url` (tools/webContentExtractor.js) calls
 * for every hop: certificate verification is skipped only for a host on
 * `ssl.domainWhitelist` while `ssl.ignoreInvalidCertificates` is on.
 */

import { afterEach, describe, expect, test } from '@jest/globals';
import configCache from '../configCache.js';
import { shouldIgnoreSSLForURL } from '../utils/httpConfig.js';

function setSsl(ssl) {
  configCache.setCacheEntry('config/platform.json', { ssl });
}

// `createAgent` (and so `enhanceFetchOptions`, which `read_url` calls for every
// hop) turns exactly this decision into `rejectUnauthorized: false`.
const skipsVerification = url => shouldIgnoreSSLForURL(url);

afterEach(() => {
  configCache.setCacheEntry('config/platform.json', {});
});

describe('shouldIgnoreSSLForURL and ssl.domainWhitelist', () => {
  test('skips certificate verification for a whitelisted host', () => {
    setSsl({ ignoreInvalidCertificates: true, domainWhitelist: ['internal.example'] });
    expect(skipsVerification('https://internal.example/page')).toBe(true);
  });

  test('keeps verification for a host that is not whitelisted', () => {
    setSsl({ ignoreInvalidCertificates: true, domainWhitelist: ['internal.example'] });
    expect(skipsVerification('https://public.example/page')).toBe(false);
  });

  test('keeps verification for a whitelisted host when ignoreInvalidCertificates is off', () => {
    setSsl({ ignoreInvalidCertificates: false, domainWhitelist: ['internal.example'] });
    expect(skipsVerification('https://internal.example/page')).toBe(false);
  });
});
