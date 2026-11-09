// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The overview route aggregates the cached configuration. A failing optional
 * probe (storage, integrations) degrades to a default; an unexpected failure
 * of the cache is a 500 that does not leak the cause.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { appsError: null };

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  authRequired: (req, res, next) => next()
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getApps: () => {
      if (state.appsError) throw state.appsError;
      return { data: [{ id: 'a' }, { id: 'b', enabled: false }] };
    },
    getModels: () => ({ data: [{ id: 'm' }] }),
    getProviders: () => ({ data: [] }),
    getProjects: () => ({ data: [] }),
    getGroups: () => ({ data: { groups: { admins: {}, users: {} } } }),
    get: () => ({ data: { users: { u1: {} } } }),
    getPlatform: () => ({ data: { auth: { mode: 'local' } } })
  }
}));

const realSystemResources = await import('../services/systemResources.js');
jest.unstable_mockModule('../services/systemResources.js', () => ({
  ...realSystemResources,
  getStorageSnapshot: async () => {
    throw new Error('boom at /srv/secret/path');
  }
}));

const { default: registerAdminOverviewRoutes } = await import('../routes/admin/overview.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
registerAdminOverviewRoutes(app);
app.use(errorHandler);

beforeEach(() => {
  state.appsError = null;
});

describe('Admin overview route: errors', () => {
  it('aggregates the cached configuration and degrades a failing storage probe', async () => {
    const res = await request(app).get('/api/admin/overview/stats').expect(200);
    expect(res.body.apps).toEqual({ total: 2, enabled: 1 });
    expect(res.body.groups).toBe(2);
    expect(res.body.users).toBe(1);
    expect(res.body.auth.mode).toBe('local');
    expect(res.body.storage).toBeNull();
  });

  it('answers an unexpected failure with a 500 that does not leak the cause', async () => {
    state.appsError = new Error('boom at /srv/secret/path');
    const res = await request(app).get('/api/admin/overview/stats').expect(500);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('/srv/secret');
    expect(JSON.stringify(res.body)).not.toContain('boom');
  });
});
