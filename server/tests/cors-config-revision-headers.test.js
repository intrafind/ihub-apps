// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A cross-origin admin client (a browser extension, an embedding host) saves
 * the platform and UI config with `If-Match` and reads the revision from the
 * `ETag` of the response. CORS must allow the one and expose the other, also
 * when the admin saved their own header lists before these headers existed.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const mockPlatform = { current: {} };
jest.unstable_mockModule('../configCache.js', () => ({
  __esModule: true,
  default: { getPlatform: () => mockPlatform.current }
}));

const { setupMiddleware } = await import('../middleware/setup.js');

const ORIGIN = 'https://embed.example.com';

function createTestApp(cors) {
  mockPlatform.current = { cors: { origin: [ORIGIN], ...cors } };
  const app = express();
  setupMiddleware(app, mockPlatform.current);
  app.get('/api/probe', (req, res) => res.set('ETag', '"rev-1"').json({}));
  return app;
}

const preflight = app =>
  request(app)
    .options('/api/probe')
    .set('Origin', ORIGIN)
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'if-match,content-type');

const allowed = res =>
  String(res.headers['access-control-allow-headers'] || '')
    .split(',')
    .map(h => h.trim().toLowerCase());
const exposed = res =>
  String(res.headers['access-control-expose-headers'] || '')
    .split(',')
    .map(h => h.trim().toLowerCase());

describe.each([
  ['the default header lists', {}],
  [
    'header lists the admin saved before these headers existed',
    { allowedHeaders: ['Content-Type', 'X-Custom'], exposedHeaders: ['X-Total'] }
  ]
])('CORS with %s', (_label, cors) => {
  test('a preflight allows If-Match', async () => {
    const res = await preflight(createTestApp(cors));
    expect(res.status).toBeLessThan(300);
    expect(allowed(res)).toContain('if-match');
  });

  test('a preflight allows the W3C trace context headers', async () => {
    const res = await preflight(createTestApp(cors));
    expect(allowed(res)).toEqual(expect.arrayContaining(['traceparent', 'tracestate']));
  });

  test('a response exposes ETag (and still Content-Disposition)', async () => {
    const res = await request(createTestApp(cors)).get('/api/probe').set('Origin', ORIGIN);
    expect(exposed(res)).toEqual(expect.arrayContaining(['etag', 'content-disposition']));
  });
});

test('an admin list that already names the headers does not repeat them', async () => {
  const app = createTestApp({ allowedHeaders: ['if-match'], exposedHeaders: ['etag'] });
  const res = await preflight(app);
  expect(allowed(res).filter(h => h === 'if-match')).toHaveLength(1);
  const get = await request(app).get('/api/probe').set('Origin', ORIGIN);
  expect(exposed(get).filter(h => h === 'etag')).toHaveLength(1);
});
