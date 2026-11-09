/**
 * @jest-environment node
 */
// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The changelog route answers an unknown or empty release with NOT_FOUND
 * through the global error middleware (RFC 9457 problem+json).
 */
import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../../../server/utils/logger.js', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));
jest.mock('../../../server/pathUtils.js', () => ({
  getRootDir: () => '/nonexistent-root'
}));
jest.mock('../../../server/middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));
jest.mock('../../../server/utils/versionHelper.js', () => ({
  getAppVersion: () => 'v5.5.7'
}));

import registerAdminChangelogRoutes from '../../../server/routes/admin/changelog.js';
import errorHandler from '../../../server/middleware/errorHandler.js';

let releasesDir;
let app;

beforeAll(() => {
  releasesDir = mkdtempSync(path.join(os.tmpdir(), 'ihub-releases-err-'));
  mkdirSync(path.join(releasesDir, '5.5.7'), { recursive: true });
  writeFileSync(path.join(releasesDir, '5.5.7', 'features.md'), '# Features\n\n## One\n\nbody\n');
  // A release directory with headings only: no entries, so not found.
  mkdirSync(path.join(releasesDir, '5.5.8'), { recursive: true });
  writeFileSync(path.join(releasesDir, '5.5.8', 'features.md'), '# Features\n');

  app = express();
  registerAdminChangelogRoutes(app, { releasesDir });
  app.use(errorHandler);
});

afterAll(() => {
  rmSync(releasesDir, { recursive: true, force: true });
});

describe('GET /api/admin/changelog/:version: errors', () => {
  test.each(['9.9.9', '5.5.8', 'README.md', '..%2F..%2Fetc', 'next%2F..%2F5.5.7'])(
    'answers NOT_FOUND as problem+json for %s',
    async name => {
      const res = await request(app).get(`/api/admin/changelog/${name}`);
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body.code).toBe('NOT_FOUND');
      expect(res.body.detail).toBe('Release not found');
    }
  );

  test('still serves an existing release', async () => {
    await request(app).get('/api/admin/changelog/5.5.7').expect(200);
  });
});
