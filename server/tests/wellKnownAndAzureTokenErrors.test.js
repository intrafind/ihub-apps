// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Error answers of the JWKS / discovery endpoints and of the Azure Speech token route: the handlers
 * throw (or let a failure propagate) and the global error middleware answers `application/problem+json`.
 *
 * Native ESM: `jest.unstable_mockModule` + dynamic imports.
 */
import { jest } from '@jest/globals';
import express from 'express';
import rateLimit from 'express-rate-limit';
import request from 'supertest';

const state = {
  algorithm: 'RS256',
  keyPair: null,
  platform: {},
  tokenResult: null,
  tokenThrows: null
};

jest.unstable_mockModule('../configCache.js', () => ({
  __esModule: true,
  default: {
    getPlatform: () => {
      if (state.platform instanceof Error) throw state.platform;
      return state.platform;
    },
    get: () => ({ data: null, etag: null })
  }
}));
jest.unstable_mockModule('../services/TokenStorageService.js', () => ({
  __esModule: true,
  default: { getRSAKeyPair: () => state.keyPair }
}));
jest.unstable_mockModule('../utils/tokenService.js', () => ({
  getJwtAlgorithm: () => state.algorithm
}));
jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  authRequired: (req, res, next) => {
    req.user = { id: 'user-1', permissions: {} };
    next();
  }
}));
jest.unstable_mockModule('../services/azureSpeechToken.js', () => ({
  getAzureSpeechToken: async () => {
    if (state.tokenThrows) throw state.tokenThrows;
    return state.tokenResult;
  }
}));

const { default: registerWellKnownRoutes } = await import('../routes/wellKnown.js');
const { default: registerVoiceRoutes } = await import('../routes/voiceRoutes.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

function buildApp() {
  const app = express();
  // Harness-only limiter: the production app rate-limits at the server level.
  app.use(rateLimit({ windowMs: 60000, limit: 1000 }));
  app.use(express.json());
  registerWellKnownRoutes(app);
  registerVoiceRoutes(app);
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
  state.algorithm = 'RS256';
  state.keyPair = null;
  state.platform = {};
  state.tokenResult = { ok: true, token: 't', region: 'westeurope' };
  state.tokenThrows = null;
});

// `/.well-known/*` is a protocol path: the error middleware answers it in the OAuth shape
// (`error`, `error_description`), as it does for `/api/oauth/*`.
function expectOAuthError(res, status, error) {
  expect(res.status).toBe(status);
  expect(res.body.error).toBe(error);
  expect(typeof res.body.error_description).toBe('string');
}

describe('GET /.well-known/jwks.json', () => {
  test('answers 501 in the OAuth shape when no RSA key pair exists', async () => {
    const res = await request(buildApp()).get('/.well-known/jwks.json');
    expectOAuthError(res, 501, 'server_error');
  });

  test('keeps answering the HS256 note as a normal 200', async () => {
    state.algorithm = 'HS256';
    const res = await request(buildApp()).get('/.well-known/jwks.json');
    expect(res.status).toBe(200);
    expect(res.body.keys).toEqual([]);
  });
});

describe('discovery documents', () => {
  test('answer 500 in the OAuth shape without leaking the cause when building fails', async () => {
    state.platform = new Error('db password is hunter2');
    const res = await request(buildApp()).get('/.well-known/openid-configuration');
    expectOAuthError(res, 500, 'server_error');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });
});

describe('GET /api/voice/azure/token', () => {
  test('answers 503 SERVICE_UNAVAILABLE when Azure Speech is off', async () => {
    const res = await request(buildApp()).get('/api/voice/azure/token');
    expectProblem(res, 503, 'SERVICE_UNAVAILABLE');
  });

  test('answers 502 UPSTREAM_ERROR when Azure refuses the key', async () => {
    state.platform = { speech: { azure: { enabled: true, subscriptionKey: 'k', region: 'r' } } };
    state.tokenResult = { ok: false, error: 'Azure rejected the key' };
    const res = await request(buildApp()).get('/api/voice/azure/token');
    expectProblem(res, 502, 'UPSTREAM_ERROR');
  });

  test('answers 500 INTERNAL_ERROR without the cause when issuing the token throws', async () => {
    state.platform = { speech: { azure: { enabled: true, subscriptionKey: 'k', region: 'r' } } };
    state.tokenThrows = new Error('socket hang up to 10.0.0.5');
    const res = await request(buildApp()).get('/api/voice/azure/token');
    expectProblem(res, 500, 'INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
  });

  test('answers a keyless token when no key is configured', async () => {
    state.platform = { speech: { azure: { enabled: true, region: 'westeurope' } } };
    const res = await request(buildApp()).get('/api/voice/azure/token');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ token: null, region: 'westeurope' });
  });
});
