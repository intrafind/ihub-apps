// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The admin search route answers a too short query through the global error
 * middleware (BAD_REQUEST with the reason in `detail`). A category that cannot
 * be read is skipped, so the search itself never fails with a 5xx.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { throwing: new Set(), data: {} };
const source = (key, fallback) => () => {
  if (state.throwing.has(key)) throw new Error(`${key} unavailable`);
  return key in state.data ? state.data[key] : fallback;
};

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getApps: source('apps', { data: [] }),
    getPrompts: source('prompts', { data: [] }),
    getModels: source('models', { data: [] }),
    getGroups: source('groups', { data: {} }),
    get: source('users', { data: {} }),
    getProjects: source('projects', { data: [] }),
    getProviders: source('providers', { data: [] })
  }
}));

const { default: registerRoutes } = await import('../routes/admin/search.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
registerRoutes(app);
app.use(errorHandler);

const URL = '/api/admin/search';

beforeEach(() => {
  state.throwing = new Set();
  state.data = {};
});

describe('Admin search route: errors', () => {
  it.each([[''], ['a'], ['  a  '], [' ']])('answers the query %j with BAD_REQUEST', async q => {
    const res = await request(app).get(URL).query({ q }).expect(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.detail).toContain('at least 2 characters');
  });

  it('answers a missing query with BAD_REQUEST', async () => {
    const res = await request(app).get(URL).expect(400);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.detail).toContain('at least 2 characters');
  });

  it('skips every category that cannot be read instead of failing', async () => {
    state.throwing = new Set([
      'apps',
      'prompts',
      'models',
      'groups',
      'users',
      'projects',
      'providers'
    ]);
    const res = await request(app).get(URL).query({ q: 'abc' }).expect(200);
    expect(res.body).toEqual({
      apps: [],
      prompts: [],
      models: [],
      groups: [],
      users: [],
      projects: [],
      providers: []
    });
  });

  it('keeps the categories that can be read when another one fails', async () => {
    state.throwing = new Set(['models']);
    state.data.apps = { data: [{ id: 'chat-app', name: { en: 'Chat' }, enabled: true }] };
    const res = await request(app).get(URL).query({ q: ' CHAT ' }).expect(200);
    expect(res.body.apps).toEqual([{ id: 'chat-app', name: { en: 'Chat' }, enabled: true }]);
    expect(res.body.models).toEqual([]);
  });

  it('caps each category at 5 results', async () => {
    state.data.apps = {
      data: Array.from({ length: 8 }, (_, i) => ({ id: `match-${i}`, name: 'x', enabled: true }))
    };
    const res = await request(app).get(URL).query({ q: 'match' }).expect(200);
    expect(res.body.apps).toHaveLength(5);
  });

  it('finds groups and users by their fields', async () => {
    state.data.groups = { data: { groups: { g: { id: 'staff', name: 'Staff' } } } };
    state.data.users = {
      data: { users: { u: { id: 'u1', username: 'alice', email: 'a@x.io', name: 'Alice' } } }
    };
    const res = await request(app).get(URL).query({ q: 'ali' }).expect(200);
    expect(res.body.users).toEqual([{ id: 'u1', username: 'alice', email: 'a@x.io' }]);
    const groups = await request(app).get(URL).query({ q: 'sta' }).expect(200);
    expect(groups.body.groups).toEqual([{ id: 'staff', name: 'Staff' }]);
  });
});
