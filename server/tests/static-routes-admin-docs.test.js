// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Cold loads of in-app documentation links (`/admin/docs/<page>.md`) get the SPA, at the
 * root and under a base path, while a missing asset with any other extension still 404s.
 * Before the fix every `.md` doc URL answered "File not found" on reload (SH-B1).
 *
 * The repo's source is native ESM, so this file uses `jest.unstable_mockModule` + dynamic
 * imports. Run with `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));
jest.unstable_mockModule('../configCache.js', () => ({
  default: { getUI: () => ({ data: {} }) }
}));

const { default: registerStaticRoutes, isAdminDocsPagePath } =
  await import('../routes/staticRoutes.js');
const { basePathRewriteMiddleware, basePathDetectionMiddleware } =
  await import('../utils/basePath.js');
const { runWithContext } = await import('../utils/requestContext.js');

const INDEX_MARKER = '<div id="root"></div>';

let rootDir;

beforeAll(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-static-'));
  fs.mkdirSync(path.join(rootDir, 'public', 'assets'), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, 'public', 'index.html'),
    `<!doctype html><html><head><title>iHub</title></head><body>${INDEX_MARKER}</body></html>`
  );
});

afterAll(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

/** The production middleware order that matters here: context, prefix rewrite, detection. */
function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use((req, res, next) => runWithContext({}, next));
  app.use(basePathRewriteMiddleware);
  app.use(basePathDetectionMiddleware);
  registerStaticRoutes(app, { isPackaged: true, rootDir, basePath: '' });
  return app;
}

describe('cold load of /admin/docs/<page>.md', () => {
  const app = () => buildApp();

  test('serves the SPA at the root', async () => {
    const res = await request(app()).get('/admin/docs/oidc-authentication.md');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain(INDEX_MARKER);
  });

  test('serves the SPA for a nested doc page', async () => {
    const res = await request(app()).get('/admin/docs/releases/next/features.md');
    expect(res.status).toBe(200);
    expect(res.text).toContain(INDEX_MARKER);
  });

  test('serves the SPA under a base path (non-stripping proxy)', async () => {
    const res = await request(app())
      .get('/ihub/admin/docs/oidc-authentication.md')
      .set('X-Forwarded-Prefix', '/ihub');
    expect(res.status).toBe(200);
    expect(res.text).toContain(INDEX_MARKER);
    // The base path is injected so the client resolves its API under /ihub.
    expect(res.text).toContain('/ihub');
  });

  test('serves the SPA under a base path (stripping proxy)', async () => {
    const res = await request(app())
      .get('/admin/docs/oidc-authentication.md')
      .set('X-Forwarded-Prefix', '/ihub');
    expect(res.status).toBe(200);
    expect(res.text).toContain(INDEX_MARKER);
  });
});

describe('missing assets still 404', () => {
  test.each([
    ['/assets/missing.js', {}],
    ['/admin/docs/missing.js', {}],
    ['/admin/docs/image.png', {}],
    ['/notes.md', {}],
    ['/ihub/assets/missing.js', { 'X-Forwarded-Prefix': '/ihub' }]
  ])('%s', async (url, headers) => {
    const res = await request(buildApp()).get(url).set(headers);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain(INDEX_MARKER);
  });
});

describe('isAdminDocsPagePath', () => {
  test.each([
    ['/admin/docs/oidc-authentication.md', true],
    ['/admin/docs/releases/next/fixes.md', true],
    ['/admin/docs/README.MD', true],
    ['/admin/docs/', false],
    ['/admin/docs/x.js', false],
    ['/admin/x.md', false],
    ['/docs/x.md', false]
  ])('%s → %p', (p, expected) => {
    expect(isAdminDocsPagePath(p)).toBe(expected);
  });
});
