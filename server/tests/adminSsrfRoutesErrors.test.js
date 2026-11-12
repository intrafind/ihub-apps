// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The SSRF administration routes answer errors through the global error
 * middleware: every invalid entry of the allowlist is a BAD_REQUEST with
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

const { default: registerAdminSsrfRoutes } = await import('../routes/admin/ssrf.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
registerAdminSsrfRoutes(app);
app.use(errorHandler);

const VALID = { allowedHosts: ['intranet.example.com'] };

beforeEach(() => {
  state.platform = {};
  state.written = null;
});

describe('SSRF administration routes: errors', () => {
  it.each([
    [{ allowedHosts: 'x' }, 'allowedHosts must be an array'],
    [{ allowedHosts: [1] }, 'entries must be strings'],
    [{ allowedHosts: ['  '] }, 'entries must be non-empty'],
    [{ allowedHosts: ['bad host!'] }, 'Invalid SSRF host pattern']
  ])('answers an invalid body %j with BAD_REQUEST', async (body, reason) => {
    const res = await request(app).put('/api/admin/ssrf/config').send(body).expect(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.detail).toContain(reason);
    expect(state.written).toBeNull();
  });

  it('saves a valid allowlist', async () => {
    await request(app).put('/api/admin/ssrf/config').send(VALID).expect(200);
    expect(state.written.ssrf.allowedHosts).toEqual(VALID.allowedHosts);
  });

  it('answers an unreadable platform file with a 500 that does not leak the cause', async () => {
    state.platform = null;
    const res = await request(app).put('/api/admin/ssrf/config').send(VALID).expect(500);
    expect(res.body.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('platform.json');
  });
});
