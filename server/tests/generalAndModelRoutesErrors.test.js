// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * General (apps, health) and model routes answer errors through the global
 * error middleware (RFC 9457 problem+json with a registry `code`).
 *
 * Run with `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { apps: { data: [] }, models: { data: [] }, appsForUser: {}, modelsForUser: {} };

const real0 = await import('../middleware/authRequired.js');
const realCache = (await import('../configCache.js')).default;
jest.unstable_mockModule('../configCache.js', async () => ({
  default: Object.assign(Object.create(realCache), {
    getPlatform: () => ({ defaultLanguage: 'en' }),
    getApps: () => state.apps,
    getModels: () => state.models,
    getAppsForUser: async () => state.appsForUser,
    getModelsForUser: async () => state.modelsForUser
  })
}));
jest.unstable_mockModule('../middleware/authRequired.js', async () => ({
  ...real0,
  authRequired: (req, res, next) => next(),
  appAccessRequired: (req, res, next) => next()
}));
jest.unstable_mockModule('../utils/logger.js', async () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerGeneralRoutes } = await import('../routes/generalRoutes.js');
const { default: registerModelRoutes } = await import('../routes/modelRoutes.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.user = {
    id: 'u1',
    groups: ['users'],
    permissions: { apps: new Set(['*']), models: new Set(['*']) }
  };
  next();
});
const getLocalizedError = async () => 'Not found';
registerGeneralRoutes(app, { getLocalizedError });
registerModelRoutes(app, { getLocalizedError });
app.use(errorHandler);

const expectProblem = (res, status, code) => {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  expect(res.body.code).toBe(code);
};

beforeEach(() => {
  state.apps = { data: [{ id: 'known' }] };
  state.models = { data: [{ id: 'm1', provider: 'openai' }] };
  state.appsForUser = { data: [{ id: 'known' }], etag: 'e' };
  state.modelsForUser = { data: [{ id: 'm1', provider: 'openai' }], etag: 'e' };
});

describe('general routes errors', () => {
  it('answers a null apps list with INTERNAL_ERROR', async () => {
    state.appsForUser = { data: null, etag: 'e' };
    expectProblem(await request(app).get('/api/apps'), 500, 'INTERNAL_ERROR');
  });

  it('answers app detail with null apps data with INTERNAL_ERROR', async () => {
    state.apps = { data: null };
    expectProblem(await request(app).get('/api/apps/known'), 500, 'INTERNAL_ERROR');
  });

  it('answers an unknown app with NOT_FOUND', async () => {
    expectProblem(await request(app).get('/api/apps/nope'), 404, 'NOT_FOUND');
  });

  it('keeps the health check ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OK');
  });
});

describe('model routes errors', () => {
  it('answers a null models list with INTERNAL_ERROR', async () => {
    state.modelsForUser = { data: null, etag: 'e' };
    expectProblem(await request(app).get('/api/models'), 500, 'INTERNAL_ERROR');
  });

  it('answers model detail with null models data with INTERNAL_ERROR', async () => {
    state.models = { data: null };
    expectProblem(await request(app).get('/api/models/m1'), 500, 'INTERNAL_ERROR');
  });

  it('answers an unknown model id with NOT_FOUND', async () => {
    expectProblem(await request(app).get('/api/models/nope'), 404, 'NOT_FOUND');
  });
});
