// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The version administration routes have no validation branches of their own;
 * an unexpected failure propagates to the global error middleware and is
 * answered as a 500 that does not leak the cause.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { versionError: null, checkError: null };

const realCheck = await import('../services/versionCheckService.js');
jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../utils/versionHelper.js', () => ({
  getAppVersion: () => {
    if (state.versionError) throw state.versionError;
    return '9.9.9';
  }
}));
jest.unstable_mockModule('../services/versionCheckService.js', () => ({
  ...realCheck,
  isVersionCheckDisabled: () => false,
  getVersionCheckEntry: () => {
    if (state.checkError) throw state.checkError;
    return null;
  },
  startBackgroundVersionCheck: () => false,
  buildUpdateInfo: (entry, currentVersion, { checking }) => ({
    updateAvailable: false,
    currentVersion,
    checking,
    lastCheckedAt: null
  })
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerAdminVersionRoutes } = await import('../routes/admin/version.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
registerAdminVersionRoutes(app);
app.use(errorHandler);

beforeEach(() => {
  state.versionError = null;
  state.checkError = null;
});

describe('version administration routes: errors', () => {
  it('reports the version', async () => {
    const res = await request(app).get('/api/admin/version').expect(200);
    expect(res.body).toMatchObject({ app: '9.9.9', client: '9.9.9', server: '9.9.9' });
  });

  it('answers the update check from the cache', async () => {
    const res = await request(app).get('/api/admin/version/check-update').expect(200);
    expect(res.body.currentVersion).toBe('9.9.9');
    expect(res.body.updateAvailable).toBe(false);
  });

  it('answers an unexpected failure of the version lookup with a 500 that does not leak the cause', async () => {
    state.versionError = new Error('boom at /srv/secret/path');
    const res = await request(app).get('/api/admin/version').expect(500);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('/srv/secret');
  });

  it('answers an unexpected failure of the update check with a 500 that does not leak the cause', async () => {
    state.checkError = new Error('boom at /srv/secret/path');
    const res = await request(app).get('/api/admin/version/check-update').expect(500);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('/srv/secret');
  });
});
