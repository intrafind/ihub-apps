// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The sign-in limiter with the shipped settings (server/defaults/config/platform.json):
 *
 * - the per-address ceiling (`perIpLimit`) counts failed sign-ins only, so one
 *   address spraying passwords over random usernames is stopped after a few
 *   hundred attempts, while a sign-in wave behind one NAT address is not;
 * - requests without a username (NTLM handshakes, Teams token exchange) skip
 *   the per-account counter, so they do not all share one bucket per address;
 *   NTLM's 401 challenges are not failed sign-ins.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import express from 'express';
import { createRateLimiters } from '../middleware/rateLimiting.js';

const shipped = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'defaults/config/platform.json'),
    'utf8'
  )
);

/** Local sign-in succeeds for usernames starting with `ok-`. */
function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/auth', createRateLimiters({ rateLimit: shipped.rateLimit }).authApiLimiter);
  app.post('/api/auth/local/login', (req, res) =>
    req.body.username.startsWith('ok-') ? res.json({}) : res.status(401).json({})
  );
  // express-ntlm: first request is challenged, the one with credentials succeeds.
  app.post('/api/auth/ntlm/login', (req, res) => {
    if (req.get('authorization')) return res.json({});
    res.status(401).set('WWW-Authenticate', 'NTLM').end();
  });
  app.post('/api/auth/teams/exchange', (req, res) => res.json({}));
  return app;
}

const post = (app, url, body = {}, ip = '10.0.0.1') =>
  request(app).post(url).set('X-Forwarded-For', ip).send(body);

test('ships a per-address ceiling of a few hundred', () => {
  expect(shipped.rateLimit.authApi.perIpLimit).toBeLessThanOrEqual(500);
});

test('random-username sign-ins from one address get 429 well before 5,000', async () => {
  const app = createApp();
  const limit = shipped.rateLimit.authApi.perIpLimit;
  let firstRefused = 0;
  for (let i = 1; i <= limit + 5 && !firstRefused; i++) {
    const res = await post(app, '/api/auth/local/login', { username: `spray-${i}` });
    if (res.status === 429) firstRefused = i;
  }
  expect(firstRefused).toBe(limit + 1);
  // Another address is not affected.
  expect((await post(app, '/api/auth/local/login', { username: 'x' }, '10.0.0.2')).status).toBe(
    401
  );
}, 60000);

test('a sign-in wave of successful logins behind one address is not limited', async () => {
  const app = createApp();
  const wave = shipped.rateLimit.authApi.perIpLimit * 2;
  for (let i = 0; i < wave; i++) {
    const res = await post(app, '/api/auth/local/login', { username: `ok-${i}` });
    expect(res.status).toBe(200);
  }
}, 60000);

test('NTLM handshakes and Teams exchanges are not limited by one shared account bucket', async () => {
  const app = createApp();
  const perAccount = shipped.rateLimit.authApi.limit;
  for (let i = 0; i < perAccount * 3; i++) {
    expect((await post(app, '/api/auth/ntlm/login')).status).toBe(401);
    const signedIn = await post(app, '/api/auth/ntlm/login').set('Authorization', 'NTLM x');
    expect(signedIn.status).toBe(200);
    expect((await post(app, '/api/auth/teams/exchange', { token: 't' })).status).toBe(200);
  }
}, 60000);
