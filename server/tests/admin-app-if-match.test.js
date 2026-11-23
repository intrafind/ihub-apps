// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Optional `If-Match` on admin app saves (issue #3898, slice 1).
 *
 * GET /api/admin/apps/{appId} answers with the revision of the stored app file
 * as `ETag` (utils/configRevision.js, the revision the group and platform saves
 * use). PUT /api/admin/apps/{appId}:
 *   - with an `If-Match` that names the stored revision: saved, and the
 *     response carries the new `ETag`;
 *   - with a stale `If-Match`: 412 `PRECONDITION_FAILED`, nothing written;
 *   - without `If-Match`: saved as before (the last save wins).
 *
 * The conversation's "Apply" saves through this route with `If-Match`, so a
 * change from the model never overwrites a save another admin made meanwhile.
 *
 * Real ConfigStore on a temporary contents directory. Native-ESM jest.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// A root before the first test: modules read it while they load.
const state = { rootDir: os.tmpdir(), apps: [] };

jest.unstable_mockModule('../pathUtils.js', () => ({
  getRootDir: () => state.rootDir
}));

jest.unstable_mockModule('../storage/bootstrap.js', () => ({
  getStorage: () => null
}));

/** The cache answers with the apps as the files hold them, like a refreshed cache. */
jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => ({}),
    get: () => null,
    getApps: () => ({ data: state.apps, etag: 'apps-etag' }),
    getGroups: () => null,
    refreshAppsCache: async () => {
      state.apps = [JSON.parse(await fs.readFile(appFile('helper'), 'utf8'))];
    },
    refreshCacheEntry: async () => {},
    setCacheEntry: () => undefined
  }
}));

const snapshots = [];
jest.unstable_mockModule('../services/AuditLogService.js', () => ({ logAudit: async () => {} }));
jest.unstable_mockModule('../services/ChangeHistoryService.js', () => ({
  saveSnapshot: async snapshot => snapshots.push(snapshot)
}));

const { default: registerAdminAppsRoutes } = await import('../routes/admin/apps.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const ADMIN = {
  id: 'a',
  username: 'a',
  groups: ['admins'],
  authMode: 'local',
  isAdmin: true,
  isContentAdmin: true
};

const APP = {
  id: 'helper',
  name: { en: 'Helper' },
  description: { en: 'Helps.' },
  color: '#4F46E5',
  icon: 'users',
  system: { en: 'You help.' },
  enabled: false
};

function appFile(id) {
  return path.join(state.rootDir, 'contents', 'apps', `${id}.json`);
}
const readText = () => fs.readFile(appFile('helper'), 'utf8');

function server() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { ...ADMIN, permissions: { adminAccess: true } };
    next();
  });
  registerAdminAppsRoutes(app);
  app.use(errorHandler);
  return app;
}

const get = () => request(server()).get('/api/admin/apps/helper');
const put = (body, ifMatch) => {
  const req = request(server()).put('/api/admin/apps/helper');
  if (ifMatch !== undefined) req.set('If-Match', ifMatch);
  return req.send(body);
};
const withSystem = text => ({ ...APP, system: { en: text } });

beforeEach(async () => {
  state.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-app-if-match-'));
  await fs.mkdir(path.join(state.rootDir, 'contents', 'apps'), { recursive: true });
  await fs.writeFile(appFile('helper'), JSON.stringify(APP, null, 2));
  state.apps = [APP];
  snapshots.length = 0;
});

afterEach(async () => {
  await fs.rm(state.rootDir, { recursive: true, force: true });
});

