/**
 * Route tests for Admin → Security → Rate limits (`/api/admin/rate-limits`).
 *
 * Pinned here:
 *
 * - GET shows every limiter's window, limit and which requests count, both as
 *   saved and as the server started with them, and says when they differ;
 * - PUT writes only the limiters it is given to the stored platform.json —
 *   never the cache, which holds environment overrides and decrypted
 *   secrets — and keeps the rest of each limiter's section;
 * - out-of-range values and unknown limiters are refused.
 *
 * Native ESM: run with `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const state = {};
const reset = () => {
  state.platform = {
    auth: { mode: 'local' },
    rateLimit: {
      oauthApi: { windowMs: 60000, limit: 300, skipFailedRequests: false, message: 'Slow down' }
    }
  };
  state.cacheExtra = { jwtSecret: 'decrypted-secret' };
  state.writes = [];
  state.audit = [];
};
reset();

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => {
    req.user = { id: 'admin-user' };
    next();
  }
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => ({ ...state.platform, ...state.cacheExtra }),
    refreshCacheEntry: async () => {}
  }
}));

jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    readJsonStrict: async () => JSON.parse(JSON.stringify(state.platform)),
    writeJson: async (_file, data) => {
      state.writes.push(data);
      state.platform = data;
    }
  }
}));

jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: entry => {
    state.audit.push(entry);
    return entry;
  }
}));

const { default: registerRoutes } = await import('../routes/admin/rateLimits.js');

function createApp(bootPlatform) {
  const app = express();
  app.use(express.json());
  app.set('platform', bootPlatform);
  registerRoutes(app);
  return app;
}

beforeEach(reset);

describe('GET /api/admin/rate-limits', () => {
  test('lists every limiter as saved and as running', async () => {
    const app = createApp(JSON.parse(JSON.stringify(state.platform)));
    const res = await request(app).get('/api/admin/rate-limits');

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.limiters)).toEqual([
      'publicApi',
      'adminApi',
      'authApi',
      'oauthApi',
      'oauthTokenApi',
      'inferenceApi'
    ]);
    expect(res.body.limiters.oauthApi).toEqual({ windowMs: 60000, limit: 300, counts: 'all' });
    expect(res.body.limiters.oauthTokenApi).toEqual({
      windowMs: 900000,
      limit: 30,
      counts: 'failed'
    });
    expect(res.body.limiters.publicApi.counts).toBe('successful');
    expect(res.body.running).toEqual(res.body.limiters);
    expect(res.body.restartRequired).toBe(false);
  });

  test('says a restart is due when the saved limits differ from the running ones', async () => {
    const app = createApp({ rateLimit: { oauthApi: { windowMs: 900000, limit: 50 } } });
    const res = await request(app).get('/api/admin/rate-limits');

    expect(res.body.running.oauthApi).toMatchObject({ windowMs: 900000, limit: 50 });
    expect(res.body.restartRequired).toBe(true);
  });
});

describe('PUT /api/admin/rate-limits', () => {
  test('saves the given limiters to the stored config and keeps the rest', async () => {
    const app = createApp(JSON.parse(JSON.stringify(state.platform)));
    const res = await request(app)
      .put('/api/admin/rate-limits')
      .send({
        limiters: {
          oauthApi: { windowMs: 120000, limit: 1000, counts: 'all' },
          oauthTokenApi: { windowMs: 600000, limit: 10, counts: 'failed' }
        }
      });

    expect(res.status).toBe(200);
    expect(state.writes).toHaveLength(1);
    const written = state.writes[0];
    expect(written.rateLimit.oauthApi).toEqual({
      windowMs: 120000,
      limit: 1000,
      skipSuccessfulRequests: false,
      skipFailedRequests: false,
      message: 'Slow down'
    });
    expect(written.rateLimit.oauthTokenApi).toEqual({
      windowMs: 600000,
      limit: 10,
      skipSuccessfulRequests: true,
      skipFailedRequests: false
    });
    // Only the stored file goes back: nothing the cache adds at runtime.
    expect(written.jwtSecret).toBeUndefined();
    expect(written.auth).toEqual({ mode: 'local' });

    expect(res.body.limiters.oauthApi).toEqual({ windowMs: 120000, limit: 1000, counts: 'all' });
    expect(res.body.restartRequired).toBe(true);
    expect(state.audit[0]).toMatchObject({ resource: 'platform', resourceId: 'rateLimit' });
  });

  test('"only successful requests" maps to skipFailedRequests', async () => {
    const app = createApp(state.platform);
    await request(app)
      .put('/api/admin/rate-limits')
      .send({ limiters: { publicApi: { windowMs: 60000, limit: 500, counts: 'successful' } } });

    expect(state.platform.rateLimit.publicApi).toMatchObject({
      skipSuccessfulRequests: false,
      skipFailedRequests: true
    });
  });

  test.each([
    ['a window under a second', { oauthApi: { windowMs: 10, limit: 5, counts: 'all' } }],
    ['a limit of zero', { oauthApi: { windowMs: 60000, limit: 0, counts: 'all' } }],
    ['a fractional limit', { oauthApi: { windowMs: 60000, limit: 2.5, counts: 'all' } }],
    ['an unknown count mode', { oauthApi: { windowMs: 60000, limit: 5, counts: 'some' } }],
    ['an unknown limiter', { mcpApi: { windowMs: 60000, limit: 5, counts: 'all' } }],
    ['an unknown field', { oauthApi: { windowMs: 60000, limit: 5, counts: 'all', x: 1 } }],
    ['nothing at all', {}]
  ])('refuses %s', async (_label, limiters) => {
    const app = createApp(state.platform);
    const res = await request(app).put('/api/admin/rate-limits').send({ limiters });

    expect(res.status).toBe(400);
    expect(state.writes).toHaveLength(0);
  });
});
