// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A cold load of an in-app documentation link (`/admin/docs/<page>.md`) must get the SPA even
 * when the browser sends a session cookie the auth chain rejects. Like every other SPA route,
 * the doc pages skip the auth chain (`isStaticAssetRequest` in middleware/setup.js); before the
 * fix the `.md` extension made them look like files, so `jwtAuth` answered with a JSON 401 before
 * the SPA handler ran.
 *
 * Built from the real `setupMiddleware` + `registerStaticRoutes`, in production order.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

const { default: configCache } = await import('../configCache.js');
const { setupMiddleware } = await import('../middleware/setup.js');
const { default: registerStaticRoutes } = await import('../routes/staticRoutes.js');
const { basePathDetectionMiddleware } = await import('../utils/basePath.js');
const { signAppJwt } = await import('../utils/tokenService.js');

const SECRET = 'a-test-secret-that-is-long-enough-for-hs256-signing';
const INDEX_MARKER = '<div id="root"></div>';

const PLATFORM = {
  jwt: { algorithm: 'HS256' },
  auth: { mode: 'local', jwtSecret: SECRET, sessionTimeoutMinutes: 60 },
  localAuth: { enabled: true },
  anonymousAuth: { enabled: false, defaultGroups: [] },
  // OAuth clients are off, so a signed client-credentials token is refused with 401.
  oauth: { enabled: { clients: false } }
};

let rootDir;
let savedPlatform;

beforeAll(() => {
  savedPlatform = configCache.cache.get('config/platform.json');
  configCache.cache.set('config/platform.json', { data: PLATFORM });
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-static-auth-'));
  fs.mkdirSync(path.join(rootDir, 'public'), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, 'public', 'index.html'),
    `<!doctype html><html><head><title>iHub</title></head><body>${INDEX_MARKER}</body></html>`
  );
});

afterAll(() => {
  if (savedPlatform === undefined) configCache.cache.delete('config/platform.json');
  else configCache.cache.set('config/platform.json', savedPlatform);
  fs.rmSync(rootDir, { recursive: true, force: true });
});

function buildApp(platformConfig = PLATFORM) {
  const app = express();
  setupMiddleware(app, platformConfig);
  app.use(basePathDetectionMiddleware);
  // Stands in for the API routes: proves the cookie really is refused by the auth chain.
  app.get('/api/probe', (req, res) => res.json({ user: req.user?.id || null }));
  registerStaticRoutes(app, { isPackaged: true, rootDir, basePath: '' });
  return app;
}

/** A correctly signed token the auth chain refuses (OAuth clients are disabled). */
function rejectedCookie() {
  const token = signAppJwt(
    { sub: 'gone-client', client_id: 'gone-client', authMode: 'oauth_client_credentials' },
    { expiresInSeconds: 600 }
  );
  return `authToken=${token}`;
}

describe('cold load of /admin/docs/<page>.md with a rejected session cookie', () => {
  test('the auth chain refuses the cookie on an API route', async () => {
    const res = await request(buildApp()).get('/api/probe').set('Cookie', rejectedCookie());
    expect(res.status).toBe(401);
  });

  test('a doc page still gets the SPA', async () => {
    const res = await request(buildApp())
      .get('/admin/docs/integrations.md')
      .set('Cookie', rejectedCookie());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain(INDEX_MARKER);
  });

  test('a nested doc page under a forwarded base path still gets the SPA', async () => {
    const res = await request(buildApp())
      .get('/ihub/admin/docs/releases/next/features.md')
      .set('X-Forwarded-Prefix', '/ihub')
      .set('Cookie', rejectedCookie());
    expect(res.status).toBe(200);
    expect(res.text).toContain(INDEX_MARKER);
  });

  test('the extension-less docs route behaves the same', async () => {
    const res = await request(buildApp()).get('/admin/docs').set('Cookie', rejectedCookie());
    expect(res.status).toBe(200);
    expect(res.text).toContain(INDEX_MARKER);
  });

  test('another extension under /admin/docs is not treated as a doc page', async () => {
    const res = await request(buildApp())
      .get('/admin/docs/diagram.png')
      .set('Cookie', rejectedCookie());
    expect(res.status).toBe(404);
  });
});
