/**
 * GET /api/auth/status tells the client whether proxy auth is on, and nothing
 * more: the names of the identity headers are not public.
 */
import { jest } from '@jest/globals';

const platform = {
  auth: { mode: 'proxy' },
  proxyAuth: {
    enabled: true,
    userHeader: 'X-Custom-User',
    groupsHeader: 'X-Custom-Groups',
    trustedProxies: ['loopback'],
    sharedSecretHeader: 'X-Custom-Secret'
  }
};
jest.unstable_mockModule('../configCache.js', () => ({
  __esModule: true,
  default: {
    getPlatform: () => platform,
    getUI: () => ({ data: {} }),
    get: () => ({ data: null, etag: null }),
    setCacheEntry: () => {}
  }
}));

const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { default: registerAuthRoutes } = await import('../routes/auth.js');

test('reports only whether proxy auth is enabled', async () => {
  const app = express();
  registerAuthRoutes(app);
  const res = await request(app).get('/api/auth/status');
  expect(res.status).toBe(200);
  expect(res.body.authMethods.proxy).toEqual({ enabled: true });
  expect(JSON.stringify(res.body)).not.toMatch(/X-Custom-(User|Groups|Secret)/);
});
