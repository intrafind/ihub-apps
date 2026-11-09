// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The personal API key routes answer errors through the global error
 * middleware: a disabled feature is NOT_FOUND, a missing identity AUTH_REQUIRED,
 * an ineligible user FORBIDDEN, a PersonalKeyError keeps its status, and an
 * unexpected manager failure is a 500 that does not leak its cause.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import * as realManager from '../utils/personalApiKeyManager.js';

const state = { platform: {}, user: null, managerError: null };

jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: () => state.platform, getFeatures: () => ({}) }
}));
jest.unstable_mockModule('../featureRegistry.js', () => ({
  requireFeature: () => (req, res, next) => next()
}));
jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  authRequired: (req, res, next) => next()
}));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({ logAudit: () => {} }));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));
jest.unstable_mockModule('../utils/personalApiKeyManager.js', () => ({
  ...realManager,
  listPersonalKeys: () => [],
  createPersonalKey: async () => {
    throw state.managerError;
  },
  rotatePersonalKey: async () => {
    throw state.managerError;
  },
  revokePersonalKey: async () => {
    throw state.managerError;
  }
}));

const { default: router } = await import('../routes/integrations/personalApiKeys.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const { PersonalKeyError } = realManager;

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.user = state.user;
  next();
});
app.use('/api/integrations/api-keys', router);
app.use(errorHandler);

const ENABLED = { oauth: { enabled: { clients: true }, personalKeys: { enabled: true } } };
const USER = { id: 'alice', groups: ['users'] };

function expectProblem(res, status, code) {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  expect(res.body.code).toBe(code);
}

beforeEach(() => {
  state.platform = JSON.parse(JSON.stringify(ENABLED));
  state.user = { ...USER };
  state.managerError = null;
});

describe('personal API key routes: errors', () => {
  it('rejects every route with NOT_FOUND when personal keys are disabled', async () => {
    state.platform = {};
    for (const res of [
      await request(app).get('/api/integrations/api-keys'),
      await request(app).post('/api/integrations/api-keys').send({}),
      await request(app).post('/api/integrations/api-keys/k1/_rotate').send({}),
      await request(app).delete('/api/integrations/api-keys/k1')
    ]) {
      expectProblem(res, 404, 'NOT_FOUND');
      expect(typeof res.body.detail).toBe('string');
    }
  });

  it.each([
    ['no user', null],
    ['anonymous', { id: 'anonymous' }],
    ['blank id', { id: '' }]
  ])('answers %s with AUTH_REQUIRED', async (_label, user) => {
    state.user = user;
    const res = await request(app).get('/api/integrations/api-keys');
    expectProblem(res, 401, 'AUTH_REQUIRED');
    expect(res.body.detail).toMatch(/authentication required/i);
  });

  it('answers a user outside allowedGroups with FORBIDDEN', async () => {
    state.platform.oauth.personalKeys.allowedGroups = ['admins'];
    const res = await request(app).post('/api/integrations/api-keys').send({});
    expectProblem(res, 403, 'FORBIDDEN');
    expect(res.body.detail).toMatch(/not allowed/i);
  });

  it('answers an OAuth client caller with FORBIDDEN', async () => {
    state.user = { ...USER, isOAuthClient: true };
    const res = await request(app).get('/api/integrations/api-keys');
    expectProblem(res, 403, 'FORBIDDEN');
  });

  it.each([
    [400, 'BAD_REQUEST'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT']
  ])('keeps the status %i of a PersonalKeyError', async (status, code) => {
    state.managerError = new PersonalKeyError('policy says no', status);
    const res = await request(app).post('/api/integrations/api-keys').send({});
    expectProblem(res, status, code);
    expect(res.body.detail).toBe('policy says no');
  });

  it('keeps the status of a PersonalKeyError on rotate and delete', async () => {
    state.managerError = new PersonalKeyError('API key not found', 404);
    expectProblem(
      await request(app).post('/api/integrations/api-keys/k1/_rotate').send({}),
      404,
      'NOT_FOUND'
    );
    expectProblem(await request(app).delete('/api/integrations/api-keys/k1'), 404, 'NOT_FOUND');
  });

  it('answers an unexpected manager error with a 500 that does not leak the cause', async () => {
    state.managerError = new Error('secret disk path /var/clients.json');
    const res = await request(app).post('/api/integrations/api-keys').send({});
    expectProblem(res, 500, 'INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('clients.json');
  });

  it.each([
    ['post', '/api/integrations/api-keys/bad%20id/_rotate'],
    ['delete', '/api/integrations/api-keys/bad%20id']
  ])('answers an invalid keyId on %s with BAD_REQUEST', async (method, url) => {
    const res = await request(app)[method](url).send({});
    expectProblem(res, 400, 'BAD_REQUEST');
    expect(res.body.detail).toContain('Invalid API key ID');
  });

  it('checks the feature gate before the keyId', async () => {
    state.platform = {};
    const res = await request(app).delete('/api/integrations/api-keys/bad%20id');
    expectProblem(res, 404, 'NOT_FOUND');
  });
});
