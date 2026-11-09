// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Error answers of the iFinder authorization routes and of the `requireFeature` gate: both throw
 * (or pass on) a `ServiceError` and the global error middleware answers `application/problem+json`.
 *
 * Native ESM: `jest.unstable_mockModule` + dynamic imports.
 */
import { jest } from '@jest/globals';
import express from 'express';
import rateLimit from 'express-rate-limit';
import request from 'supertest';

const getLoginTokenStatus = jest.fn();
const deleteLoginTokens = jest.fn();

jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  authRequired: (req, res, next) => {
    req.user = { id: 'user-1' };
    next();
  }
}));
jest.unstable_mockModule('../services/integrations/iFinderTokenProvider.js', () => ({
  deleteLoginTokens: (...args) => deleteLoginTokens(...args),
  getExchangeProviderName: () => 'corp',
  getLoginTokenStatus: (...args) => getLoginTokenStatus(...args)
}));
jest.unstable_mockModule('../services/integrations/ifinderConfig.js', () => ({
  getIFinderConfig: () => ({ enabled: true })
}));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({ logAudit: () => {} }));

const { default: configCache } = await import('../configCache.js');
const { default: ifinderRouter } = await import('../routes/integrations/ifinder.js');
const { requireFeature } = await import('../featureRegistry.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

function buildApp() {
  const app = express();
  // Harness-only limiter: the production app rate-limits at the server level.
  app.use(rateLimit({ windowMs: 60000, limit: 1000 }));
  app.use('/api/integrations/ifinder', ifinderRouter);
  app.get('/gated', requireFeature('skills'), (req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

function expectProblem(res, status, code) {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  expect(res.body.code).toBe(code);
  expect(res.body.status).toBe(status);
}

describe('iFinder authorization routes', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    getLoginTokenStatus.mockReset();
    deleteLoginTokens.mockReset();
    jest.spyOn(configCache, 'getPlatform').mockReturnValue({ oidcAuth: { providers: [] } });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('GET keeps the status the token provider reported', async () => {
    getLoginTokenStatus.mockRejectedValue(
      Object.assign(new Error('token store busy'), { status: 409 })
    );
    const res = await request(app).get('/api/integrations/ifinder/authorization');
    expectProblem(res, 409, 'CONFLICT');
    expect(res.body.detail).toBe('token store busy');
  });

  test('GET answers 500 INTERNAL_ERROR without leaking the message of an unexpected failure', async () => {
    getLoginTokenStatus.mockRejectedValue(new Error('db password is hunter2'));
    const res = await request(app).get('/api/integrations/ifinder/authorization');
    expectProblem(res, 500, 'INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });

  test('DELETE answers 500 INTERNAL_ERROR when revoking fails', async () => {
    deleteLoginTokens.mockRejectedValue(new Error('boom'));
    const res = await request(app).delete('/api/integrations/ifinder/authorization');
    expectProblem(res, 500, 'INTERNAL_ERROR');
  });

  test('DELETE answers the revoke result when it works', async () => {
    deleteLoginTokens.mockResolvedValue(false);
    const res = await request(app).delete('/api/integrations/ifinder/authorization');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revoked: false });
  });
});

describe('requireFeature', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('answers 403 FEATURE_DISABLED as a problem when the feature is off', async () => {
    jest.spyOn(configCache, 'getFeatures').mockReturnValue({ skills: false });
    const res = await request(buildApp()).get('/gated');
    expectProblem(res, 403, 'FEATURE_DISABLED');
    expect(res.body.detail).toBe("Feature 'skills' is not enabled");
  });
});
