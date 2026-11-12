// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The credential administration routes answer errors through the global error
 * middleware: an unsafe id, an unknown credential, an invalid body, a duplicate
 * id and an unreadable store.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { store: { credentials: {} }, readError: null };

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    readJsonStrict: async () => {
      if (state.readError) throw state.readError;
      return state.store;
    },
    updateJson: async (_path, mutate) => {
      if (state.readError) throw state.readError;
      const next = await mutate(structuredClone(state.store));
      if (next === undefined) return { data: state.store, written: false };
      state.store = structuredClone(next);
      return { data: next, written: true };
    },
    writeJson: async () => {}
  }
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: { refreshCredentialsCache: async () => {} }
}));
jest.unstable_mockModule('../services/TokenStorageService.js', () => ({
  default: { encryptString: value => `ENC[${value}]`, isEncrypted: value => /^ENC\[/.test(value) }
}));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: async () => {}
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerAdminCredentialsRoutes } = await import('../routes/admin/credentials.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
registerAdminCredentialsRoutes(app);
app.use(errorHandler);

beforeEach(() => {
  state.store = { credentials: {} };
  state.readError = null;
});

describe('credential administration routes: errors', () => {
  it('answers an unsafe id with BAD_REQUEST and an unknown credential with NOT_FOUND', async () => {
    const unsafe = await request(app).get('/api/admin/credentials/bad%20id').expect(400);
    expect(unsafe.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(unsafe.body.code).toBe('BAD_REQUEST');
    const missing = await request(app).get('/api/admin/credentials/nobody').expect(404);
    expect(missing.body).toMatchObject({ code: 'NOT_FOUND', detail: 'Credential not found' });
    await request(app).put('/api/admin/credentials/nobody').send({}).expect(404);
    await request(app).delete('/api/admin/credentials/nobody').expect(404);
  });

  it('answers an invalid body with VALIDATION_FAILED and a list of errors', async () => {
    const res = await request(app)
      .post('/api/admin/credentials')
      .send({ id: 'x', type: 'bearer' })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.detail).toBe('Invalid credential configuration');
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.length).toBeGreaterThan(0);
  });

  it('answers a duplicate id with CONFLICT', async () => {
    state.store = { credentials: { dup: { id: 'dup', type: 'bearer', token: 'x' } } };
    const res = await request(app)
      .post('/api/admin/credentials')
      .send({ id: 'dup', type: 'bearer', token: 'abc' })
      .expect(409);
    expect(res.body).toMatchObject({ code: 'CONFLICT', detail: 'Credential id already exists' });
  });

  it('answers an unreadable store with a 500 that does not leak the cause', async () => {
    state.readError = new Error('config/credentials.json exists but could not be read');
    const res = await request(app).get('/api/admin/credentials').expect(500);
    expect(res.body.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('credentials.json');
  });
});
