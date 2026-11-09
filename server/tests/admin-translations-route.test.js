// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Admin translation overrides: list/search, set, reset.
 * Run with `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const base = { common: { save: 'Save', cancel: 'Cancel' }, chat: { 'a.b': 'Dotted' } };
let stored = null;
const refresh = jest.fn();

jest.unstable_mockModule('../configCache.js', () => ({
  default: { getSupportedLanguages: () => ['en', 'de'], refreshCacheEntry: refresh }
}));
jest.unstable_mockModule('../configLoader.js', () => ({
  loadBuiltinLocaleJson: async () => structuredClone(base)
}));
jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    readJson: async () => stored && structuredClone(stored),
    updateJson: async (_p, mutate) => {
      stored = await mutate(stored && structuredClone(stored));
      return { data: stored, written: true };
    }
  }
}));
jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  authRequired: (_q, _s, n) => n()
}));
jest.unstable_mockModule('../middleware/adminAuth.js', () => ({ adminAuth: (_q, _s, n) => n() }));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({ logAudit: jest.fn() }));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

const { default: register } = await import('../routes/admin/translations.js');
const app = express();
app.use(express.json());
register(app);

beforeEach(() => {
  stored = null;
  refresh.mockClear();
});

test('lists only changed keys by default, all when asked', async () => {
  let res = await request(app).get('/api/admin/translations/en');
  expect(res.body.items).toEqual([]);
  res = await request(app).get('/api/admin/translations/en?changedOnly=false&q=cancel');
  expect(res.body.items.map(e => e.key)).toEqual(['common.cancel']);
});

test('pages by cursor and ends with a null nextCursor', async () => {
  const all = await request(app).get('/api/admin/translations/en?changedOnly=false&limit=500');
  expect(all.body.nextCursor).toBeNull();
  const keys = [];
  let cursor;
  for (let guard = 0; guard < 50; guard += 1) {
    const url = `/api/admin/translations/en?changedOnly=false&limit=1${cursor ? `&cursor=${cursor}` : ''}`;
    const res = await request(app).get(url);
    expect(res.body.items.length).toBeLessThanOrEqual(1);
    keys.push(...res.body.items.map(e => e.key));
    cursor = res.body.nextCursor;
    if (!cursor) break;
  }
  expect(keys).toEqual(all.body.items.map(e => e.key));
});

test('sets an override, keeps other keys, and lists it as changed', async () => {
  const put = await request(app)
    .put('/api/admin/translations/en')
    .send({ path: ['common', 'save'], value: 'Store' });
  expect(put.status).toBe(204);
  expect(stored).toEqual({ common: { save: 'Store' } });
  expect(refresh).toHaveBeenCalledWith('locales/en.json');
  const res = await request(app).get('/api/admin/translations/en');
  expect(res.body.items[0]).toMatchObject({
    key: 'common.save',
    base: 'Save',
    override: 'Store'
  });
});

test('handles keys containing dots via path segments', async () => {
  await request(app)
    .put('/api/admin/translations/en')
    .send({ path: ['chat', 'a.b'], value: 'X' })
    .expect(204);
  expect(stored).toEqual({ chat: { 'a.b': 'X' } });
});

test('reset removes the key and prunes empty parents', async () => {
  stored = { common: { save: 'Store' } };
  await request(app)
    .put('/api/admin/translations/en')
    .send({ path: ['common', 'save'], value: null })
    .expect(204);
  expect(stored).toEqual({});
});

test('rejects unknown keys, bad values and unsupported languages', async () => {
  await request(app)
    .put('/api/admin/translations/en')
    .send({ path: ['nope', 'x'], value: 'v' })
    .expect(400);
  await request(app)
    .put('/api/admin/translations/en')
    .send({ path: ['__proto__', 'x'], value: 'v' })
    .expect(400);
  await request(app)
    .put('/api/admin/translations/en')
    .send({ path: ['common'], value: 'v' })
    .expect(400);
  await request(app)
    .put('/api/admin/translations/en')
    .send({ path: ['common', 'save'], value: 5 })
    .expect(400);
  await request(app).get('/api/admin/translations/fr').expect(404);
});
