// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `GET /api/auth/ntlm/login?returnUrl=…` redirects the browser after a Windows
 * sign-in. The target is always a path on this site: absolute URLs of other
 * hosts, protocol-relative forms and the spellings browsers normalise into them
 * (backslash, tab, newline) fall back to `/`.
 *
 * Run with `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const platform = { ntlmAuth: { enabled: true } };

jest.unstable_mockModule('../configCache.js', () => ({
  __esModule: true,
  default: { getPlatform: () => platform, get: () => ({ data: null, etag: null }) }
}));
jest.unstable_mockModule('../middleware/localAuth.js', () => ({
  loginUser: jest.fn(),
  hasAnyUsers: () => false
}));
jest.unstable_mockModule('../middleware/ldapAuth.js', () => ({
  loginLdapUser: jest.fn(),
  getConfiguredLdapProviders: () => []
}));
jest.unstable_mockModule('../middleware/ntlmAuth.js', () => ({
  processNtlmLogin: async () => ({ token: 'jwt', expiresIn: 3600, user: { id: 'ada' } }),
  markNtlmRequested: res => res.cookie('ntlmRequested', '1'),
  clearNtlmRequested: res => res.clearCookie('ntlmRequested'),
  NTLM_REQUESTED_COOKIE: 'ntlmRequested'
}));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({ logAudit: () => {} }));
jest.unstable_mockModule('../telemetry/metrics.js', () => ({ recordAuthEvent: () => {} }));

const { default: registerAuthRoutes, sameOriginReturnPath } = await import('../routes/auth.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const HOST = 'ihub.example.com';
const req = { get: name => (name.toLowerCase() === 'host' ? HOST : undefined), hostname: HOST };

describe('sameOriginReturnPath', () => {
  test.each([
    ['/', '/'],
    ['/apps/chat?x=1#top', '/apps/chat?x=1#top'],
    ['/ihub/reports', '/ihub/reports'],
    ['reports', '/reports'],
    [`https://${HOST}/apps/chat?x=1#top`, '/apps/chat?x=1#top'],
    [`HTTP://${HOST}/a`, '/a']
  ])('keeps %s as a path on this site', (input, expected) => {
    expect(sameOriginReturnPath(input, req)).toBe(expected);
  });

  test.each([
    'https://evil.example/path',
    'http://evil.example',
    `https://${HOST}.evil.example/`,
    `https://${HOST}:8443/`,
    '//evil.example/path',
    '\\\\evil.example',
    '/\\evil.example',
    '/\t/evil.example',
    '/\n/evil.example',
    '/\r/evil.example',
    'https://evil.example\\@' + HOST
  ])('falls back to / for %j', input => {
    expect(sameOriginReturnPath(input, req)).toBe('/');
  });

  test('never produces a protocol-relative or absolute URL', () => {
    for (const input of [
      `https://${HOST}//evil.example/x`,
      `https://${HOST}/\\evil.example`,
      'javascript:alert(1)',
      ''
    ]) {
      const out = sameOriginReturnPath(input, req);
      expect(out.startsWith('/')).toBe(true);
      expect(out.startsWith('//')).toBe(false);
    }
  });
});

describe('GET /api/auth/ntlm/login', () => {
  const app = express();
  app.use((r, _res, next) => {
    r.ntlm = { Authenticated: true };
    next();
  });
  registerAuthRoutes(app);
  app.use(errorHandler);

  const login = returnUrl =>
    request(app)
      .get('/api/auth/ntlm/login')
      .query(returnUrl === undefined ? {} : { returnUrl });

  test('redirects to a same-site path with the success marker', async () => {
    const res = await login('/apps/chat?x=1').expect(302);
    expect(res.headers.location).toBe('/apps/chat?x=1&ntlm=success');
  });

  test('redirects to / without a returnUrl', async () => {
    const res = await login(undefined).expect(302);
    expect(res.headers.location).toBe('/?ntlm=success');
  });

  test.each(['https://evil.example/', '//evil.example', '/\t/evil.example', '/\\evil.example'])(
    'does not follow %j off this site',
    async returnUrl => {
      const res = await login(returnUrl).expect(302);
      expect(res.headers.location).toBe('/?ntlm=success');
    }
  );

  test('answers a repeated returnUrl parameter as a failed sign-in, not a redirect to it', async () => {
    const res = await request(app)
      .get('/api/auth/ntlm/login?returnUrl=/a&returnUrl=/b')
      .expect(302);
    expect(res.headers.location).toMatch(/^\/\?auth=error&/);
  });
});
