// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Optional `If-Match` on admin config writes (decision 6, CU-B3).
 *
 * GET /api/admin/configs/platform and GET /api/admin/ui/config answer with a
 * strong `ETag`: a keyed HMAC of the STORED file (for the UI, without the
 * `pages` registry its save never writes), so an edit on disk or by another
 * worker changes it, and a change of a secret alone changes it although the
 * redacted body does not. A write that sends a stale `If-Match` is refused with
 * 412 `PRECONDITION_FAILED` and leaves the file untouched; a write without the
 * header behaves as before; a successful write answers with the new `ETag`.
 *
 * CU-B3: `POST /api/admin/ui/config` never deletes a content page the pages
 * routes created, with or without `If-Match`.
 *
 * Real ConfigStore and adminAuth on a temporary contents directory.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const state = { rootDir: null };

jest.unstable_mockModule('../pathUtils.js', () => ({
  getRootDir: () => state.rootDir
}));

jest.unstable_mockModule('../storage/bootstrap.js', () => ({
  getStorage: () => null
}));

// The cache is the file, unless a test sets `state.staleUI` to model a cache
// that has not seen another worker's write yet.
jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    refreshCacheEntry: async () => {},
    getPlatform: () => ({}),
    getUI: () => {
      if (state.staleUI) return { data: structuredClone(state.staleUI) };
      const text = state.uiText();
      return text ? { data: JSON.parse(text) } : null;
    }
  }
}));

jest.unstable_mockModule('../middleware/oidcAuth.js', () => ({
  reconfigureOidcProviders: () => {}
}));

jest.unstable_mockModule('../services/TokenStorageService.js', () => ({
  default: {
    isEncrypted: () => false,
    encryptString: v => v,
    decryptString: v => v
  }
}));

jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: async () => {}
}));

jest.unstable_mockModule('../services/ChangeHistoryService.js', () => ({
  saveSnapshot: async () => {}
}));

const { readFileSync } = await import('fs');
const { default: registerAdminConfigRoutes } = await import('../routes/admin/configs.js');
const { default: registerAdminUIRoutes } = await import('../routes/admin/ui.js');
const { default: registerAdminPagesRoutes } = await import('../routes/admin/pages.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const LOCAL_ADMIN = {
  id: 'user_local',
  username: 'admin',
  groups: ['admins'],
  authMode: 'local',
  isAdmin: true
};

const PLATFORM = {
  defaultLanguage: 'en',
  auth: { mode: 'local', jwtSecret: 'first-secret' },
  anonymousAuth: { enabled: false },
  localAuth: { enabled: true },
  oidcAuth: { enabled: false, providers: [] },
  proxyAuth: { enabled: false, jwtProviders: [] }
};

const UI = {
  title: { en: 'iHub' },
  header: { links: [] },
  footer: { enabled: false },
  disclaimer: { enabled: false },
  pages: {
    faq: { title: { en: 'FAQ' }, filePath: { en: 'pages/en/faq.md' }, contentType: 'markdown' }
  }
};

const GROUPS = {
  groups: { admins: { id: 'admins', name: 'Admins', permissions: { adminAccess: true } } }
};
const USERS = {
  users: {
    user_local: {
      id: 'user_local',
      username: 'admin',
      active: true,
      authMethods: ['local'],
      passwordHash: 'hash',
      internalGroups: ['admins']
    }
  }
};

const file = name => path.join(state.rootDir, 'contents', 'config', name);
const writeConfig = (name, data) => fs.writeFile(file(name), JSON.stringify(data, null, 2));
const readText = name => fs.readFile(file(name), 'utf8');
state.uiText = () => {
  try {
    return readFileSync(file('ui.json'), 'utf8');
  } catch {
    return null;
  }
};

