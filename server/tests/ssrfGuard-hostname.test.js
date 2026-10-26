// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { jest } from '@jest/globals';

const resolve4 = jest.fn();
const resolve6 = jest.fn();

jest.unstable_mockModule('node:dns/promises', () => ({
  default: { resolve4, resolve6 }
}));

const { assertPublicTarget } = await import('../utils/ssrfGuard.js');

describe('assertPublicTarget hostname hardening', () => {
  beforeEach(() => {
    resolve4.mockReset().mockResolvedValue(['203.0.113.10']);
    resolve6.mockReset().mockRejectedValue(new Error('no AAAA'));
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
});
