// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The cache administration routes answer errors through the global error
 * middleware: an invalid or already encrypted value is a BAD_REQUEST with the
 * reason in `detail`, and an unexpected failure is a 500 that does not leak
 * the thrown message.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { refreshAllError: null };

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: { readJson: async () => ({}), writeJson: async () => {} }
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getStats: () => ({}),
    refreshAll: async () => {
      if (state.refreshAllError) throw state.refreshAllError;
    },
    clear: () => {},
    initialize: async () => {},
    refreshCacheEntry: async () => {}
  }
}));
jest.unstable_mockModule('../configSync.js', () => ({
  announceFullConfigReload: () => {},
  getConfigSyncStats: () => ({})
}));
jest.unstable_mockModule('../services/TokenStorageService.js', () => ({
  default: {
    isEncrypted: value => value.startsWith('ENC['),
    encryptString: value => `ENC[${value}]`
  }
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerAdminCacheRoutes } = await import('../routes/admin/cache.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
registerAdminCacheRoutes(app);
app.use(errorHandler);

beforeEach(() => {
  state.refreshAllError = null;
});

describe('cache administration routes: errors', () => {
  it.each([
    [{}, 'Invalid value: must be a non-empty string'],
    [{ value: '   ' }, 'Invalid value: must be a non-empty string'],
    [{ value: 42 }, 'Invalid value: must be a non-empty string'],
    [{ value: 'ENC[abc]' }, 'Value is already encrypted']
  ])('answers encrypt-value body %j with BAD_REQUEST', async (body, reason) => {
    const res = await request(app).post('/api/admin/encrypt-value').send(body).expect(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.detail).toContain(reason);
  });

  it('encrypts a plaintext value', async () => {
    const res = await request(app).post('/api/admin/encrypt-value').send({ value: 'secret' });
    expect(res.status).toBe(200);
    expect(res.body.encryptedValue).toBe('ENC[secret]');
  });

  it('answers an unexpected failure with a 500 that does not leak the cause', async () => {
    state.refreshAllError = new Error('boom at /srv/secret/path');
    const res = await request(app).post('/api/admin/cache/_refresh').expect(500);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('/srv/secret');
  });
});
