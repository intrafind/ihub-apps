// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The usage limit administration routes answer errors through the global error
 * middleware: every invalid input is a BAD_REQUEST with the reason in `detail`,
 * and an unreadable platform file is a 500.
 *
 * Run with `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = { platform: {}, written: null, user: { userKey: 'u1' }, nearArgs: null, reset: null };

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
jest.unstable_mockModule('../services/quota/quotaService.js', () => ({
  getCurrentWindows: () => ({ day: {}, week: {}, month: {} })
}));
jest.unstable_mockModule('../services/quota/QuotaLedger.js', () => ({
  getQuotaLedger: () => ({
    reset: async (...args) => {
      state.reset = args;
    }
  })
}));
jest.unstable_mockModule('../services/quota/quotaAdmin.js', () => ({
  getGroupOverview: async () => [],
  getModelOverview: async () => [],
  getQuotaUser: async () => state.user,
  listNearLimitUsers: async args => {
    state.nearArgs = args;
    return { items: [], total: 0 };
  },
  listQuotaUsers: async args => {
    state.usersArgs = args;
    return { items: [], nextCursor: null, total: 0 };
  }
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerRoutes } = await import('../routes/admin/usageLimits.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
registerRoutes(app);
app.use(errorHandler);

const SETTINGS = '/api/admin/usage/limits/settings';

beforeEach(() => {
  state.platform = {};
  state.written = null;
  state.user = { userKey: 'u1' };
  state.nearArgs = null;
  state.reset = null;
});

describe('usage limit administration routes: errors', () => {
  it.each([
    [{ allModels: { day: 'x' } }, 'Invalid allModels budget'],
    [{ allModels: { year: 1 } }, 'Invalid allModels budget'],
    [{ resets: { timezone: 'Mars/Base' } }, 'Unknown time zone'],
    [{ resets: { dailyAt: '25:00' } }, 'dailyAt must be HH:MM'],
    [{ resets: { weeklyAt: 'noon' } }, 'weeklyAt must be HH:MM'],
    [{ resets: { monthlyAt: '1:00' } }, 'monthlyAt must be HH:MM'],
    [{ resets: { weeklyOn: 'someday' } }, 'weeklyOn must be a weekday name']
  ])('answers invalid settings %j with BAD_REQUEST', async (body, reason) => {
    const res = await request(app).put(SETTINGS).send(body).expect(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.detail).toContain(reason);
    expect(state.written).toBeNull();
  });

  it('answers an unreadable platform file with INTERNAL_ERROR', async () => {
    state.platform = null;
    const res = await request(app).put(SETTINGS).send({}).expect(500);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.status).toBe(500);
  });

  it('saves valid settings', async () => {
    const res = await request(app)
      .put(SETTINGS)
      .send({
        allModels: { day: 100, week: null },
        resets: { timezone: 'Europe/Berlin', dailyAt: '03:00', weeklyOn: 'friday' }
      })
      .expect(200);
    expect(state.written.usageLimits.allModels).toEqual({ day: 100 });
    expect(state.written.usageLimits.resets).toEqual({
      timezone: 'Europe/Berlin',
      dailyAt: '03:00',
      weeklyOn: 'friday'
    });
    expect(res.body).toHaveProperty('nextResets');
  });

  it('answers a malformed user key on the detail route with BAD_REQUEST', async () => {
    const res = await request(app).get('/api/admin/usage/limits/users/__proto__').expect(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.detail).toContain('Invalid user');
  });

  it('answers an unknown user with NOT_FOUND', async () => {
    state.user = null;
    const res = await request(app).get('/api/admin/usage/limits/users/nobody').expect(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.detail).toContain('User not found');
  });

  it.each([
    ['__proto__', {}, 'Invalid user'],
    ['u1', { window: 'year' }, 'window must be day, week or month'],
    ['u1', { modelId: 5 }, 'Invalid modelId']
  ])('answers a bad reset (%s, %j) with BAD_REQUEST', async (key, body, reason) => {
    const res = await request(app)
      .post(`/api/admin/usage/limits/users/${key}/_reset`)
      .send(body)
      .expect(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.detail).toContain(reason);
    expect(state.reset).toBeNull();
  });

  it('resets a user for a valid request', async () => {
    await request(app)
      .post('/api/admin/usage/limits/users/u1/_reset')
      .send({ modelId: 'gpt', window: 'day' })
      .expect(200);
    expect(state.reset[0]).toBe('u1');
    expect(state.reset[2]).toEqual({ modelId: 'gpt', window: 'day' });
  });

  it.each([
    ['threshold=abc', 'threshold must be a number'],
    ['threshold=', 'threshold must be a number'],
    ['limit=x', 'limit must be a number'],
    ['threshold=2', 'threshold must be between 0 and 1'],
    ['threshold=-0.1', 'threshold must be between 0 and 1']
  ])('answers near-limit query %s with BAD_REQUEST', async (query, reason) => {
    const res = await request(app).get(`/api/admin/usage/limits/near?${query}`).expect(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('BAD_REQUEST');
    expect(res.body.detail).toContain(reason);
    expect(state.nearArgs).toBeNull();
  });

  it('lists near-limit users for valid numbers', async () => {
    await request(app).get('/api/admin/usage/limits/near?threshold=0.5&limit=10').expect(200);
    expect(state.nearArgs).toEqual({ threshold: 0.5, limit: 10 });
  });

  it('hands limit and cursor of the users list to the service, and no page or pageSize', async () => {
    const res = await request(app)
      .get('/api/admin/usage/limits/users')
      .query({ limit: '10', cursor: 'abc', status: 'exceeded', page: '3', pageSize: '99' })
      .expect(200);
    expect(res.body).toEqual({ items: [], nextCursor: null, total: 0 });
    expect(state.usersArgs).toMatchObject({ limit: '10', cursor: 'abc', status: 'exceeded' });
    expect(state.usersArgs.page).toBeUndefined();
    expect(state.usersArgs.pageSize).toBeUndefined();
  });
});
