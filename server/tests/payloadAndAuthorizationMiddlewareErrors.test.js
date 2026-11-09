// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Error answers of the content-length guard and the generic authorization middleware: both pass a
 * `ServiceError` to `next` and the global error middleware answers `application/problem+json`.
 */
import { jest } from '@jest/globals';
import express from 'express';
import rateLimit from 'express-rate-limit';
import request from 'supertest';

import configCache from '../configCache.js';
import { checkContentLength } from '../middleware/setup.js';
import { createAuthorizationMiddleware } from '../utils/authorization.js';
import errorHandler from '../middleware/errorHandler.js';

function expectProblem(res, status, code) {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  expect(res.body.code).toBe(code);
  expect(res.body.status).toBe(status);
}

function buildApp(user, options) {
  const app = express();
  // Harness-only limiter: the production app rate-limits at the server level.
  app.use(rateLimit({ windowMs: 60000, limit: 1000 }));
  app.use((req, res, next) => {
    if (user) req.user = { permissions: {}, ...user };
    next();
  });
  app.use(checkContentLength(10));
  app.post('/guarded', createAuthorizationMiddleware(options), (req, res) =>
    res.json({ ok: true })
  );
  app.use(errorHandler);
  return app;
}

describe('checkContentLength', () => {
  test('answers 413 PAYLOAD_TOO_LARGE as a problem when the declared size exceeds the limit', async () => {
    const res = await request(buildApp(null, {}))
      .post('/guarded')
      .set('Content-Type', 'text/plain')
      .send('x'.repeat(50));
    expectProblem(res, 413, 'PAYLOAD_TOO_LARGE');
  });

  test('lets a small body through', async () => {
    const res = await request(buildApp(null, {})).post('/guarded').send('tiny');
    expect(res.status).toBe(200);
  });
});

describe('createAuthorizationMiddleware', () => {
  beforeEach(() => {
    jest.spyOn(configCache, 'getPlatform').mockReturnValue({
      anonymousAuth: { enabled: false }
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('answers 401 AUTH_REQUIRED when authentication is required and the caller is anonymous', async () => {
    const res = await request(
      buildApp({ id: 'anonymous', groups: [] }, { requireAuth: true })
    ).post('/guarded');
    expectProblem(res, 401, 'AUTH_REQUIRED');
  });

  test('answers 403 FORBIDDEN for a non-admin when admin access is required', async () => {
    const res = await request(
      buildApp({ id: 'u1', groups: ['users'] }, { requireAdmin: true })
    ).post('/guarded');
    expectProblem(res, 403, 'FORBIDDEN');
    expect(res.body.detail).toBe('Insufficient permissions: Admin access required');
  });

  test('answers 403 FORBIDDEN when the caller is in none of the allowed groups', async () => {
    const res = await request(
      buildApp({ id: 'u1', groups: ['users'] }, { allowedGroups: ['editors'] })
    ).post('/guarded');
    expectProblem(res, 403, 'FORBIDDEN');
  });

  test('lets a caller in an allowed group through', async () => {
    const res = await request(
      buildApp({ id: 'u1', groups: ['editors'] }, { allowedGroups: ['editors'] })
    ).post('/guarded');
    expect(res.status).toBe(200);
  });
});
