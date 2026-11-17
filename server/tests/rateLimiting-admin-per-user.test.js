// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The admin API limiter counts per signed-in user or API client, not per
 * address. Admins behind one NAT address or reverse proxy used to share one
 * bucket, so one busy admin page spent everybody's budget. Requests without a
 * sign-in still count per address.
 *
 * The app is built with the real setupMiddleware, so the test also proves that
 * the limiter runs after the authentication chain has set req.user. Only the
 * proxy-auth step is replaced by a stub that signs a request in from a test
 * header; the rate limiter itself is not mocked.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

// Native ESM: the stub is registered with unstable_mockModule before the
// modules that import it are loaded dynamically below.
//
// It stands in for the first step of the authentication chain: a request with
// `x-test-user` is signed in as that user, one with `x-test-client` as an
// OAuth client (client_credentials / static API key), anything else stays
// unauthenticated.
jest.unstable_mockModule('../middleware/proxyAuth.js', () => ({
  proxyAuth: (req, res, next) => {
    const userId = req.headers['x-test-user'];
    const clientId = req.headers['x-test-client'];
    if (userId) req.user = { id: userId, groups: ['admins'], permissions: {} };
    if (clientId) req.user = { id: clientId, isOAuthClient: true, permissions: {} };
    next();
  }
}));

const { setupMiddleware } = await import('../middleware/setup.js');
const { adminApiRateLimitKey } = await import('../middleware/rateLimiting.js');

const LIMIT = 2;

function createTestApp() {
  const app = express();
  setupMiddleware(app, { rateLimit: { adminApi: { limit: LIMIT, windowMs: 60_000 } } });
  app.get('/api/admin/apps', (req, res) => res.status(200).json({ user: req.user?.id ?? null }));
  return app;
}

/** Send `count` requests and return their status codes. */
async function hit(app, headers, count) {
  const statuses = [];
  for (let i = 0; i < count; i++) {
    const response = await request(app).get('/api/admin/apps').set(headers);
    statuses.push(response.status);
  }
  return statuses;
}

const SAME_ADDRESS = { 'X-Forwarded-For': '203.0.113.10' };

describe('admin API limiter keys per user', () => {
  test('two users behind one address get separate buckets', async () => {
    const app = createTestApp();

    expect(await hit(app, { ...SAME_ADDRESS, 'x-test-user': 'alice' }, LIMIT + 1)).toEqual([
      200, 200, 429
    ]);
    // Bob shares Alice's address but has his own, untouched budget.
    expect(await hit(app, { ...SAME_ADDRESS, 'x-test-user': 'bob' }, LIMIT)).toEqual([200, 200]);
  });

  test('a user keeps the same bucket across addresses', async () => {
    const app = createTestApp();

    await hit(app, { 'X-Forwarded-For': '198.51.100.1', 'x-test-user': 'alice' }, LIMIT);
    expect(
      await hit(app, { 'X-Forwarded-For': '198.51.100.2', 'x-test-user': 'alice' }, 1)
    ).toEqual([429]);
  });

  test('an OAuth client gets its own bucket', async () => {
    const app = createTestApp();

    await hit(app, { ...SAME_ADDRESS, 'x-test-user': 'alice' }, LIMIT + 1);
    expect(await hit(app, { ...SAME_ADDRESS, 'x-test-client': 'reporting-bot' }, LIMIT)).toEqual([
      200, 200
    ]);
  });

  test('requests without a sign-in fall back to the address', async () => {
    const app = createTestApp();

    expect(await hit(app, SAME_ADDRESS, LIMIT + 1)).toEqual([200, 200, 429]);
    // Another address has its own bucket ...
    expect(await hit(app, { 'X-Forwarded-For': '203.0.113.11' }, 1)).toEqual([200]);
    // ... and a signed-in user at the exhausted address is not affected.
    expect(await hit(app, { ...SAME_ADDRESS, 'x-test-user': 'alice' }, 1)).toEqual([200]);
  });

  test('a blocked user is told when to retry', async () => {
    const app = createTestApp();
    await hit(app, { 'x-test-user': 'carol' }, LIMIT);
    const blocked = await request(app).get('/api/admin/apps').set('x-test-user', 'carol');
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
  });
});

describe('adminApiRateLimitKey', () => {
  test('keys a signed-in user by id and an OAuth client by client id', () => {
    expect(adminApiRateLimitKey({ user: { id: 'alice' }, ip: '10.0.0.1' })).toBe('user:alice');
    expect(adminApiRateLimitKey({ user: { id: 'bot', isOAuthClient: true }, ip: '10.0.0.1' })).toBe(
      'client:bot'
    );
  });

  test('keys the anonymous principal and a missing user by address', () => {
    expect(adminApiRateLimitKey({ user: { id: 'anonymous' }, ip: '10.0.0.1' })).toBe('ip:10.0.0.1');
    expect(adminApiRateLimitKey({ user: null, ip: '10.0.0.1' })).toBe('ip:10.0.0.1');
  });

  test('keeps a user id that looks like an address apart from that address', () => {
    expect(adminApiRateLimitKey({ user: { id: '10.0.0.1' }, ip: '10.0.0.1' })).not.toBe(
      adminApiRateLimitKey({ user: null, ip: '10.0.0.1' })
    );
  });

  test('groups IPv6 addresses of one /56 and maps IPv4-mapped addresses to IPv4', () => {
    const a = adminApiRateLimitKey({ ip: '2001:db8:abcd:1200::1' });
    const b = adminApiRateLimitKey({ ip: '2001:db8:abcd:12ff:ffff::2' });
    expect(a).toBe(b);
    expect(a).not.toBe(adminApiRateLimitKey({ ip: '2001:db8:abcd:1300::1' }));
    expect(adminApiRateLimitKey({ ip: '::ffff:192.0.2.1' })).toBe('ip:192.0.2.1');
  });
});