describe('GET /api/admin/apps/{appId}', () => {
  test('answers the revision of the stored app file as a strong ETag', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('helper');
    expect(res.headers.etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('the ETag changes when the app changes, and only then', async () => {
    const before = (await get()).headers.etag;
    expect((await get()).headers.etag).toBe(before);
    await put(withSystem('You help a lot.'));
    expect((await get()).headers.etag).not.toBe(before);
  });
});

describe('PUT /api/admin/apps/{appId} with If-Match', () => {
  test('a matching If-Match saves and answers the new ETag', async () => {
    const etag = (await get()).headers.etag;

    const res = await put(withSystem('You help formally.'), etag);

    expect(res.status).toBe(200);
    expect(res.body.system).toEqual({ en: 'You help formally.' });
    expect(JSON.parse(await readText()).system).toEqual({ en: 'You help formally.' });
    const after = (await get()).headers.etag;
    expect(res.headers.etag).toBe(after);
    expect(after).not.toBe(etag);
    // A history snapshot is written as on every save.
    expect(snapshots).toHaveLength(1);

    // The new ETag is good for the next save.
    expect((await put(withSystem('You help briefly.'), res.headers.etag)).status).toBe(200);
  });

  test('a stale If-Match is 412 PRECONDITION_FAILED and writes nothing', async () => {
    const etag = (await get()).headers.etag;
    // Another admin saves in between.
    expect((await put(withSystem('Saved elsewhere.'))).status).toBe(200);
    const stored = await readText();
    snapshots.length = 0;

    const res = await put(withSystem('From the conversation.'), etag);

    expect(res.status).toBe(412);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('PRECONDITION_FAILED');
    expect(res.body.details).toEqual({ resource: 'app' });
    expect(await readText()).toBe(stored);
    expect(snapshots).toHaveLength(0);
  });

  test('without If-Match the save behaves as before', async () => {
    await put(withSystem('Saved elsewhere.'));

    const res = await put(withSystem('Last one wins.'));

    expect(res.status).toBe(200);
    expect(res.headers.etag).toMatch(/^"/);
    expect(JSON.parse(await readText()).system).toEqual({ en: 'Last one wins.' });
  });

  test('a weak tag from a proxy counts as its strong value', async () => {
    const etag = (await get()).headers.etag;
    expect((await put(withSystem('Through a proxy.'), `W/${etag}`)).status).toBe(200);
  });

  test('an invalid body is refused before the revision is compared', async () => {
    const res = await put({ ...APP, color: 'red' }, '"stale"');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });
});

describe('GET /api/admin/apps/{appId} while the cache lags behind', () => {
  test('answers the stored body with its revision, not a stale cached body', async () => {
    const etag = (await get()).headers.etag;
    // Another worker saved: the file is new, this worker's cache still holds the old app.
    await fs.writeFile(appFile('helper'), JSON.stringify(withSystem('Saved elsewhere.'), null, 2));
    expect(state.apps[0].system).toEqual({ en: 'You help.' });

    const res = await get();

    expect(res.body.system).toEqual({ en: 'Saved elsewhere.' });
    expect(res.headers.etag).not.toBe(etag);
    // The ETag is what the next PUT compares against: a save built on this body goes
    // through, one built on the old body is refused.
    expect((await put(withSystem('Built on the stale body.'), etag)).status).toBe(412);
    expect((await put(withSystem('Built on the new body.'), res.headers.etag)).status).toBe(200);
  });

  test('answers the body in the shape of the cache: schema defaults applied', async () => {
    const res = await get();
    expect(res.body.enabled).toBe(false);
    // Keys the schema adds by default are there although the file does not hold them.
    expect(Object.keys(res.body).length).toBeGreaterThan(Object.keys(APP).length);
  });

  test('answers 404 for an app with no stored file', async () => {
    const res = await request(server()).get('/api/admin/apps/missing');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/admin/apps/{appId}/_toggle', () => {
  const toggle = (enabled, ifMatch, ids = 'helper') => {
    const req = request(server()).post(`/api/admin/apps/${ids}/_toggle`);
    if (ifMatch !== undefined) req.set('If-Match', ifMatch);
    return req.send({ enabled });
  };

  test('answers the new revision of one app: the next save with it goes through', async () => {
    const etag = (await get()).headers.etag;

    const res = await toggle(true, etag);

    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe((await get()).headers.etag);
    expect(res.headers.etag).not.toBe(etag);
    expect((await put(withSystem('Saved after publishing.'), res.headers.etag)).status).toBe(200);
  });

  test('changes only the flag of the stored file', async () => {
    expect((await toggle(true)).status).toBe(200);
    expect(JSON.parse(await readText())).toEqual({ ...APP, enabled: true });
  });

  test('a stale If-Match is 412 and writes nothing', async () => {
    const etag = (await get()).headers.etag;
    await put(withSystem('Saved elsewhere.'));
    const stored = await readText();

    const res = await toggle(true, etag);

    expect(res.status).toBe(412);
    expect(res.body.code).toBe('PRECONDITION_FAILED');
    expect(await readText()).toBe(stored);
  });

  test('refuses If-Match for several apps', async () => {
    const res = await toggle(true, '"x"', 'helper,other');
    expect(res.status).toBe(400);
  });
});
