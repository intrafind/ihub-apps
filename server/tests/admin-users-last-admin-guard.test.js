// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * User updates and deletes keep an administrator who can sign in (ID-B2), and
 * `active` is only ever stored as a boolean (ID-B3).
 *
 * - `PUT /api/admin/auth/users/:id` that leaves no usable administrator (active,
 *   sign-in method enabled, admin through a resolved group): 409 `LAST_ADMIN`.
 * - Deactivating or deleting your own account: 409 `SELF_LOCKOUT`.
 * - Deleting the last usable administrator: 403 `FORBIDDEN`, as before.
 * - The check runs on the body held under the users.json lock, so two admins
 *   demoting the last two administrators at once cannot both succeed.
 *
 * Real ConfigStore on a temporary contents directory, real adminAuth.
 * Native-ESM jest.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

// A root before the first test: modules read it while they load.
const state = { rootDir: os.tmpdir(), lastGoodGroups: null };

jest.unstable_mockModule('../pathUtils.js', () => ({
  getRootDir: () => state.rootDir
}));

jest.unstable_mockModule('../storage/bootstrap.js', () => ({
  getStorage: () => null
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => ({}),
    get: () => null,
    getGroups: () => (state.lastGoodGroups ? { data: state.lastGoodGroups } : null),
    refreshCacheEntry: async () => {},
    setCacheEntry: () => undefined
  }
}));

jest.unstable_mockModule('../services/AuditLogService.js', () => ({ logAudit: () => undefined }));
jest.unstable_mockModule('../services/userDeletion.js', () => ({ startUserCleanup: () => {} }));
jest.unstable_mockModule('../services/integrations/iFinderTokenProvider.js', () => ({
  deleteLoginTokens: async () => {}
}));

const { default: registerAdminAuthRoutes } = await import('../routes/admin/auth.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const ADMIN_GROUPS = {
  groups: {
    admins: { id: 'admins', name: 'Admins', permissions: { adminAccess: true } },
    ops: { id: 'ops', name: 'Ops', inherits: ['admins'], permissions: { adminAccess: false } },
    users: { id: 'users', name: 'Users', permissions: { adminAccess: false } }
  }
};

const localAdmin = (id, extra = {}) => ({
  id,
  username: id,
  active: true,
  authMethods: ['local'],
  passwordHash: 'hash',
  internalGroups: ['admins'],
  ...extra
});

const file = name => path.join(state.rootDir, 'contents', 'config', name);
const writeConfig = (name, data) => fs.writeFile(file(name), JSON.stringify(data, null, 2));
const readUsers = async () => JSON.parse(await fs.readFile(file('users.json'), 'utf8'));

/** A signed-in local admin, as jwtAuth + enhanceUserWithPermissions leave it. */
const caller = id => ({ id, username: id, groups: ['admins'], authMode: 'local', isAdmin: true });

function appFor(user) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  registerAdminAuthRoutes(app);
  app.use(errorHandler);
  return app;
}

const put = (user, id, body) => request(appFor(user)).put(`/api/admin/auth/users/${id}`).send(body);
const del = (user, id) => request(appFor(user)).delete(`/api/admin/auth/users/${id}`);

async function seedUsers(users) {
  await writeConfig('users.json', { users, metadata: { version: '2.0.0' } });
}

beforeEach(async () => {
  state.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-last-admin-'));
  state.lastGoodGroups = null;
  await fs.mkdir(path.join(state.rootDir, 'contents', 'config'), { recursive: true });
  await writeConfig('groups.json', ADMIN_GROUPS);
  await writeConfig('platform.json', {
    localAuth: { enabled: true },
    oidcAuth: { enabled: false }
  });
});

afterEach(async () => {
  await fs.rm(state.rootDir, { recursive: true, force: true });
});

