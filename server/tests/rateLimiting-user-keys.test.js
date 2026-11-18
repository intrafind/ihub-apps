// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Limits for large installations: who a request counts for.
 *
 * A thousand colleagues behind one corporate NAT address used to share one
 * per-IP budget. Pinned here:
 *
 * - the general limiters count a signed-in request per user, an anonymous one
 *   per address (`anonymousLimit`), and `keyBy: "ip"` brings back per address;
 * - the sign-in limiter counts per address and submitted username, with a
 *   separate ceiling of failed sign-ins per address (`perIpLimit`).
 */

import request from 'supertest';
import express from 'express';
import { createRateLimiters } from '../middleware/rateLimiting.js';

/**
 * An app with the limiters mounted as in middleware/setup.js: the credential
 * limiter before authentication, the general ones after it. The test's
 * "authentication" reads the user from a header; addresses come from
 * X-Forwarded-For.
 */
function createApp(rateLimit) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  const limiters = createRateLimiters({ rateLimit });
  app.use('/api/auth', limiters.authApiLimiter);
  app.use((req, res, next) => {
    const id = req.get('x-test-user');
    req.user = id ? { id } : { id: 'anonymous' };
    next();
  });
  app.use('/api/apps', limiters.publicApiLimiter);
  app.get('/api/apps', (req, res) => res.json({ items: [] }));
  app.post('/api/auth/local/login', (req, res) => res.status(401).json({ error: 'nope' }));
  return app;
}

const get = (app, { ip = '10.0.0.1', user } = {}) => {
  const call = request(app).get('/api/apps').set('X-Forwarded-For', ip);
  return user ? call.set('x-test-user', user) : call;
};

const login = (app, username, ip = '10.0.0.1') =>
  request(app).post('/api/auth/local/login').set('X-Forwarded-For', ip).send({ username });

describe('general limiters, keyBy "user"', () => {
  const app = () =>
    createApp({ publicApi: { limit: 2, anonymousLimit: 3, keyBy: 'user', windowMs: 60000 } });

  test('two users behind one address count separately', async () => {
    const server = app();
    for (let i = 0; i < 2; i++) expect((await get(server, { user: 'alice' })).status).toBe(200);
    expect((await get(server, { user: 'alice' })).status).toBe(429);
    expect((await get(server, { user: 'bob' })).status).toBe(200);
  });

  test('anonymous requests count per address, with their own limit', async () => {
    const server = app();
    for (let i = 0; i < 3; i++) expect((await get(server)).status).toBe(200);
    expect((await get(server)).status).toBe(429);
    expect((await get(server, { ip: '10.0.0.2' })).status).toBe(200);
    // A signed-in user behind the same address is not affected.
    expect((await get(server, { user: 'alice' })).status).toBe(200);
  });

  test('"user" is the default', async () => {
    const server = createApp({ publicApi: { limit: 1, windowMs: 60000 } });
    expect((await get(server, { user: 'alice' })).status).toBe(200);
    expect((await get(server, { user: 'bob' })).status).toBe(200);
    expect((await get(server, { user: 'alice' })).status).toBe(429);
  });
});

describe('general limiters, keyBy "ip"', () => {
  test('users behind one address share its budget', async () => {
    const server = createApp({ publicApi: { limit: 2, keyBy: 'ip', windowMs: 60000 } });
    expect((await get(server, { user: 'alice' })).status).toBe(200);
    expect((await get(server, { user: 'bob' })).status).toBe(200);
    expect((await get(server, { user: 'carol' })).status).toBe(429);
  });
});

describe('sign-in limiter', () => {
  const app = () =>
    createApp({
      authApi: { limit: 2, perIpLimit: 5, windowMs: 900000, skipFailedRequests: false }
    });

  test('counts per address and username, the username normalised', async () => {
    const server = app();
    expect((await login(server, 'alice')).status).toBe(401);
    expect((await login(server, ' ALICE ')).status).toBe(401);
    expect((await login(server, 'alice')).status).toBe(429);
    // A colleague behind the same address still signs in.
    expect((await login(server, 'bob')).status).toBe(401);
    // The same name from another address has its own budget.
    expect((await login(server, 'alice', '10.0.0.2')).status).toBe(401);
  });

  test('caps one address across many usernames', async () => {
    const server = app();
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      expect((await login(server, name)).status).toBe(401);
    }
    expect((await login(server, 'f')).status).toBe(429);
    expect((await login(server, 'f', '10.0.0.2')).status).toBe(401);
  });
});
