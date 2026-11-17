// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Hosts on `ssl.domainWhitelist` are trusted by the SSRF guard as well
 * (`isSsrfTrustedHost`). The trust itself is unchanged (PL-B12, decision 14a);
 * the server names, once at startup, the hosts trusted ONLY through the TLS
 * whitelist, so an admin who added a host for its certificate learns that it
 * may also reach private network addresses.
 */

import { afterEach, describe, expect, jest, test } from '@jest/globals';
import configCache from '../configCache.js';
import logger from '../utils/logger.js';
import {
  hostsSsrfTrustedOnlyViaTlsWhitelist,
  isSsrfTrustedHost,
  warnSsrfTrustViaTlsWhitelist
} from '../utils/httpConfig.js';

afterEach(() => {
  configCache.setCacheEntry('config/platform.json', {});
  jest.restoreAllMocks();
});

describe('hostsSsrfTrustedOnlyViaTlsWhitelist', () => {
  test('names TLS whitelist entries that are not on ssrf.allowedHosts', () => {
    expect(
      hostsSsrfTrustedOnlyViaTlsWhitelist({
        ssl: { domainWhitelist: ['llm.internal', '*.corp.example', 'shared.internal'] },
        ssrf: { allowedHosts: ['shared.internal'] }
      })
    ).toEqual(['llm.internal', '*.corp.example']);
  });

  test('treats a host covered by an allowedHosts pattern as explicitly trusted', () => {
    expect(
      hostsSsrfTrustedOnlyViaTlsWhitelist({
        ssl: { domainWhitelist: ['api.corp.example', '*.corp.example', ' LLM.internal '] },
        ssrf: { allowedHosts: ['*.corp.example', 'llm.internal'] }
      })
    ).toEqual([]);
  });

  test('treats a wildcard covered by an equivalent or broader allowedHosts pattern as trusted', () => {
    expect(
      hostsSsrfTrustedOnlyViaTlsWhitelist({
        ssl: { domainWhitelist: ['*.corp.example', '.lab.example', '*.eu.cloud.example'] },
        // `.corp.example` is the same set as `*.corp.example`; `*.example`
        // covers every subdomain of lab.example; `.cloud.example` is broader.
        ssrf: { allowedHosts: ['.corp.example', '*.example', '.cloud.example'] }
      })
    ).toEqual([]);
  });

  test('keeps warning about a wildcard only partly covered', () => {
    expect(
      hostsSsrfTrustedOnlyViaTlsWhitelist({
        ssl: { domainWhitelist: ['*.corp.example', '*.example'] },
        // A host of the domain, a narrower pattern and an unrelated suffix do
        // not cover every host the TLS entry matches.
        ssrf: { allowedHosts: ['api.corp.example', '*.eu.corp.example', 'corp.example', '*.ample'] }
      })
    ).toEqual(['*.corp.example', '*.example']);
  });

  test('is empty without a whitelist, and ignores malformed entries', () => {
    expect(hostsSsrfTrustedOnlyViaTlsWhitelist({})).toEqual([]);
    expect(
      hostsSsrfTrustedOnlyViaTlsWhitelist({ ssl: { domainWhitelist: ['', 3, 'a.internal'] } })
    ).toEqual(['a.internal']);
  });
});

describe('warnSsrfTrustViaTlsWhitelist', () => {
  test('warns naming the hosts, whether or not invalid certificates are ignored', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const platform = {
      ssl: { ignoreInvalidCertificates: false, domainWhitelist: ['llm.internal'] }
    };
    expect(warnSsrfTrustViaTlsWhitelist(platform)).toEqual(['llm.internal']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({ hosts: ['llm.internal'] });
  });

  test('stays silent when every whitelisted host is also on ssrf.allowedHosts', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    warnSsrfTrustViaTlsWhitelist({
      ssl: { domainWhitelist: ['llm.internal'] },
      ssrf: { allowedHosts: ['llm.internal'] }
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test('changes no trust: a TLS-whitelisted host stays SSRF-trusted', () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const platform = {
      ssl: { ignoreInvalidCertificates: false, domainWhitelist: ['llm.internal'] }
    };
    configCache.setCacheEntry('config/platform.json', platform);
    warnSsrfTrustViaTlsWhitelist(platform);
    expect(isSsrfTrustedHost('llm.internal')).toBe(true);
    expect(isSsrfTrustedHost('other.internal')).toBe(false);
  });
});
