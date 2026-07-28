/**
 * The strict auth limiter (30 requests / 15 min by default) is there to slow
 * password guessing. Mounted on the whole `/api/auth` namespace it also
 * throttled endpoints that carry no credentials — above all `/api/auth/status`,
 * which the SPA fetches on every boot and on every 401 recovery, and which
 * operators use as the container health probe.
 *
 * The result was a platform that looked wedged: once the window was spent
 * (trivially, since behind two proxy hops every caller shares one `req.ip` and
 * therefore one counter) `/api/auth/status` answered 429 to everyone, including
 * the probe, for the rest of the window.
 *
 * Read-only auth endpoints must therefore skip the credential limiter while the
 * credential endpoints stay throttled.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { setupMiddleware, resolveTrustProxy } from '../middleware/setup.js';
import { isReadOnlyAuthRequest } from '../middleware/rateLimiting.js';

jest.mock('../configCache.js', () => ({
  __esModule: true,
  default: {
    getPlatform: () => ({})
  }
}));

function createTestApp(platformConfig = {}) {
  const app = express();
  setupMiddleware(app, platformConfig);

  // Mirrors the real registrations in routes/auth.js.
  app.get('/api/auth/status', (req, res) => res.status(200).json({ ok: true, ip: req.ip }));
  app.get('/api/auth/user', (req, res) => res.status(200).json({ ok: true }));
  app.get('/api/auth/oidc/providers', (req, res) => res.status(200).json({ ok: true }));
  app.get('/api/auth/oidc/entra/callback', (req, res) => res.status(200).json({ ok: true }));
  app.post('/api/auth/logout', (req, res) => res.status(200).json({ ok: true }));
  app.post('/api/auth/local/login', (req, res) => res.status(200).json({ ok: true }));

  return app;
}

const STRICT = { rateLimit: { authApi: { limit: 3, windowMs: 900_000 } } };

describe('read-only /api/auth endpoints are exempt from the credential limiter', () => {
  test('/api/auth/status keeps answering well past the auth limit', async () => {
    const app = createTestApp(STRICT);

    for (let i = 0; i < 25; i++) {
      const response = await request(app).get('/api/auth/status');
      expect(response.status).toBe(200);
    }
  });

  test('other read-only auth endpoints are exempt too', async () => {
    const app = createTestApp(STRICT);

    for (const path of ['/api/auth/user', '/api/auth/oidc/providers']) {
      for (let i = 0; i < 10; i++) {
        expect((await request(app).get(path)).status).toBe(200);
      }
    }
    // The SSO redirect target: throttling it locks every user out of logging in.
    for (let i = 0; i < 10; i++) {
      expect((await request(app).get('/api/auth/oidc/entra/callback')).status).toBe(200);
    }
    // Clearing a session must always be possible.
    for (let i = 0; i < 10; i++) {
      expect((await request(app).post('/api/auth/logout')).status).toBe(200);
    }
  });

  test('credential endpoints are still throttled', async () => {
    const app = createTestApp(STRICT);

    for (let i = 0; i < 3; i++) {
      expect((await request(app).post('/api/auth/local/login')).status).toBe(200);
    }
    expect((await request(app).post('/api/auth/local/login')).status).toBe(429);
  });

  test('status traffic does not consume the credential window', async () => {
    const app = createTestApp(STRICT);

    for (let i = 0; i < 20; i++) {
      await request(app).get('/api/auth/status');
    }
    // The login budget must be untouched by the status polling above.
    for (let i = 0; i < 3; i++) {
      expect((await request(app).post('/api/auth/local/login')).status).toBe(200);
    }
    expect((await request(app).post('/api/auth/local/login')).status).toBe(429);
  });

  test('read-only auth endpoints remain bounded by the public limiter', async () => {
    const app = createTestApp({
      rateLimit: {
        authApi: { limit: 3, windowMs: 900_000 },
        publicApi: { limit: 5, windowMs: 60_000 }
      }
    });

    for (let i = 0; i < 5; i++) {
      expect((await request(app).get('/api/auth/status')).status).toBe(200);
    }
    expect((await request(app).get('/api/auth/status')).status).toBe(429);
  });
});

describe('isReadOnlyAuthRequest', () => {
  const check = (method, path) => isReadOnlyAuthRequest({ method, path });

  test('classifies read-only paths', () => {
    expect(check('GET', '/status')).toBe(true);
    expect(check('GET', '/status/')).toBe(true);
    expect(check('GET', '/user')).toBe(true);
    expect(check('POST', '/logout')).toBe(true);
    expect(check('GET', '/oidc/providers')).toBe(true);
    expect(check('GET', '/ldap/providers')).toBe(true);
    expect(check('GET', '/ntlm/status')).toBe(true);
    expect(check('GET', '/teams/client-config')).toBe(true);
    expect(check('GET', '/oidc/entra')).toBe(true);
    expect(check('GET', '/oidc/entra/callback')).toBe(true);
  });

  test('leaves credential endpoints throttled', () => {
    expect(check('POST', '/local/login')).toBe(false);
    expect(check('POST', '/ldap/login')).toBe(false);
    expect(check('POST', '/ntlm/login')).toBe(false);
    expect(check('GET', '/ntlm/login')).toBe(false);
    expect(check('POST', '/teams/exchange')).toBe(false);
    // A POST under /oidc/ is not a redirect and stays throttled.
    expect(check('POST', '/oidc/entra')).toBe(false);
  });
});

describe('resolveTrustProxy', () => {
  test('defaults to a single proxy hop', () => {
    expect(resolveTrustProxy({})).toBe(1);
    expect(resolveTrustProxy({ trustProxy: undefined })).toBe(1);
    expect(resolveTrustProxy({ trustProxy: '' })).toBe(1);
  });

  test('accepts hop counts, booleans and address lists', () => {
    expect(resolveTrustProxy({ trustProxy: 2 })).toBe(2);
    expect(resolveTrustProxy({ trustProxy: '2' })).toBe(2);
    expect(resolveTrustProxy({ trustProxy: 0 })).toBe(0);
    expect(resolveTrustProxy({ trustProxy: true })).toBe(true);
    expect(resolveTrustProxy({ trustProxy: 'false' })).toBe(false);
    expect(resolveTrustProxy({ trustProxy: 'loopback, 10.0.0.0/8' })).toBe('loopback, 10.0.0.0/8');
  });

  test('rejects nonsense without throwing', () => {
    expect(resolveTrustProxy({ trustProxy: { hops: 2 } })).toBe(1);
  });
});

describe('trustProxy decides the rate-limit identity', () => {
  /**
   * With two proxy hops and trustProxy=1, req.ip is the inner proxy for every
   * caller, so distinct clients share one counter. Raising it to the real hop
   * count separates them again.
   */
  const xff = '203.0.113.%d, 10.0.0.5';

  test('too-low hop count collapses distinct clients onto one counter', async () => {
    const app = createTestApp({
      trustProxy: 1,
      rateLimit: { authApi: { limit: 2, windowMs: 900_000 } }
    });

    expect(
      (
        await request(app)
          .post('/api/auth/local/login')
          .set('X-Forwarded-For', xff.replace('%d', '1'))
      ).status
    ).toBe(200);
    expect(
      (
        await request(app)
          .post('/api/auth/local/login')
          .set('X-Forwarded-For', xff.replace('%d', '2'))
      ).status
    ).toBe(200);
    // A third, unrelated client is locked out by the first two.
    expect(
      (
        await request(app)
          .post('/api/auth/local/login')
          .set('X-Forwarded-For', xff.replace('%d', '3'))
      ).status
    ).toBe(429);
  });

  test('correct hop count gives each client its own counter', async () => {
    const app = createTestApp({
      trustProxy: 2,
      rateLimit: { authApi: { limit: 2, windowMs: 900_000 } }
    });

    for (const client of ['1', '2', '3', '4']) {
      expect(
        (
          await request(app)
            .post('/api/auth/local/login')
            .set('X-Forwarded-For', xff.replace('%d', client))
        ).status
      ).toBe(200);
    }
  });
});
