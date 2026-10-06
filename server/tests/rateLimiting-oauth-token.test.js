/**
 * OAuth rate limits (`rateLimit.oauthApi`, `rateLimit.oauthTokenApi`).
 *
 * The token endpoint used to carry a hard-coded 20 requests per 15 minutes
 * per address. Microsoft 365 Copilot exchanges and refreshes every one of its
 * users' tokens from a handful of Microsoft addresses, so that limit capped a
 * whole tenant at a few dozen users. Pinned here:
 *
 * - the token limiter counts only failed requests: a client that
 *   authenticates correctly is never slowed down, however busy;
 * - failed guesses at /token and /introspect share one budget, and once it is
 *   spent the address gets 429 until the window ends;
 * - both limits come from platform.json, with defaults sized for real traffic.
 */

import request from 'supertest';
import express from 'express';
import {
  createOAuthTokenLimiter,
  resolveRateLimitConfigs,
  RATE_LIMITER_KEYS
} from '../middleware/rateLimiting.js';

/** A token and an introspection endpoint that succeed when told to. */
function createApp(platformConfig) {
  const app = express();
  app.use(express.json());
  const limiter = createOAuthTokenLimiter(platformConfig);
  const handler = (req, res) =>
    req.body?.ok
      ? res.json({ access_token: 'x' })
      : res.status(401).json({ error: 'invalid_client' });
  app.post('/api/oauth/token', limiter, handler);
  app.post('/api/oauth/introspect', limiter, handler);
  return app;
}

const STRICT = { rateLimit: { oauthTokenApi: { limit: 3 } } };

describe('OAuth token limiter', () => {
  test('never counts successful token requests', async () => {
    const app = createApp(STRICT);
    for (let i = 0; i < 25; i++) {
      const res = await request(app).post('/api/oauth/token').send({ ok: true });
      expect(res.status).toBe(200);
    }
  });

  test('stops an address after the configured number of failures', async () => {
    const app = createApp(STRICT);
    for (let i = 0; i < 3; i++) {
      expect((await request(app).post('/api/oauth/token').send({})).status).toBe(401);
    }
    const blocked = await request(app).post('/api/oauth/token').send({});
    expect(blocked.status).toBe(429);
    // The window is spent for this address, whatever the next call carries.
    expect((await request(app).post('/api/oauth/token').send({ ok: true })).status).toBe(429);
  });

  test('token and introspection failures share one budget', async () => {
    const app = createApp(STRICT);
    expect((await request(app).post('/api/oauth/token').send({})).status).toBe(401);
    expect((await request(app).post('/api/oauth/introspect').send({})).status).toBe(401);
    expect((await request(app).post('/api/oauth/token').send({})).status).toBe(401);
    expect((await request(app).post('/api/oauth/introspect').send({})).status).toBe(429);
  });

  test('an admin can make it count every request', async () => {
    const app = createApp({
      rateLimit: { oauthTokenApi: { limit: 2, skipSuccessfulRequests: false } }
    });
    expect((await request(app).post('/api/oauth/token').send({ ok: true })).status).toBe(200);
    expect((await request(app).post('/api/oauth/token').send({ ok: true })).status).toBe(200);
    expect((await request(app).post('/api/oauth/token').send({ ok: true })).status).toBe(429);
  });
});

describe('resolveRateLimitConfigs', () => {
  test('ships OAuth limits sized for real traffic', () => {
    const { oauthApi, oauthTokenApi } = resolveRateLimitConfigs({});
    expect(oauthApi).toMatchObject({ windowMs: 60_000, limit: 300, skipFailedRequests: false });
    expect(oauthTokenApi).toMatchObject({
      windowMs: 900_000,
      limit: 30,
      skipSuccessfulRequests: true,
      skipFailedRequests: false
    });
  });

  test('platform.json wins over the defaults, limiter by limiter', () => {
    const configs = resolveRateLimitConfigs({
      rateLimit: {
        default: { windowMs: 30_000, limit: 50 },
        oauthTokenApi: { limit: 100 }
      }
    });
    expect(configs.oauthTokenApi).toMatchObject({ limit: 100, windowMs: 900_000 });
    // A limiter without its own values inherits `default`.
    expect(configs.publicApi).toMatchObject({ windowMs: 30_000, limit: 50 });
  });

  test('resolves every limiter an admin can tune', () => {
    expect(Object.keys(resolveRateLimitConfigs({}))).toEqual([...RATE_LIMITER_KEYS]);
  });
});
