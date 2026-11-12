// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The CORS administration routes answer errors through the global error
 * middleware: every invalid field of the configuration is a BAD_REQUEST with
 * the reason in `detail`, and an unreadable platform file is a 500 that does
 * not leak the cause.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { platform: {}, written: null };

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    // Same read-change-write the real store does for updateJson.
    updateJson: async (_path, mutate) => {
      const current = state.platform;
      const next = await mutate(current === null ? null : structuredClone(current));
      if (next === undefined) return { data: current, written: false };
      state.written = next;
      return { data: next, written: true };
    },
    readJson: async () => state.platform,
    writeJson: async (_path, data) => {
      state.written = data;
    }
  }
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: () => ({}), refreshCacheEntry: async () => {} }
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerAdminCorsRoutes } = await import('../routes/admin/cors.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
registerAdminCorsRoutes(app);
app.use(errorHandler);

const VALID = {
  origin: ['https://a.example'],
  credentials: true,
  maxAge: 60,
  methods: ['GET'],
  allowedHeaders: ['Accept']
};

beforeEach(() => {
  state.platform = {};
  state.written = null;
});

describe('CORS administration routes: errors', () => {
  it.each([
    [{ origin: 'x' }, 'origin must be an array'],
    [{ origin: [''] }, 'all origins must be non-empty strings'],
    [{ credentials: 'yes' }, 'credentials must be a boolean'],
    [{ maxAge: -1 }, 'maxAge must be a non-negative integer'],
    [{ methods: [] }, 'methods must be a non-empty array'],
    [{ methods: [1] }, 'all methods must be non-empty strings'],
    [{ allowedHeaders: 'x' }, 'allowedHeaders must be an array'],
    [{ allowedHeaders: [' '] }, 'all allowedHeaders must be non-empty strings']
  ])('answers an invalid field %j with BAD_REQUEST', async (patch, reason) => {
    const res = await request(app)
      .put('/api/admin/cors/config')
      .send({ ...VALID, ...patch })
      .expect(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.detail).toContain(reason);
    expect(state.written).toBeNull();
  });

  it('saves a valid configuration', async () => {
    await request(app).put('/api/admin/cors/config').send(VALID).expect(200);
    expect(state.written.cors).toEqual(VALID);
  });

  it('answers an unreadable platform file with a 500 that does not leak the cause', async () => {
    state.platform = null;
    const res = await request(app).put('/api/admin/cors/config').send(VALID).expect(500);
    expect(res.body.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('platform.json');
  });
});
