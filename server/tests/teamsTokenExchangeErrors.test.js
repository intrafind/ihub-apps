// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `teamsTokenExchange` refuses a request by throwing a ServiceError the global error middleware
 * answers as problem+json. Every refusal fails closed: no `authToken` cookie is set. Request
 * validation (missing token, Teams auth disabled) is answered as such, not as an invalid token.
 *
 * Run with `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import rateLimit from 'express-rate-limit';
import jsonwebtoken from 'jsonwebtoken';

const state = { teams: { enabled: true, clientId: 'cid', tenantId: 'tid', domain: 'x.example' } };
const validateAndPersistExternalUser = jest.fn();
const verify = jest.fn();
const MESSAGES = {
  TEAMS_SSO_TOKEN_REQUIRED: 'SSO token required (localized)',
  TEAMS_AUTH_NOT_ENABLED: 'Teams auth not enabled (localized)',
  TEAMS_ACCOUNT_DISABLED: 'Account disabled (localized)',
  TEAMS_INVALID_OR_EXPIRED_TOKEN: 'Invalid or expired token (localized)'
};

const realConfigCache = (await import('../configCache.js')).default;
jest.unstable_mockModule('../configCache.js', () => ({
  default: { ...realConfigCache, getPlatform: () => ({ teamsAuth: state.teams }) }
}));
// The localized detail: the real catalogue is not loaded in this test.
const RealErrorHandler = (await import('../utils/ErrorHandler.js')).default;
jest.unstable_mockModule('../utils/ErrorHandler.js', () => ({
  default: class extends RealErrorHandler {
    async getLocalizedError(code) {
      return MESSAGES[code];
    }
  }
}));
const realAuthorization = await import('../utils/authorization.js');
jest.unstable_mockModule('../utils/authorization.js', () => ({
  ...realAuthorization,
  enhanceUserGroups: user => user,
  mapExternalGroups: groups => groups || []
}));
jest.unstable_mockModule('../utils/userManager.js', () => ({
  validateAndPersistExternalUser
}));
jest.unstable_mockModule('jsonwebtoken', () => ({
  default: { ...jsonwebtoken, verify }
}));
jest.unstable_mockModule('jwks-rsa', () => ({
  default: () => ({ getSigningKey: (kid, cb) => cb(null, { publicKey: 'public-key' }) })
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { teamsTokenExchange } = await import('../middleware/teamsAuth.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
// Harness-only limiter: the production app rate-limits at the server level.
app.use(rateLimit({ windowMs: 60000, limit: 1000 }));
app.use(express.json());
app.post('/api/auth/teams/exchange', teamsTokenExchange);
app.use(errorHandler);

// A decodable (but unverified) token; verification is mocked.
const decodable = jsonwebtoken.sign({ tid: 'tid', oid: 'u1', name: 'U' }, 's', {
  header: { kid: 'k1' }
});

function expectFailedClosed(res, status, code) {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  expect(res.body.code).toBe(code);
  expect(res.headers['set-cookie'] ?? []).toEqual([]);
  expect(JSON.stringify(res.headers)).not.toContain('authToken');
  expect(res.body.token).toBeUndefined();
}

beforeEach(() => {
  state.teams = { enabled: true, clientId: 'cid', tenantId: 'tid', domain: 'x.example' };
  validateAndPersistExternalUser.mockReset();
  verify.mockReset();
});

describe('teamsTokenExchange: errors', () => {
  it('answers a missing ssoToken with 400 TEAMS_SSO_TOKEN_REQUIRED', async () => {
    const res = await request(app).post('/api/auth/teams/exchange').send({});
    expectFailedClosed(res, 400, 'TEAMS_SSO_TOKEN_REQUIRED');
    expect(res.body.detail).toBe('SSO token required (localized)');
    expect(validateAndPersistExternalUser).not.toHaveBeenCalled();
  });

  it('answers disabled Teams auth with 400 TEAMS_AUTH_NOT_ENABLED, not as an invalid token', async () => {
    state.teams = { enabled: false };
    const res = await request(app).post('/api/auth/teams/exchange').send({ ssoToken: decodable });
    expectFailedClosed(res, 400, 'TEAMS_AUTH_NOT_ENABLED');
    expect(res.body.code).not.toBe('TEAMS_INVALID_OR_EXPIRED_TOKEN');
    expect(res.body.detail).toBe('Teams auth not enabled (localized)');
    expect(verify).not.toHaveBeenCalled();
    expect(validateAndPersistExternalUser).not.toHaveBeenCalled();
  });

  it('answers a garbage ssoToken with 401 TEAMS_INVALID_OR_EXPIRED_TOKEN', async () => {
    const res = await request(app).post('/api/auth/teams/exchange').send({ ssoToken: 'not-a-jwt' });
    expectFailedClosed(res, 401, 'TEAMS_INVALID_OR_EXPIRED_TOKEN');
    expect(res.body.detail).toBe('Invalid or expired token (localized)');
    expect(validateAndPersistExternalUser).not.toHaveBeenCalled();
  });

  it('answers a failed signature check with 401 TEAMS_INVALID_OR_EXPIRED_TOKEN', async () => {
    verify.mockImplementation(() => {
      throw new Error('invalid signature');
    });
    const res = await request(app).post('/api/auth/teams/exchange').send({ ssoToken: decodable });
    expectFailedClosed(res, 401, 'TEAMS_INVALID_OR_EXPIRED_TOKEN');
    expect(validateAndPersistExternalUser).not.toHaveBeenCalled();
  });

  it('answers a disabled account with 403 TEAMS_ACCOUNT_DISABLED', async () => {
    verify.mockReturnValue({ oid: 'u1', tid: 'tid', name: 'U', email: 'u@x.example' });
    validateAndPersistExternalUser.mockRejectedValue(
      Object.assign(new Error('Your account is disabled'), { code: 'ACCOUNT_DISABLED' })
    );
    const res = await request(app).post('/api/auth/teams/exchange').send({ ssoToken: decodable });
    expectFailedClosed(res, 403, 'TEAMS_ACCOUNT_DISABLED');
    expect(res.body.detail).toBe('Account disabled (localized)');
    expect(validateAndPersistExternalUser).toHaveBeenCalledTimes(1);
  });

  it('answers any other validation failure as an invalid token, still without a cookie', async () => {
    verify.mockReturnValue({ oid: 'u1', tid: 'tid' });
    validateAndPersistExternalUser.mockRejectedValue(new Error('disk full'));
    const res = await request(app).post('/api/auth/teams/exchange').send({ ssoToken: decodable });
    expectFailedClosed(res, 401, 'TEAMS_INVALID_OR_EXPIRED_TOKEN');
    expect(JSON.stringify(res.body)).not.toContain('disk full');
  });
});
