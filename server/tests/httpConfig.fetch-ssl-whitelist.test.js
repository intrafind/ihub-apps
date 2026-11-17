// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The whitelist decision behind `enhanceFetchOptions`, which `read_url` (services/pageReader/pageReader.js) calls
 * for every hop: certificate verification is skipped only for a host on
 * `ssl.domainWhitelist` while `ssl.ignoreInvalidCertificates` is on.
 */

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import configCache from '../configCache.js';
import { shouldIgnoreSSLForURL } from '../utils/httpConfig.js';
import logger from '../utils/logger.js';

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

test('warns about a non-whitelisted host once per process, not on every request', () => {
  setSsl({ ignoreInvalidCertificates: true, domainWhitelist: ['internal.example'] });
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  try {
    for (let i = 0; i < 3; i++) skipsVerification('https://once.example/v1/chat');
    skipsVerification('https://other.example/v1/chat');
    const hosts = warn.mock.calls
      .filter(([message]) => String(message).includes('not in ssl.domainWhitelist'))
      .map(([, meta]) => meta.hostname);
    expect(hosts).toEqual(['once.example', 'other.example']);
  } finally {
    warn.mockRestore();
  }
});

test('warns again about a host after the whitelist changed', () => {
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  try {
    setSsl({ ignoreInvalidCertificates: true, domainWhitelist: ['internal.example'] });
    skipsVerification('https://again.example/v1/chat');
    skipsVerification('https://again.example/v1/chat');
    setSsl({ ignoreInvalidCertificates: true, domainWhitelist: ['other-internal.example'] });
    skipsVerification('https://again.example/v1/chat');
    const warnings = warn.mock.calls.filter(([message]) =>
      String(message).includes('not in ssl.domainWhitelist')
    );
    expect(warnings).toHaveLength(2);
  } finally {
    warn.mockRestore();
  }
});