function appFor(user = LOCAL_ADMIN) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  registerAdminConfigRoutes(app);
  registerAdminUIRoutes(app);
  registerAdminPagesRoutes(app);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  state.staleUI = null;
  state.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-if-match-'));
  await fs.mkdir(path.join(state.rootDir, 'contents', 'config'), { recursive: true });
  await writeConfig('platform.json', PLATFORM);
  await writeConfig('ui.json', UI);
  await writeConfig('groups.json', GROUPS);
  await writeConfig('users.json', USERS);
});

afterEach(async () => {
  await fs.rm(state.rootDir, { recursive: true, force: true });
});

describe('platform config: ETag and optional If-Match', () => {
  const getPlatform = app => request(app).get('/api/admin/configs/platform');
  const savePlatform = (app, body, ifMatch) => {
    const call = request(app).post('/api/admin/configs/platform');
    if (ifMatch !== undefined) call.set('If-Match', ifMatch);
    return call.send(body);
  };

  test('the read carries a strong ETag and is not cacheable', async () => {
    const response = await getPlatform(appFor());

    expect(response.status).toBe(200);
    expect(response.headers.etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  test('a fresh If-Match is applied and answered with the new ETag', async () => {
    const app = appFor();
    const read = await getPlatform(app);

    const saved = await savePlatform(app, { defaultLanguage: 'de' }, read.headers.etag);

    expect(saved.status).toBe(200);
    expect(saved.headers.etag).toBeDefined();
    expect(saved.headers.etag).not.toBe(read.headers.etag);
    expect(saved.headers.etag).toBe((await getPlatform(app)).headers.etag);
    expect(JSON.parse(await readText('platform.json')).defaultLanguage).toBe('de');
  });

  test('a stale If-Match is 412 PRECONDITION_FAILED and leaves the file untouched', async () => {
    const app = appFor();
    const stale = (await getPlatform(app)).headers.etag;
    await savePlatform(app, { defaultLanguage: 'fr' }).expect(200);
    const before = await readText('platform.json');

    const response = await savePlatform(app, { defaultLanguage: 'de' }, stale);

    expect(response.status).toBe(412);
    expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(response.body.code).toBe('PRECONDITION_FAILED');
    expect(response.body.details).toEqual({ resource: 'platform' });
    expect(await readText('platform.json')).toBe(before);
  });

  test('an edit of the file on disk makes the earlier ETag stale', async () => {
    const app = appFor();
    const etag = (await getPlatform(app)).headers.etag;
    await writeConfig('platform.json', { ...PLATFORM, defaultLanguage: 'it' });

    const response = await savePlatform(app, { defaultLanguage: 'de' }, etag);

    expect(response.status).toBe(412);
    expect(JSON.parse(await readText('platform.json')).defaultLanguage).toBe('it');
  });

  test('without If-Match the write is applied as before', async () => {
    const app = appFor();
    await getPlatform(app);
    await writeConfig('platform.json', { ...PLATFORM, defaultLanguage: 'it' });

    await savePlatform(app, { defaultLanguage: 'de' }).expect(200);

    expect(JSON.parse(await readText('platform.json')).defaultLanguage).toBe('de');
  });

  test('If-Match: * is applied when the file exists', async () => {
    await savePlatform(appFor(), { defaultLanguage: 'de' }, '*').expect(200);
    expect(JSON.parse(await readText('platform.json')).defaultLanguage).toBe('de');
  });

  test('a weak tag never matches (strong comparison)', async () => {
    const app = appFor();
    const etag = (await getPlatform(app)).headers.etag;
    await savePlatform(app, { defaultLanguage: 'de' }, `W/${etag}`).expect(412);
  });

  test('the revision changes when only a secret changed, although the read looks the same', async () => {
    const app = appFor();
    const first = await getPlatform(app);
    await writeConfig('platform.json', {
      ...PLATFORM,
      auth: { mode: 'local', jwtSecret: 'second-secret' }
    });
    const second = await getPlatform(app);

    expect(second.body).toEqual(first.body);
    expect(second.headers.etag).not.toBe(first.headers.etag);
  });

  test('two writers holding the same ETag: the second gets 412', async () => {
    const app = appFor();
    const etag = (await getPlatform(app)).headers.etag;

    const [a, b] = await Promise.all([
      savePlatform(app, { defaultLanguage: 'de' }, etag),
      savePlatform(app, { defaultLanguage: 'fr' }, etag)
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 412]);
  });
});

describe('UI config: ETag, optional If-Match and pages (CU-B3)', () => {
  const getUI = app => request(app).get('/api/admin/ui/config');
  const saveUI = (app, config, ifMatch) => {
    const call = request(app).post('/api/admin/ui/config');
    if (ifMatch !== undefined) call.set('If-Match', ifMatch);
    return call.send({ config });
  };
  const createPage = app =>
    request(app)
      .post('/api/admin/pages')
      .send({ id: 'news', title: { en: 'News' }, content: { en: '# News' } })
      .expect(201);

  test('the read carries an ETag; a fresh save answers 204 with the new one', async () => {
    const app = appFor();
    const read = await getUI(app);
    expect(read.headers.etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(read.headers['cache-control']).toBe('no-store');

    const saved = await saveUI(app, { ...read.body, title: { en: 'Hub' } }, read.headers.etag);

    expect(saved.status).toBe(204);
    expect(saved.headers.etag).toBe((await getUI(app)).headers.etag);
  });

  test('two-writer scenario: a page created after the UI form loaded survives its save (no If-Match)', async () => {
    const app = appFor();
    const formCopy = (await getUI(app)).body;
    await createPage(app);

    await saveUI(app, { ...formCopy, title: { en: 'Hub' } }).expect(204);

    const stored = JSON.parse(await readText('ui.json'));
    expect(stored.title).toEqual({ en: 'Hub' });
    expect(Object.keys(stored.pages).sort()).toEqual(['faq', 'news']);
  });

  test('two-writer scenario with If-Match: a page created meanwhile does not make the save stale (R5)', async () => {
    const app = appFor();
    const read = await getUI(app);
    await createPage(app);

    const response = await saveUI(app, { ...read.body, title: { en: 'Hub' } }, read.headers.etag);

    expect(response.status).toBe(204);
    const stored = JSON.parse(await readText('ui.json'));
    expect(stored.title).toEqual({ en: 'Hub' });
    expect(Object.keys(stored.pages).sort()).toEqual(['faq', 'news']);
  });

  test('a change the form can write (the disclaimer) still makes the save 412', async () => {
    const app = appFor();
    const read = await getUI(app);
    await request(app)
      .put('/api/admin/ui/disclaimer')
      .send({ enabled: true, text: { en: 'Hi' } })
      .expect(200);
    const before = await readText('ui.json');

    const response = await saveUI(app, { ...read.body, title: { en: 'Hub' } }, read.headers.etag);

    expect(response.status).toBe(412);
    expect(response.body.code).toBe('PRECONDITION_FAILED');
    expect(response.body.details).toEqual({ resource: 'ui' });
    expect(await readText('ui.json')).toBe(before);
  });

  test('the read serves body and ETag from the stored file, never a lagging cache (R4)', async () => {
    const app = appFor();
    // Another worker saved a new title; this worker's cache still has the old one.
    state.staleUI = structuredClone(UI);
    await writeConfig('ui.json', { ...UI, title: { en: 'Saved elsewhere' } });

    const read = await getUI(app);

    expect(read.body.title).toEqual({ en: 'Saved elsewhere' });
    const saved = await saveUI(app, { ...read.body, footer: { enabled: true } }, read.headers.etag);
    expect(saved.status).toBe(204);
    expect(JSON.parse(await readText('ui.json')).title).toEqual({ en: 'Saved elsewhere' });
  });

  test('a save cannot add, change or remove pages; the stored registry is kept', async () => {
    const app = appFor();
    const read = await getUI(app);

    await saveUI(app, { ...read.body, pages: { injected: { title: { en: 'X' } } } }).expect(204);

    expect(JSON.parse(await readText('ui.json')).pages).toEqual(UI.pages);
  });
});
