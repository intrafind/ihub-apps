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
  markNtlmRequested: () => {},
  clearNtlmRequested: () => {}
}));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({ logAudit: () => {} }));
jest.unstable_mockModule('../telemetry/metrics.js', () => ({ recordAuthEvent: () => {} }));

const { default: registerAuthRoutes } = await import('../routes/auth.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

function buildApp({ ntlm } = {}) {
  const app = express();
  // Harness-only limiter: the production app rate-limits at the server level.
  app.use(rateLimit({ windowMs: 60000, limit: 1000 }));
  app.use(express.json());
  app.use((req, res, next) => {
    if (ntlm) req.ntlm = ntlm;
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

  test('answers 400 when LDAP sign-in is turned off', async () => {
    platform.ldapAuth = { enabled: false, providers: [] };
    const res = await login({ username: 'ada', password: 'pw' });
    expectProblem(res, 400, 'BAD_REQUEST');
  });
});

describe('NTLM login', () => {
  test('GET answers 400 when NTLM is turned off', async () => {
    platform.ntlmAuth = { enabled: false };
    expectProblem(await request(buildApp()).get('/api/auth/ntlm/login'), 400, 'BAD_REQUEST');
  });

  test('GET answers 401 while the NTLM handshake is not finished', async () => {
    const res = await request(buildApp()).get('/api/auth/ntlm/login');
    expectProblem(res, 401, 'AUTH_REQUIRED');
    expect(res.body.detail).toMatch(/NTLM authentication in progress/);
  });

  test('POST answers 401 without NTLM data', async () => {
    const res = await request(buildApp()).post('/api/auth/ntlm/login');
    expectProblem(res, 401, 'AUTH_REQUIRED');
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
