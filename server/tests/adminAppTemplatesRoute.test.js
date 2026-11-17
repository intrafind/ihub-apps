// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `GET /api/admin/apps/templates` feeds the "Choose App Template" dialog of
 * Create App (AI-B4). It lists every enabled app: the schema defaults
 * `allowInheritance` to `false` and no admin screen sets it, so filtering on it
 * returned an empty list on every installation.
 *
 * Native ESM: run with `node --experimental-vm-modules` (the test scripts do).
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

let apps = [];

jest.unstable_mockModule('../middleware/contentAdminAuth.js', () => ({
  contentAdminAuth: (req, res, next) => next()
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getApps: () => ({ data: apps, etag: 'a' }),
    refreshAppsCache: async () => {}
  }
}));

const { default: registerAdminAppsRoutes } = await import('../routes/admin/apps.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
registerAdminAppsRoutes(app);
app.use(errorHandler);

describe('GET /api/admin/apps/templates', () => {
  test('lists every enabled app, whatever allowInheritance says', async () => {
    apps = [
      { id: 'chat', enabled: true, allowInheritance: false },
      { id: 'translator', enabled: true },
      { id: 'summarizer', enabled: true, allowInheritance: true },
      { id: 'retired', enabled: false, allowInheritance: true }
    ];

    const res = await request(app).get('/api/admin/apps/templates').expect(200);

    expect(res.body.items.map(item => item.id)).toEqual(['chat', 'translator', 'summarizer']);
  });

  test('answers an empty list when no app is enabled', async () => {
    apps = [{ id: 'retired', enabled: false }];

    const res = await request(app).get('/api/admin/apps/templates').expect(200);

    expect(res.body).toEqual({ items: [] });
  });
});
