// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Windows sign-in (NTLM) runs only on /api/auth/ntlm/login, so GET
 * /api/auth/status sends a signed-out browser there: always when NTLM is the
 * only way in, otherwise only when this browser signed in with Windows before.
 */
import { jest } from '@jest/globals';

let platform;
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
const { default: cookieParser } = await import('cookie-parser');
const { default: request } = await import('supertest');
const { default: registerAuthRoutes } = await import('../routes/auth.js');

function buildApp(user) {
  const app = express();
  app.use(cookieParser());
  app.use((req, res, next) => {
    if (user) req.user = user;
    next();
  });
  registerAuthRoutes(app);
  return app;
}

const NTLM_REDIRECT = { provider: 'ntlm', url: '/api/auth/ntlm/login' };

beforeEach(() => {
  platform = { auth: { mode: 'local' }, ntlmAuth: { enabled: true, domain: 'MUC' } };
});

test('sends a signed-out browser to the Windows sign-in when NTLM is the only way in', async () => {
  const res = await request(buildApp()).get('/api/auth/status');
  expect(res.body.autoRedirect).toEqual(NTLM_REDIRECT);
});

test('does not redirect a signed-in user', async () => {
  const res = await request(buildApp({ id: 'jane', groups: [] })).get('/api/auth/status');
  expect(res.body.autoRedirect).toBeNull();
});

test('with other sign-in methods, redirects only a browser that chose Windows before', async () => {
  platform.localAuth = { enabled: true };
  const app = buildApp();
  expect((await request(app).get('/api/auth/status')).body.autoRedirect).toBeNull();
  const chosen = await request(app).get('/api/auth/status').set('Cookie', 'ntlmRequested=1');
  expect(chosen.body.autoRedirect).toEqual(NTLM_REDIRECT);
});

test('does not redirect when anonymous access is on', async () => {
  platform.anonymousAuth = { enabled: true };
  const res = await request(buildApp()).get('/api/auth/status');
  expect(res.body.autoRedirect).toBeNull();
});
