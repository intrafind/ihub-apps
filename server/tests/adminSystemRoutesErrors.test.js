// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The system administration routes let errors propagate to the global error
 * middleware: a failing resource probe is a 500 that does not leak the cause.
 * The routes take no input, so there is no BAD_REQUEST or NOT_FOUND case.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { failure: null };

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: () => ({}) }
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const real = await import('../services/systemResources.js');
jest.unstable_mockModule('../services/systemResources.js', () => ({
  ...real,
  collectSystemResources: async () => {
    if (state.failure) throw state.failure;
    return { cpu: { count: 2 } };
  },
  getStorageSnapshot: async () => {
    if (state.failure) throw state.failure;
    return [];
  },
  getMonitoredPaths: () => [],
  getLogFilePath: () => null,
  summarizeStorage: () => null
}));

const { default: registerAdminSystemRoutes } = await import('../routes/admin/system.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
registerAdminSystemRoutes(app);
app.use(errorHandler);

beforeEach(() => {
  state.failure = null;
});

describe('system administration routes: errors', () => {
  it('returns the resource snapshot uncached', async () => {
    const res = await request(app).get('/api/admin/system/resources').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.cpu.count).toBe(2);
  });

  it('returns the storage summary', async () => {
    const res = await request(app).get('/api/admin/system/storage').expect(200);
    expect(res.body).toEqual({ storage: null });
  });

  it.each(['/api/admin/system/resources', '/api/admin/system/storage'])(
    'answers an unexpected failure at %s with a 500 that does not leak the cause',
    async url => {
      state.failure = new Error('boom at /srv/secret/path');
      const res = await request(app).get(url).expect(500);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('/srv/secret');
    }
  );
});
