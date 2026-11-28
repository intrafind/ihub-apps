// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Error answers of the sign-in routes (`/api/auth/{local,ldap,ntlm}/login`, `/api/auth/user`). The
 * handlers throw `ServiceError` and the global error middleware answers `application/problem+json`.
 * The routes fail closed: a failure inside a handler answers 401, never a 500.
 *
 * Native ESM: `jest.unstable_mockModule` + dynamic imports.
 */
import { jest } from '@jest/globals';
import express from 'express';
import rateLimit from 'express-rate-limit';
import request from 'supertest';
import { ServiceError } from '../utils/ServiceError.js';
import { metricsMock } from './helpers/metricsMock.js';

const platform = {
  localAuth: { enabled: true },
  ldapAuth: { enabled: true, providers: [{ name: 'corp' }] },
  ntlmAuth: { enabled: true }
};
const loginUser = jest.fn();
const loginLdapUser = jest.fn();
const processNtlmLogin = jest.fn();

jest.unstable_mockModule('../configCache.js', () => ({
  __esModule: true,
  default: { getPlatform: () => platform, get: () => ({ data: null, etag: null }) }
}));
jest.unstable_mockModule('../middleware/localAuth.js', () => ({
  loginUser: (...args) => loginUser(...args),
  hasAnyUsers: () => false
}));
jest.unstable_mockModule('../middleware/ldapAuth.js', () => ({
  loginLdapUser: (...args) => loginLdapUser(...args),
  getConfiguredLdapProviders: () => []
}));
jest.unstable_mockModule('../middleware/ntlmAuth.js', () => ({
  processNtlmLogin: (...args) => processNtlmLogin(...args),
  markNtlmRequested: res => res.cookie('ntlmRequested', '1'),
  clearNtlmRequested: res => res.clearCookie('ntlmRequested'),
  NTLM_REQUESTED_COOKIE: 'ntlmRequested'
}));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({ logAudit: () => {} }));
jest.unstable_mockModule('../telemetry/metrics.js', () => metricsMock());

