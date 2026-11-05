// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { jest } from '@jest/globals';

const resolve4 = jest.fn();
const resolve6 = jest.fn();
const lookup = jest.fn();

jest.unstable_mockModule('node:dns/promises', () => ({
  default: { resolve4, resolve6 }
}));
// The OS-resolver fallback goes through the guarded (timeout-bounded) lookup.
jest.unstable_mockModule('../utils/dnsGuard.js', () => ({
  guardedLookup: (host, options, callback) =>
    lookup(host, options).then(
      entries => callback(null, entries),
      err => callback(err)
    )
}));

const { assertPublicTarget, UNRESOLVED_HOST } = await import('../utils/ssrfGuard.js');

describe('assertPublicTarget hostname hardening', () => {
  beforeEach(() => {
    resolve4.mockReset().mockResolvedValue(['203.0.113.10']);
    resolve6.mockReset().mockRejectedValue(new Error('no AAAA'));
    lookup
      .mockReset()
      .mockRejectedValue(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
  });

  test('rejects a NUL byte before any DNS lookup', async () => {
    const result = await assertPublicTarget({ hostname: 'attacker.example\0.trusted.example' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/control characters/);
    expect(resolve4).not.toHaveBeenCalled();
    expect(resolve6).not.toHaveBeenCalled();
  });

  test('rejects other control characters', async () => {
    const result = await assertPublicTarget({ hostname: 'evil\n.example' });
    expect(result.ok).toBe(false);
  });

  test('still accepts a normal public hostname', async () => {
    const result = await assertPublicTarget(new URL('https://example.com/path'));
    expect(result).toEqual({ ok: true, addresses: ['203.0.113.10'] });
  });

  describe('names only the OS resolver knows (#3307)', () => {
    beforeEach(() => {
      resolve4.mockRejectedValue(new Error('ENOTFOUND'));
    });

    test('falls back to dns.lookup and returns the address for pinning', async () => {
      lookup.mockResolvedValue([{ address: '203.0.113.20', family: 4 }]);
      const result = await assertPublicTarget(new URL('https://if-wiki/display/x'));
      expect(lookup).toHaveBeenCalledWith('if-wiki', { all: true });
      expect(result).toEqual({ ok: true, addresses: ['203.0.113.20'] });
    });

    test('still refuses an OS-resolved private address', async () => {
      lookup.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);
      const result = await assertPublicTarget(new URL('https://if-wiki/'));
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/private IP 10\.1\.2\.3/);
    });

    test('flags a name nothing can resolve as UNRESOLVED_HOST', async () => {
      const result = await assertPublicTarget(new URL('https://if-wiki/'));
      expect(result.ok).toBe(false);
      expect(result.code).toBe(UNRESOLVED_HOST);
    });

    test('does not consult the OS resolver when DNS answered', async () => {
      resolve4.mockResolvedValue(['203.0.113.10']);
      await assertPublicTarget(new URL('https://example.com/'));
      expect(lookup).not.toHaveBeenCalled();
    });
  });
});
