// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The route guards (`adminAuth`, `contentAdminAuth`, `authRequired`, `authenticatedOnly`,
 * `appAccessRequired` / `modelAccessRequired`) and the rate-limit handler refuse a request by
 * throwing a ServiceError the global error middleware answers as RFC 9457 `problem+json`. Every
 * refusal must fail closed: the route handler behind the guard never runs.
 *
 * Run with `NODE_OPTIONS=--experimental-vm-modules`.
 */
import request from 'supertest';
import express from 'express';
import configCache from '../configCache.js';
import { adminAuth } from '../middleware/adminAuth.js';
import { contentAdminAuth } from '../middleware/contentAdminAuth.js';
import {
  authRequired,
  authenticatedOnly,
  appAccessRequired,
  modelAccessRequired
} from '../middleware/authRequired.js';
import { createOAuthTokenLimiter } from '../middleware/rateLimiting.js';
import errorHandler from '../middleware/errorHandler.js';

let user;
let anonymousAllowed;
let handlerRuns;

const realGetPlatform = configCache.getPlatform;

/** An app whose routes sit behind one guard, with the handler counting its runs. */
function appBehind(...guards) {
  const app = express();
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  app.get('/probe/:appId/:modelId', ...guards, (req, res) => {
    handlerRuns += 1;
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

function expectProblem(res, status, code) {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  expect(res.body.code).toBe(code);
  expect(handlerRuns).toBe(0);
}

beforeEach(() => {
  user = undefined;
  anonymousAllowed = false;
  handlerRuns = 0;
  configCache.getPlatform = () => ({
    anonymousAuth: { enabled: anonymousAllowed, defaultGroups: [] },
    auth: { mode: 'local' }
  });
});

afterAll(() => {
  configCache.getPlatform = realGetPlatform;
});

describe('adminAuth', () => {
  it('refuses a caller who is not an administrator and never runs the handler', async () => {
    user = { id: 'u1', groups: ['users'] };
    const res = await request(appBehind(adminAuth)).get('/probe/a/m');
    expectProblem(res, 403, 'FORBIDDEN');
    expect(res.body.detail).toMatch(/admin privileges/);
  });

  it('refuses a request without a principal', async () => {
    const res = await request(appBehind(adminAuth)).get('/probe/a/m');
    expectProblem(res, 403, 'FORBIDDEN');
  });

  it('lets an administrator through', async () => {
    user = { id: 'root', isAdmin: true };
    const res = await request(appBehind(adminAuth)).get('/probe/a/m');
    expect(res.status).toBe(200);
    expect(handlerRuns).toBe(1);
  });
});

describe('contentAdminAuth', () => {
  it('answers a request without a signed-in user with AUTH_REQUIRED', async () => {
    const res = await request(appBehind(contentAdminAuth)).get('/probe/a/m');
    expectProblem(res, 401, 'AUTH_REQUIRED');
  });

  it('answers the anonymous principal with AUTH_REQUIRED', async () => {
    user = { id: 'anonymous', isContentAdmin: true };
    const res = await request(appBehind(contentAdminAuth)).get('/probe/a/m');
    expectProblem(res, 401, 'AUTH_REQUIRED');
  });

  it('refuses a signed-in user who may not edit content', async () => {
    user = { id: 'u1', groups: ['users'] };
    const res = await request(appBehind(contentAdminAuth)).get('/probe/a/m');
    expectProblem(res, 403, 'FORBIDDEN');
    expect(res.body.detail).toBe('Content admin access required.');
  });

  it('lets a content admin through', async () => {
    user = { id: 'editor', isContentAdmin: true };
    const res = await request(appBehind(contentAdminAuth)).get('/probe/a/m');
    expect(res.status).toBe(200);
  });
});

describe('authRequired and authenticatedOnly', () => {
  it('refuses an unauthenticated request when anonymous access is off', async () => {
    const res = await request(appBehind(authRequired)).get('/probe/a/m');
    expectProblem(res, 401, 'AUTH_REQUIRED');
  });

  it('lets an anonymous request through when anonymous access is on', async () => {
    anonymousAllowed = true;
    const res = await request(appBehind(authRequired)).get('/probe/a/m');
    expect(res.status).toBe(200);
  });

  it('refuses the anonymous principal on an endpoint that needs a signed-in user', async () => {
    anonymousAllowed = true;
    user = { id: 'anonymous' };
    const res = await request(appBehind(authenticatedOnly)).get('/probe/a/m');
    expectProblem(res, 401, 'AUTH_REQUIRED');
  });

  it('lets a signed-in user through', async () => {
    user = { id: 'u1' };
    const res = await request(appBehind(authenticatedOnly)).get('/probe/a/m');
    expect(res.status).toBe(200);
  });
});

describe('appAccessRequired and modelAccessRequired', () => {
  const granted = (apps = [], models = []) => ({
    id: 'u1',
    permissions: { apps: new Set(apps), models: new Set(models) }
  });
  it('answers a request without a principal with AUTH_REQUIRED', async () => {
    const res = await request(appBehind(appAccessRequired)).get('/probe/a/m');
    expectProblem(res, 401, 'AUTH_REQUIRED');
  });

  it('answers an app the principal may not use with APP_ACCESS_DENIED', async () => {
    user = granted(['other'], []);
    const res = await request(appBehind(appAccessRequired)).get('/probe/secret/m');
    expectProblem(res, 403, 'APP_ACCESS_DENIED');
    expect(res.body.detail).toContain('secret');
  });

  it('answers a model the principal may not use with MODEL_ACCESS_DENIED', async () => {
    user = granted([], ['other']);
    const res = await request(appBehind(modelAccessRequired)).get('/probe/a/hidden');
    expectProblem(res, 403, 'MODEL_ACCESS_DENIED');
  });

  it('matches ids case-insensitively and honors the wildcard', async () => {
    user = granted(['SECRET'], []);
    expect((await request(appBehind(appAccessRequired)).get('/probe/secret/m')).status).toBe(200);
    user = granted(['*'], []);
    expect((await request(appBehind(appAccessRequired)).get('/probe/anything/m')).status).toBe(200);
  });
});

describe('rate limit handler', () => {
  it('answers once the budget is spent with RATE_LIMITED and Retry-After', async () => {
    const limiter = createOAuthTokenLimiter({ rateLimit: { oauthTokenApi: { limit: 2 } } });
    const app = express();
    app.post('/token', limiter, (req, res) => res.status(401).json({ error: 'invalid_client' }));
    app.use(errorHandler);

    await request(app).post('/token');
    await request(app).post('/token');
    const res = await request(app).post('/token');
    expect(res.status).toBe(429);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(res.headers['retry-after']).toBeDefined();
  });
});