const { default: registerAuthRoutes } = await import('../routes/auth.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { resetLoginLockouts } = await import('../utils/loginLockout.js');

function buildApp({ ntlm, ntlmFailure } = {}) {
  const app = express();
  // Harness-only limiter: the production app rate-limits at the server level.
  app.use(rateLimit({ windowMs: 60000, limit: 1000 }));
  app.use(express.json());
  app.use((req, res, next) => {
    if (ntlm) req.ntlm = ntlm;
    if (ntlmFailure) req.ntlmFailure = ntlmFailure;
    next();
  });
  registerAuthRoutes(app);
  app.use(errorHandler);
  return app;
}

function expectProblem(res, status, code) {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  expect(res.body.code).toBe(code);
  expect(res.body.status).toBe(status);
}

beforeEach(() => {
  resetLoginLockouts();
  loginUser.mockReset();
  loginLdapUser.mockReset();
  processNtlmLogin.mockReset();
  platform.localAuth = { enabled: true };
  platform.ldapAuth = { enabled: true, providers: [{ name: 'corp' }] };
  platform.ntlmAuth = { enabled: true };
});

describe('POST /api/auth/local/login', () => {
  const login = (app, body) => request(app).post('/api/auth/local/login').send(body);

  test('answers 400 when the credentials are missing', async () => {
    const res = await login(buildApp(), { username: 'ada' });
    expectProblem(res, 400, 'BAD_REQUEST');
    expect(loginUser).not.toHaveBeenCalled();
  });

  test('answers 400 when local sign-in is turned off', async () => {
    platform.localAuth = { enabled: false };
    const res = await login(buildApp(), { username: 'ada', password: 'pw' });
    expectProblem(res, 400, 'BAD_REQUEST');
    expect(res.body.detail).toMatch(/not enabled/);
    expect(loginUser).not.toHaveBeenCalled();
  });

  test('answers 401 for wrong credentials', async () => {
    loginUser.mockRejectedValue(new Error('bad password'));
    const res = await login(buildApp(), { username: 'ada', password: 'pw' });
    expectProblem(res, 401, 'AUTH_REQUIRED');
    expect(res.body.detail).toBe('Authentication failed. Please check your username and password.');
    expect(JSON.stringify(res.body)).not.toContain('bad password');
  });

  test('fails closed: an unexpected failure after the credential check answers 401, not 500', async () => {
    loginUser.mockResolvedValue({
      user: { id: 'ada' },
      get token() {
        throw new Error('signing key is missing');
      },
      expiresIn: 3600
    });
    const res = await login(buildApp(), { username: 'ada', password: 'pw' });
    expectProblem(res, 401, 'AUTH_REQUIRED');
  });
});

describe('local sign-in and the Windows preference', () => {
  test('a local sign-in forgets an earlier Windows sign-in', async () => {
    // Otherwise /api/auth/status would send this browser to Windows sign-in
    // when the local session expires.
    loginUser.mockResolvedValue({ user: { id: 'ada' }, token: 't', expiresIn: 3600 });
    const res = await request(buildApp())
      .post('/api/auth/local/login')
      .set('Cookie', 'ntlmRequested=1')
      .send({ username: 'ada', password: 'pw' });
    expect(res.status).toBe(200);
    const cookies = res.headers['set-cookie'].join(';');
    expect(cookies).toMatch(/ntlmRequested=;/);
    expect(cookies).not.toMatch(/ntlmRequested=1/);
  });
});

describe('POST /api/auth/ldap/login', () => {
  const login = body => request(buildApp()).post('/api/auth/ldap/login').send(body);

  test('answers 400 for an unknown provider', async () => {
    const res = await login({ username: 'ada', password: 'pw', provider: 'nope' });
    expectProblem(res, 400, 'BAD_REQUEST');
    expect(res.body.detail).toBe("LDAP provider 'nope' not found");
  });

  test('answers 401 when the requested provider refuses the credentials', async () => {
    loginLdapUser.mockRejectedValue(new Error('ldap said no'));
    const res = await login({ username: 'ada', password: 'pw', provider: 'corp' });
    expectProblem(res, 401, 'AUTH_REQUIRED');
    expect(res.body.detail).toBe('Invalid credentials');
  });

  test('answers 401 when no provider accepts the credentials', async () => {
    loginLdapUser.mockRejectedValue(new Error('ldap said no'));
    const res = await login({ username: 'ada', password: 'pw' });
    expectProblem(res, 401, 'AUTH_REQUIRED');
    expect(res.body.detail).toBe('Invalid credentials');
  });

  test('locks a username after 5 failed binds, from any address, without binding again', async () => {
    loginLdapUser.mockRejectedValue(new Error('ldap said no'));
    for (let i = 0; i < 5; i++) {
      expectProblem(await login({ username: 'Bob', password: `guess-${i}` }), 401, 'AUTH_REQUIRED');
    }
    const binds = loginLdapUser.mock.calls.length;
    const locked = await login({ username: ' bob', password: 'right' });
    expectProblem(locked, 429, 'RATE_LIMITED');
    expect(loginLdapUser.mock.calls.length).toBe(binds);
    // Another name is unaffected.
    loginLdapUser.mockResolvedValue({ user: { id: 'ada' }, token: 't', expiresIn: 60 });
    expect((await login({ username: 'ada', password: 'pw' })).status).toBe(200);
  });

  test('a successful bind clears the failures', async () => {
    loginLdapUser.mockRejectedValue(new Error('ldap said no'));
    for (let i = 0; i < 4; i++) await login({ username: 'carol', password: 'x' });
    loginLdapUser.mockResolvedValueOnce({ user: { id: 'carol' }, token: 't', expiresIn: 60 });
    expect((await login({ username: 'carol', password: 'pw' })).status).toBe(200);
    for (let i = 0; i < 4; i++) {
      expectProblem(await login({ username: 'carol', password: 'x' }), 401, 'AUTH_REQUIRED');
    }
  });

  test('answers 400 when LDAP sign-in is turned off', async () => {
    platform.ldapAuth = { enabled: false, providers: [] };
    const res = await login({ username: 'ada', password: 'pw' });
    expectProblem(res, 400, 'BAD_REQUEST');
  });
});

describe('NTLM login', () => {
  // The browser sign-in is a page navigation: every failure goes back to the
  // app with ?auth=error, which the auth gate shows on its login screen.
  function expectSignInFailedRedirect(res, message) {
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location, 'http://localhost');
    expect(location.pathname).toBe('/');
    expect(location.searchParams.get('auth')).toBe('error');
    if (message) expect(location.searchParams.get('message')).toMatch(message);
  }

  test('GET sends the browser back with an error when NTLM is turned off', async () => {
    platform.ntlmAuth = { enabled: false };
    const res = await request(buildApp()).get('/api/auth/ntlm/login');
    expectSignInFailedRedirect(res, /not enabled/);
  });

  test('GET sends the browser back with an error when the handshake did not finish', async () => {
    const res = await request(buildApp()).get('/api/auth/ntlm/login');
    expectSignInFailedRedirect(res, /did not complete/);
  });

  test('GET sends the browser back with the reason the domain controller refused', async () => {
    const ntlmFailure = new ServiceError('FORBIDDEN', 'Windows sign-in was rejected.');
    const res = await request(buildApp({ ntlmFailure })).get('/api/auth/ntlm/login');
    expectSignInFailedRedirect(res, /rejected/);
    expect(processNtlmLogin).not.toHaveBeenCalled();
  });

  test('GET signs in, remembers the choice and returns to the page', async () => {
    processNtlmLogin.mockResolvedValue({ user: { id: 'jane' }, token: 't', expiresIn: 60 });
    const res = await request(buildApp({ ntlm: { Authenticated: true } })).get(
      '/api/auth/ntlm/login?returnUrl=/apps/chat'
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/apps/chat?ntlm=success');
    expect(res.headers['set-cookie'].join(';')).toMatch(/ntlmRequested=1/);
  });

  test('POST answers 401 without NTLM data', async () => {
    const res = await request(buildApp()).post('/api/auth/ntlm/login');
    expectProblem(res, 401, 'AUTH_REQUIRED');
  });

  test('POST answers with the failure the NTLM middleware left', async () => {
    const ntlmFailure = new ServiceError('FORBIDDEN', 'Windows sign-in was rejected.');
    const res = await request(buildApp({ ntlmFailure })).post('/api/auth/ntlm/login');
    expectProblem(res, 403, 'FORBIDDEN');
  });

  test('POST fails closed: a failing NTLM login answers 401, not 500', async () => {
    processNtlmLogin.mockRejectedValue(new Error('directory unreachable'));
    const res = await request(buildApp({ ntlm: { Authenticated: true } })).post(
      '/api/auth/ntlm/login'
    );
    expectProblem(res, 401, 'AUTH_REQUIRED');
  });
});

describe('GET /api/auth/user', () => {
  test('answers 401 for an anonymous caller', async () => {
    const res = await request(buildApp()).get('/api/auth/user');
    expectProblem(res, 401, 'AUTH_REQUIRED');
    expect(res.body.detail).toBe('Authentication required');
  });
});
