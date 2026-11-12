// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The rate limit administration routes answer errors through the global error
 * middleware: an invalid body is VALIDATION_FAILED with the issues in
 * `errors`, an empty change is a BAD_REQUEST and an unreadable platform file
 * is a 500 that does not leak the cause.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { platform: {}, readError: null, written: null };

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => {
    req.user = { id: 'admin' };
    next();
  }
}));
jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    // Same read-change-write the real store does for updateJson.
    updateJson: async (_path, mutate) => {
      if (state.readError) throw state.readError;
      const current = state.platform;
      const next = await mutate(current === null ? null : structuredClone(current));
      if (next === undefined) return { data: current, written: false };
      state.written = next;
      return { data: next, written: true };
    },
    readJsonStrict: async () => {
      if (state.readError) throw state.readError;
      return state.platform;
    },
    writeJson: async (_path, data) => {
      state.written = data;
    }
  }
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: () => ({}), refreshCacheEntry: async () => {} }
}));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: () => {}
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerAdminRateLimitRoutes } = await import('../routes/admin/rateLimits.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { RATE_LIMITER_KEYS } = await import('../middleware/rateLimiting.js');

const app = express();
app.use(express.json());
registerAdminRateLimitRoutes(app);
app.use(errorHandler);

const URL = '/api/admin/rate-limits';
const KEY = RATE_LIMITER_KEYS[0];
const VALID = { windowMs: 60000, limit: 10, counts: 'failed' };

beforeEach(() => {
  state.platform = {};
  state.readError = null;
  state.written = null;
});

describe('admin rate limit routes: errors', () => {
  it.each([
    [{ limiters: { [KEY]: { ...VALID, limit: 0 } } }],
    [{ limiters: { [KEY]: { ...VALID, counts: 'sometimes' } } }],
    [{ limiters: { unknownLimiter: VALID } }],
    [{}]
  ])('answers an invalid body %j with VALIDATION_FAILED', async body => {
    const res = await request(app).put(URL).send(body).expect(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.length).toBeGreaterThan(0);
    expect(state.written).toBeNull();
  });

  it('answers an empty change with BAD_REQUEST', async () => {
    const res = await request(app).put(URL).send({ limiters: {} }).expect(400);
    expect(res.body).toMatchObject({ code: 'BAD_REQUEST', detail: 'No rate limits to save' });
    expect(state.written).toBeNull();
  });

  it('saves a valid change', async () => {
    const res = await request(app)
      .put(URL)
      .send({ limiters: { [KEY]: VALID } })
      .expect(200);
    expect(state.written.rateLimit[KEY]).toMatchObject({
      windowMs: 60000,
      limit: 10,
      skipSuccessfulRequests: true,
      skipFailedRequests: false
    });
    expect(res.body).toHaveProperty('limiters');
  });

  it('answers an unreadable platform file with a 500 that does not leak the cause', async () => {
    state.readError = new Error('cannot parse /srv/secret/platform.json');
    const res = await request(app)
      .put(URL)
      .send({ limiters: { [KEY]: VALID } })
      .expect(500);
    expect(res.body.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('/srv/secret');
  });
});