describe('PUT /api/admin/auth/users/:id last-admin guard', () => {
  test('removing the admin group from the only admin is LAST_ADMIN, nothing written', async () => {
    await seedUsers({ a: localAdmin('a'), b: localAdmin('b', { internalGroups: ['users'] }) });

    const res = await put(caller('b'), 'a', { internalGroups: ['users'] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LAST_ADMIN');
    expect((await readUsers()).users.a.internalGroups).toEqual(['admins']);
  });

  test('deactivating the only admin (by someone else) is LAST_ADMIN', async () => {
    await seedUsers({ a: localAdmin('a'), b: localAdmin('b', { internalGroups: ['users'] }) });

    const res = await put(caller('b'), 'a', { active: false });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LAST_ADMIN');
  });

  test('demoting one of two admins is allowed', async () => {
    await seedUsers({ a: localAdmin('a'), b: localAdmin('b') });

    const res = await put(caller('b'), 'a', { internalGroups: ['users'] });

    expect(res.status).toBe(200);
    expect((await readUsers()).users.a.internalGroups).toEqual(['users']);
  });

  test('demoting yourself is allowed while another usable admin remains', async () => {
    await seedUsers({ a: localAdmin('a'), b: localAdmin('b') });

    const res = await put(caller('a'), 'a', { internalGroups: ['users'] });

    expect(res.status).toBe(200);
  });

  test('demoting yourself as the only admin is LAST_ADMIN', async () => {
    await seedUsers({ a: localAdmin('a') });

    const res = await put(caller('a'), 'a', { internalGroups: [] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LAST_ADMIN');
  });

  test('deactivating yourself is SELF_LOCKOUT even while other admins exist', async () => {
    await seedUsers({ a: localAdmin('a'), b: localAdmin('b') });

    const res = await put(caller('a'), 'a', { active: false });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SELF_LOCKOUT');
    expect((await readUsers()).users.a.active).toBe(true);
  });

  test('an admin through an inherited group counts', async () => {
    await seedUsers({ a: localAdmin('a'), b: localAdmin('b', { internalGroups: ['ops'] }) });

    const res = await put(caller('b'), 'a', { internalGroups: ['users'] });

    expect(res.status).toBe(200);
  });

  test('an inactive admin does not count', async () => {
    await seedUsers({ a: localAdmin('a'), b: localAdmin('b', { active: false }) });

    const res = await put(caller('a'), 'a', { internalGroups: ['users'] });

    expect(res.status).toBe(409);
  });

  test('an admin whose only sign-in method is disabled does not count', async () => {
    await seedUsers({
      a: localAdmin('a'),
      b: { id: 'b', username: 'b', active: true, authMethods: ['oidc'], internalGroups: ['admins'] }
    });

    const res = await put(caller('a'), 'a', { internalGroups: ['users'] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LAST_ADMIN');
  });

  test('an edit that does not touch admin rights is not checked', async () => {
    await seedUsers({ a: localAdmin('a') });

    const res = await put(caller('a'), 'a', { email: 'a@example.com' });

    expect(res.status).toBe(200);
  });

  test('two parallel demotions of the last two admins: exactly one succeeds', async () => {
    await seedUsers({
      a: localAdmin('a'),
      b: localAdmin('b'),
      c: localAdmin('c', { internalGroups: ['users'] })
    });

    const responses = await Promise.all([
      put(caller('c'), 'a', { internalGroups: ['users'] }),
      put(caller('c'), 'b', { internalGroups: ['users'] })
    ]);

    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    const { users } = await readUsers();
    const admins = Object.values(users).filter(u => u.internalGroups.includes('admins'));
    expect(admins).toHaveLength(1);
  });

  test('an anonymous caller never reaches the guard (real adminAuth)', async () => {
    await seedUsers({ a: localAdmin('a') });

    const res = await put({ id: 'anonymous', groups: ['admins'] }, 'a', { active: false });

    expect(res.status).toBe(403);
    expect((await readUsers()).users.a.active).toBe(true);
  });
});

describe('DELETE /api/admin/auth/users/:id guards', () => {
  test('deleting yourself is SELF_LOCKOUT', async () => {
    await seedUsers({ a: localAdmin('a'), b: localAdmin('b') });

    const res = await del(caller('a'), 'a');

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SELF_LOCKOUT');
    expect((await readUsers()).users.a).toBeDefined();
  });

  test('deleting the last usable admin keeps its 403 FORBIDDEN', async () => {
    await seedUsers({
      a: localAdmin('a'),
      b: { id: 'b', username: 'b', active: true, authMethods: ['oidc'], internalGroups: ['admins'] }
    });

    // b is an admin whose method is off, so a is the last usable one.
    const res = await del(caller('b'), 'a');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect((await readUsers()).users.a).toBeDefined();
  });

  test('deleting one of two admins is allowed', async () => {
    await seedUsers({ a: localAdmin('a'), b: localAdmin('b') });

    const res = await del(caller('b'), 'a');

    expect(res.status).toBe(204);
  });

  test('two parallel deletes of the last two admins by a third: exactly one succeeds', async () => {
    await seedUsers({
      a: localAdmin('a'),
      b: localAdmin('b'),
      c: localAdmin('c', { internalGroups: ['users'] })
    });

    const responses = await Promise.all([del(caller('c'), 'a'), del(caller('c'), 'b')]);

    expect(responses.map(r => r.status).sort()).toEqual([204, 403]);
  });

  test('a groups.json that cannot be read refuses the delete with ADMIN_CHECK_FAILED', async () => {
    await seedUsers({ a: localAdmin('a'), b: localAdmin('b') });
    await fs.writeFile(file('groups.json'), '{ broken');

    const res = await del(caller('b'), 'a');

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('ADMIN_CHECK_FAILED');
    expect((await readUsers()).users.a).toBeDefined();
  });

  test('an anonymous caller never reaches the guard (real adminAuth)', async () => {
    await seedUsers({ a: localAdmin('a'), b: localAdmin('b') });

    const res = await del({ id: 'anonymous', groups: ['admins'] }, 'a');

    expect(res.status).toBe(403);
    expect((await readUsers()).users.a).toBeDefined();
  });
});

describe('active is a boolean (ID-B3)', () => {
  test('an update that omits active keeps a deactivated user deactivated', async () => {
    await seedUsers({
      a: localAdmin('a'),
      d: localAdmin('d', { active: false, internalGroups: [] })
    });

    const res = await put(caller('a'), 'd', { email: 'd@example.com' });

    expect(res.status).toBe(200);
    expect((await readUsers()).users.d.active).toBe(false);
  });

  test.each([['false'], [0], [null]])('PUT active: %p is BAD_REQUEST', async value => {
    await seedUsers({ a: localAdmin('a'), d: localAdmin('d', { internalGroups: [] }) });

    const res = await put(caller('a'), 'd', { active: value });

    expect(res.status).toBe(400);
    expect((await readUsers()).users.d.active).toBe(true);
  });

  test('POST active: "false" is BAD_REQUEST', async () => {
    await seedUsers({ a: localAdmin('a') });

    const res = await request(appFor(caller('a')))
      .post('/api/admin/auth/users')
      .send({ username: 'eve', password: 'secret123', active: 'false' });

    expect(res.status).toBe(400);
    expect(Object.keys((await readUsers()).users)).toEqual(['a']);
  });
});

describe('user guard edge cases', () => {
  const oidcAdmin = (id, subject) => ({
    id,
    username: id,
    active: true,
    authMethods: ['oidc'],
    oidcData: { subject },
    internalGroups: ['admins']
  });
  /** A token minted before the persisted id became the subject: id is the IdP subject. */
  const legacyOidcCaller = subject => ({
    id: subject,
    username: 'o',
    groups: ['admins'],
    authMode: 'oidc',
    authProvider: 'entra',
    isAdmin: true
  });

  beforeEach(async () => {
    await writeConfig('platform.json', {
      localAuth: { enabled: true },
      oidcAuth: { enabled: true, providers: [{ name: 'entra' }] }
    });
  });

  test('a legacy OIDC token cannot delete its own record (SELF_LOCKOUT)', async () => {
    await seedUsers({ a: localAdmin('a'), user_o: oidcAdmin('user_o', 'sub-1') });

    const res = await del(legacyOidcCaller('sub-1'), 'user_o');

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SELF_LOCKOUT');
    expect((await readUsers()).users.user_o).toBeDefined();
  });

  test('a legacy OIDC token cannot deactivate its own record (SELF_LOCKOUT)', async () => {
    await seedUsers({ a: localAdmin('a'), user_o: oidcAdmin('user_o', 'sub-1') });

    const res = await put(legacyOidcCaller('sub-1'), 'user_o', { active: false });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SELF_LOCKOUT');
  });

  test('a stored groups.json with a cycle does not block user edits (groups in force are used)', async () => {
    await writeConfig('groups.json', {
      groups: {
        ...ADMIN_GROUPS.groups,
        x: { id: 'x', name: 'X', inherits: ['y'], permissions: {} },
        y: { id: 'y', name: 'Y', inherits: ['x'], permissions: {} }
      }
    });
    state.lastGoodGroups = ADMIN_GROUPS;
    await seedUsers({ a: localAdmin('a'), b: localAdmin('b') });

    const ok = await put(caller('b'), 'a', { internalGroups: ['users'] });
    expect(ok.status).toBe(200);

    const refused = await put(caller('a'), 'b', { internalGroups: ['users'] });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('LAST_ADMIN');
  });
});
