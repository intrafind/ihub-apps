/**
 * Regression test for #1684: the auth and inference rate limiters were
 * mounted with buildServerPath('/auth') / buildServerPath('/inference'),
 * which never matches the real route prefixes (/api/auth/..., /api/inference)
 * registered via buildServerPath('/api/auth/...') / buildServerPath('/api/inference').
 * As a result the brute-force limiter on login and the inference limiter
 * never fired. This test exercises setupMiddleware() against routes mounted
 * at the real /api/auth and /api/inference prefixes and asserts the limiter
 * actually kicks in with a 429 once the configured limit is exceeded.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { setupMiddleware } from '../middleware/setup.js';

jest.mock('../configCache.js', () => ({
  __esModule: true,
  default: {
    getPlatform: () => ({})
  }
}));

async function createTestApp(rateLimitOverrides) {
  const app = express();
  const platformConfig = {
    rateLimit: rateLimitOverrides
  };
  setupMiddleware(app, platformConfig);

  // Mirrors the real route registrations: auth.js registers under
  // buildServerPath('/api/auth/...') and openaiProxy.js under
  // buildServerPath('/api/inference').
  app.post('/api/auth/local/login', (req, res) => res.status(200).json({ ok: true }));
  app.get('/api/inference/v1/models', (req, res) => res.status(200).json({ ok: true }));

  return app;
}

describe('Auth and inference rate limiters (#1684)', () => {
  test('rate limiter fires for /api/auth/local/login once the auth limit is exceeded', async () => {
    const app = await createTestApp({ authApi: { limit: 3, windowMs: 60_000 } });

    for (let i = 0; i < 3; i++) {
      const response = await request(app).post('/api/auth/local/login').send({});
      expect(response.status).toBe(200);
    }

    const blocked = await request(app).post('/api/auth/local/login').send({});
    expect(blocked.status).toBe(429);
  });

  test('rate limiter fires for /api/inference once the inference limit is exceeded', async () => {
    const app = await createTestApp({ inferenceApi: { limit: 3, windowMs: 60_000 } });

    for (let i = 0; i < 3; i++) {
      const response = await request(app).get('/api/inference/v1/models');
      expect(response.status).toBe(200);
    }

    const blocked = await request(app).get('/api/inference/v1/models');
    expect(blocked.status).toBe(429);
  });
});
