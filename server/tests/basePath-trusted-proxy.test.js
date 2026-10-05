/**
 * The forwarded base path (X-Forwarded-Prefix) is stripped from the URL inside
 * setupMiddleware, before the rate limiters, so a request sent under a prefix
 * counts against the same limiter as one without it. The header is only used
 * when the peer that sent it is trusted by `platform.trustProxy`.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

jest.unstable_mockModule('../configCache.js', () => ({
  __esModule: true,
  default: { getPlatform: () => ({}) }
}));

const { setupMiddleware } = await import('../middleware/setup.js');
const { getBasePath } = await import('../utils/basePath.js');

const STRICT = { rateLimit: { authApi: { limit: 2, windowMs: 900_000 } } };

function createTestApp(platformConfig) {
  const app = express();
  setupMiddleware(app, platformConfig);
  app.post('/api/auth/local/login', (req, res) => res.status(200).json({ ok: true }));
  app.get('/api/probe', (req, res) => res.json({ url: req.url }));
  return app;
}

const login = (app, prefix) =>
  prefix
    ? request(app).post(`${prefix}/api/auth/local/login`).set('X-Forwarded-Prefix', prefix)
    : request(app).post('/api/auth/local/login');

describe('a forwarded base path and the rate limiters', () => {
  test('a request sent under a prefix counts against the auth limiter', async () => {
    const app = createTestApp(STRICT);
    expect((await login(app, '/ihub')).status).toBe(200);
    expect((await login(app, '/ihub')).status).toBe(200);
    expect((await login(app, '/ihub')).status).toBe(429);
  });

  test('prefixed and unprefixed requests share one count', async () => {
    const app = createTestApp(STRICT);
    expect((await login(app)).status).toBe(200);
    expect((await login(app, '/other')).status).toBe(200);
    expect((await login(app)).status).toBe(429);
  });
});

describe('X-Forwarded-Prefix is used only from a trusted proxy', () => {
  test('a peer trusted by trustProxy has its prefix stripped', async () => {
    const app = createTestApp({ trustProxy: 'loopback' });
    const res = await request(app).get('/ihub/api/probe').set('X-Forwarded-Prefix', '/ihub');
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('/api/probe');
  });

  test('a peer outside trustProxy has its header ignored', async () => {
    const app = createTestApp({ trustProxy: '10.0.0.0/8' });
    const res = await request(app).get('/ihub/api/probe').set('X-Forwarded-Prefix', '/ihub');
    expect(res.status).toBe(404);
  });

  test('trustProxy false ignores the header', async () => {
    const app = createTestApp({ trustProxy: false });
    const res = await request(app).get('/ihub/api/probe').set('X-Forwarded-Prefix', '/ihub');
    expect(res.status).toBe(404);
  });

  test('an untrusted header does not become the base path of generated URLs', async () => {
    const { basePathDetectionMiddleware } = await import('../utils/basePath.js');
    const app = express();
    setupMiddleware(app, { trustProxy: '10.0.0.0/8' });
    app.use(basePathDetectionMiddleware);
    app.get('/api/base', (req, res) => res.json({ basePath: getBasePath() }));
    const res = await request(app).get('/api/base').set('X-Forwarded-Prefix', '/ihub');
    expect(res.body.basePath).toBe('');

    const trusted = express();
    setupMiddleware(trusted, { trustProxy: 'loopback' });
    trusted.use(basePathDetectionMiddleware);
    trusted.get('/api/base', (req, res) => res.json({ basePath: getBasePath() }));
    const ok = await request(trusted).get('/api/base').set('X-Forwarded-Prefix', '/ihub');
    expect(ok.body.basePath).toBe('/ihub');
  });
});
