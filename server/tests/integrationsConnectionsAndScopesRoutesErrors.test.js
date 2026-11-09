// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The connections and scopes routes answer errors through the global error
 * middleware: a disabled OAuth server is NOT_FOUND, a missing identity
 * AUTH_REQUIRED, a delegated caller FORBIDDEN, and invalid identifiers
 * BAD_REQUEST.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { platform: {}, user: null, connections: [], apps: [], models: [] };

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => state.platform,
    getFeatures: () => ({}),
    getApps: () => ({ data: state.apps }),
    getModels: () => ({ data: state.models })
  }
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
jest.unstable_mockModule('../services/oauth/ConnectionService.js', () => ({
  listConnectionsForUser: () => state.connections,
  revokeConnection: async () => ({ refreshTokensRevoked: 0 })
}));
jest.unstable_mockModule('../services/integrations/scopes/index.js', () => ({
  appScopeSettings: () => ({ scopePicker: 'off' }),
  applicableScopeProviders: () => [],
  getScopeProvider: () => null
}));

const { default: connectionsRouter } = await import('../routes/integrations/connections.js');
const { default: scopesRouter } = await import('../routes/integrations/scopes.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.user = state.user;
  next();
});
app.use('/api/integrations/connections', connectionsRouter);
app.use('/api/integrations', scopesRouter);
app.use(errorHandler);

const USER = { id: 'alice', groups: ['users'] };

function expectProblem(res, status, code) {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  expect(res.body.code).toBe(code);
}

beforeEach(() => {
  state.platform = { oauth: { enabled: { authz: true } } };
  state.user = { ...USER };
  state.connections = [];
  state.apps = [];
  state.models = [];
});

describe('integration connections routes: errors', () => {
  it('answers NOT_FOUND when the OAuth server is disabled', async () => {
    state.platform = { oauth: { enabled: { authz: false } } };
    const list = await request(app).get('/api/integrations/connections');
    expectProblem(list, 404, 'NOT_FOUND');
    expect(list.body.detail).toMatch(/not enabled/i);
    expectProblem(await request(app).delete('/api/integrations/connections/c1'), 404, 'NOT_FOUND');
  });

  it.each([
    ['no user', null],
    ['anonymous', { id: 'anonymous' }]
  ])('answers %s with AUTH_REQUIRED', async (_label, user) => {
    state.user = user;
    const res = await request(app).get('/api/integrations/connections');
    expectProblem(res, 401, 'AUTH_REQUIRED');
    expect(res.body.detail).toMatch(/authentication required/i);
  });

  it.each([
    ['an OAuth client', { isOAuthClient: true }],
    ['an agent', { isAgent: true }],
    ['a delegated auth mode', { authMode: 'oauth_personal_key' }]
  ])('answers %s with FORBIDDEN', async (_label, extra) => {
    state.user = { ...USER, ...extra };
    const list = await request(app).get('/api/integrations/connections');
    expectProblem(list, 403, 'FORBIDDEN');
    expect(list.body.detail).toMatch(/interactive session/i);
    expectProblem(await request(app).delete('/api/integrations/connections/c1'), 403, 'FORBIDDEN');
  });

  it('answers a connection the caller does not own with NOT_FOUND', async () => {
    state.connections = [{ clientId: 'other' }];
    const res = await request(app).delete('/api/integrations/connections/c1');
    expectProblem(res, 404, 'NOT_FOUND');
    expect(res.body.detail).toBe('Connection not found');
  });
});

describe('integration scopes routes: errors', () => {
  it.each([
    ['a missing appId', '/api/integrations/scopes', 'A valid appId is required'],
    ['an unsafe appId', '/api/integrations/scopes?appId=bad%20id', 'A valid appId is required'],
    ['an unsafe modelId', '/api/integrations/scopes?appId=app1&modelId=bad%20id', 'Invalid modelId']
  ])('answers %s with BAD_REQUEST', async (_label, url, detail) => {
    const res = await request(app).get(url);
    expectProblem(res, 400, 'BAD_REQUEST');
    expect(res.body.detail).toBe(detail);
  });

  it('answers an unknown app with NOT_FOUND', async () => {
    const res = await request(app).get('/api/integrations/scopes?appId=app1');
    expectProblem(res, 404, 'NOT_FOUND');
    expect(res.body.detail).toBe('App not found');
  });

  it('answers an app the user may not use with NOT_FOUND', async () => {
    state.apps = [{ id: 'app1' }];
    state.user = { ...USER, permissions: { apps: new Set(['other']) } };
    const res = await request(app).get('/api/integrations/scopes?appId=app1');
    expectProblem(res, 404, 'NOT_FOUND');
  });

  it('answers an unknown integration with NOT_FOUND', async () => {
    const res = await request(app).get('/api/integrations/nope/scopes?appId=app1');
    expectProblem(res, 404, 'NOT_FOUND');
    expect(res.body.detail).toBe('Integration not found');
  });
});
