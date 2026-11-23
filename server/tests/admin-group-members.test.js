// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Managing the members of a group from the group's side.
 *
 * - GET lists the users whose `internalGroups` contain the group.
 * - POST adds users (all or none), is idempotent for current members.
 * - DELETE removes one and keeps the "an administrator can still sign in" rule.
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

const state = { rootDir: os.tmpdir(), refreshes: [] };

jest.unstable_mockModule('../pathUtils.js', () => ({ getRootDir: () => state.rootDir }));
jest.unstable_mockModule('../storage/bootstrap.js', () => ({ getStorage: () => null }));
jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => ({}),
    get: () => null,
    getGroups: () => null,
    refreshCacheEntry: async key => {
      state.refreshes.push(key);
    },
    setCacheEntry: () => undefined
  }
}));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({ logAudit: async () => {} }));

const { default: registerAdminGroupMemberRoutes } = await import('../routes/admin/groupMembers.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const ADMIN = { id: 'a', username: 'a', groups: ['admins'], authMode: 'local', isAdmin: true };

const GROUPS = {
  groups: {
    admins: { id: 'admins', name: 'Admins', permissions: { adminAccess: true } },
    team: { id: 'team', name: 'Team', permissions: {} }
  },
  metadata: {}
};

const USERS = {
  users: {
    a: {
      id: 'a',
      username: 'a',
      active: true,
      authMethods: ['local'],
      passwordHash: 'secret-hash',
      internalGroups: ['admins']
    },
    b: {
      id: 'b',
      username: 'bob',
      name: 'Bob',
      email: 'bob@example.com',
      active: true,
      authMethods: ['local'],
      passwordHash: 'h',
      internalGroups: ['team']
    },
    c: {
      id: 'c',
      username: 'carol',
      name: 'Carol',
      active: false,
      authMethods: ['oidc'],
      internalGroups: []
    }
  },
  metadata: {}
};

const file = name => path.join(state.rootDir, 'contents', 'config', name);
const writeConfig = (name, data) => fs.writeFile(file(name), JSON.stringify(data, null, 2));
const readUsers = async () => JSON.parse(await fs.readFile(file('users.json'), 'utf8'));

function appFor(user = ADMIN) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  registerAdminGroupMemberRoutes(app);
  app.use(errorHandler);
  return app;
}

const list = id => request(appFor()).get(`/api/admin/groups/${id}/members`);
const add = (id, body) => request(appFor()).post(`/api/admin/groups/${id}/members`).send(body);
const remove = (id, userId) =>
  request(appFor()).delete(`/api/admin/groups/${id}/members/${userId}`);

beforeEach(async () => {
  state.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-group-members-'));
  state.refreshes = [];
  await fs.mkdir(path.join(state.rootDir, 'contents', 'config'), { recursive: true });
  await writeConfig('groups.json', GROUPS);
  await writeConfig('platform.json', { localAuth: { enabled: true } });
  await writeConfig('users.json', USERS);
});

afterEach(async () => {
  await fs.rm(state.rootDir, { recursive: true, force: true });
});

describe('GET /api/admin/groups/:groupId/members', () => {
  test('lists the members without any credential', async () => {
    const res = await list('team');

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      {
        id: 'b',
        username: 'bob',
        name: 'Bob',
        email: 'bob@example.com',
        active: true,
        authMethods: ['local']
      }
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/hash/i);
  });

  test('a group without members is an empty list', async () => {
    await writeConfig('groups.json', {
      ...GROUPS,
      groups: { ...GROUPS.groups, empty: { id: 'empty', name: 'Empty', permissions: {} } }
    });

    const res = await list('empty');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });

  test('an unknown group is 404', async () => {
    const res = await list('nope');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

describe('POST /api/admin/groups/:groupId/members', () => {
  test('adds the users, answers 201 with Location and refreshes the cache', async () => {
    const res = await add('team', { userIds: ['a', 'c'] });

    expect(res.status).toBe(201);
    expect(res.headers.location).toMatch(/\/api\/admin\/groups\/team\/members$/);
    expect(res.body.items.map(m => m.id)).toEqual(['a', 'c']);
    const users = (await readUsers()).users;
    expect(users.a.internalGroups).toEqual(['admins', 'team']);
    expect(users.c.internalGroups).toEqual(['team']);
    expect(users.a.passwordHash).toBe('secret-hash');
    expect(state.refreshes).toContain('config/users.json');
  });

  test('a current member is left alone and not reported as added', async () => {
    const res = await add('team', { userIds: ['b', 'c'] });

    expect(res.status).toBe(201);
    expect(res.body.items.map(m => m.id)).toEqual(['c']);
    expect((await readUsers()).users.b.internalGroups).toEqual(['team']);
  });

  test('one unknown user adds nobody', async () => {
    const before = JSON.stringify(await readUsers());

    const res = await add('team', { userIds: ['c', 'ghost'] });

    expect(res.status).toBe(404);
    expect(res.body.details).toEqual({ userIds: ['ghost'] });
    expect(JSON.stringify(await readUsers())).toBe(before);
  });

  test.each([[{}], [{ userIds: [] }], [{ userIds: 'c' }], [{ userIds: [1] }]])(
    'rejects the body %j with 400',
    async body => {
      const res = await add('team', body);

      expect(res.status).toBe(400);
    }
  );

  test('an unknown group is 404', async () => {
    const res = await add('nope', { userIds: ['c'] });

    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/admin/groups/:groupId/members/:userId', () => {
  test('removes the group from the user and answers 204', async () => {
    const res = await remove('team', 'b');

    expect(res.status).toBe(204);
    expect((await readUsers()).users.b.internalGroups).toEqual([]);
    expect(state.refreshes).toContain('config/users.json');
  });

  test('a user who is not a member is 404', async () => {
    const res = await remove('team', 'c');

    expect(res.status).toBe(404);
  });

  test('an unknown user is 404', async () => {
    const res = await remove('team', 'ghost');

    expect(res.status).toBe(404);
  });

  test('the last administrator cannot be removed from the admin group', async () => {
    const before = JSON.stringify(await readUsers());

    // `b` is not the caller, so this is LAST_ADMIN rather than SELF_LOCKOUT.
    await writeConfig('users.json', {
      ...USERS,
      users: {
        ...USERS.users,
        a: { ...USERS.users.a, internalGroups: [] },
        b: { ...USERS.users.b, internalGroups: ['admins'] }
      }
    });

    const res = await remove('admins', 'b');

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LAST_ADMIN');
    expect(before).not.toBe('');
    expect((await readUsers()).users.b.internalGroups).toEqual(['admins']);
  });

  test('an administrator can be removed while another one remains', async () => {
    await writeConfig('users.json', {
      ...USERS,
      users: { ...USERS.users, b: { ...USERS.users.b, internalGroups: ['admins'] } }
    });

    const res = await remove('admins', 'b');

    expect(res.status).toBe(204);
    expect((await readUsers()).users.b.internalGroups).toEqual([]);
  });
});
