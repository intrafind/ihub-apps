// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * groups.json always resolves, and group edits keep an administrator (ID-B4).
 *
 * Deleting a group that another group inherits from used to succeed. The next
 * cache refresh then failed to resolve the inheritance and kept serving the
 * old groups, so every later revocation silently stopped applying.
 *
 * - DELETE of a group others inherit from: 409 `GROUP_IN_USE`, naming them.
 * - Every writer (create, update, delete, rollback) refuses a body that does
 *   not resolve: 400.
 * - An update that leaves no administrator who can sign in: 409 `LAST_ADMIN`.
 *
 * Real ConfigStore on a temporary contents directory, real adminAuth.
 * Native-ESM jest.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';

// A root before the first test: modules read it while they load.
const state = { rootDir: os.tmpdir(), snapshot: null, refreshes: 0, lastGoodGroups: null };

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
    // The groups the runtime enforces (the last body that resolved).
    getGroups: () => (state.lastGoodGroups ? { data: state.lastGoodGroups } : null),
    refreshCacheEntry: async () => {
      state.refreshes++;
    },
    setCacheEntry: () => undefined
  }
}));

jest.unstable_mockModule('../services/AuditLogService.js', () => ({ logAudit: async () => {} }));
jest.unstable_mockModule('../services/ChangeHistoryService.js', () => ({
  saveSnapshot: async () => {},
  listSnapshots: async () => [],
  getSnapshot: async () => state.snapshot
}));

const { default: registerAdminGroupRoutes } = await import('../routes/admin/groups.js');
const { default: registerAdminChangesRoutes } = await import('../routes/admin/changes.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { resolveGroupInheritance } = await import('../utils/authorization.js');

const ADMIN = { id: 'a', username: 'a', groups: ['admins'], authMode: 'local', isAdmin: true };

const GROUPS = {
  groups: {
    admins: { id: 'admins', name: 'Admins', permissions: { adminAccess: true } },
    ops: { id: 'ops', name: 'Ops', inherits: ['admins'], permissions: { adminAccess: false } },
    parent: { id: 'parent', name: 'Parent', permissions: { apps: ['chat'] } },
    middle: { id: 'middle', name: 'Middle', inherits: ['parent'], permissions: {} },
    child: { id: 'child', name: 'Child', inherits: ['middle'], permissions: {} },
    lonely: { id: 'lonely', name: 'Lonely', permissions: {} }
  },
  metadata: {}
};

const file = name => path.join(state.rootDir, 'contents', 'config', name);
const writeConfig = (name, data) => fs.writeFile(file(name), JSON.stringify(data, null, 2));
const readText = name => fs.readFile(file(name), 'utf8');
const readGroups = async () => JSON.parse(await readText('groups.json'));
const readGroupsSync = () => JSON.parse(fsSync.readFileSync(file('groups.json'), 'utf8'));

function appFor(user) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  registerAdminGroupRoutes(app);
  registerAdminChangesRoutes(app);
  app.use(errorHandler);
  return app;
}

const del = (id, user = ADMIN) => request(appFor(user)).delete(`/api/admin/groups/${id}`);
const put = (id, body) => request(appFor(ADMIN)).put(`/api/admin/groups/${id}`).send(body);
const post = body => request(appFor(ADMIN)).post('/api/admin/groups').send(body);

beforeEach(async () => {
  state.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-group-guard-'));
  state.refreshes = 0;
  state.snapshot = null;
  state.lastGoodGroups = null;
  await fs.mkdir(path.join(state.rootDir, 'contents', 'config'), { recursive: true });
  await writeConfig('groups.json', GROUPS);
  await writeConfig('platform.json', { localAuth: { enabled: true } });
  await writeConfig('users.json', {
    users: {
      a: {
        id: 'a',
        username: 'a',
        active: true,
        authMethods: ['local'],
        passwordHash: 'h',
        internalGroups: ['ops']
      }
    }
  });
});

afterEach(async () => {
  await fs.rm(state.rootDir, { recursive: true, force: true });
});

describe('DELETE /api/admin/groups/:id', () => {
  test('a group another inherits from is GROUP_IN_USE, naming it; nothing written', async () => {
    const before = await readText('groups.json');

    const res = await del('parent');

    expect(res.status).toBe(409);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('GROUP_IN_USE');
    expect(res.body.details).toEqual({ groupId: 'parent', dependants: ['middle'] });
    expect(await readText('groups.json')).toBe(before);
    expect(state.refreshes).toBe(0);
  });

  test('names only the direct inheritors', async () => {
    const res = await del('middle');

    expect(res.status).toBe(409);
    expect(res.body.details.dependants).toEqual(['child']);
  });

  test('a group nobody inherits from is deleted', async () => {
    const res = await del('lonely');

    expect(res.status).toBe(204);
    expect((await readGroups()).groups.lonely).toBeUndefined();
  });

  test('deleting leaf to root leaves a file that resolves at every step', async () => {
    for (const id of ['child', 'middle', 'parent', 'lonely']) {
      const res = await del(id);
      expect(res.status).toBe(204);
      const current = await readGroups();
      expect(() => resolveGroupInheritance(current)).not.toThrow();
    }
  });

  test('protected groups still answer 400', async () => {
    const res = await del('admins');

    expect(res.status).toBe(400);
  });

  test('an anonymous caller never reaches the guard (real adminAuth)', async () => {
    const before = await readText('groups.json');

    const res = await del('lonely', { id: 'anonymous', groups: ['admins'] });

    expect(res.status).toBe(403);
    expect(await readText('groups.json')).toBe(before);
  });
});

describe('PUT /api/admin/groups/:id keeps an administrator', () => {
  test('cutting the only admin off their inherited admin group is LAST_ADMIN', async () => {
    const before = await readText('groups.json');

    const res = await put('ops', { inherits: [] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LAST_ADMIN');
    expect(await readText('groups.json')).toBe(before);
  });

  test('the same edit is allowed while another usable admin remains', async () => {
    const users = JSON.parse(await readText('users.json'));
    users.users.b = {
      id: 'b',
      username: 'b',
      active: true,
      authMethods: ['local'],
      passwordHash: 'h',
      internalGroups: ['admins']
    };
    await writeConfig('users.json', users);

    const res = await put('ops', { inherits: [] });

    expect(res.status).toBe(200);
  });

  test('an edit that keeps admin rights is not refused', async () => {
    const res = await put('ops', { description: 'Operations' });

    expect(res.status).toBe(200);
  });

  test('inheriting from a missing group is 400', async () => {
    const res = await put('lonely', { inherits: ['nope'] });

    expect(res.status).toBe(400);
  });
});

describe('group rollback', () => {
  test('a rollback that re-introduces inherits to a deleted group is 400', async () => {
    expect((await del('lonely')).status).toBe(204);
    state.snapshot = {
      ts: '2026-01-01T00:00:00.000Z',
      before: { id: 'child', name: 'Child', inherits: ['lonely'], permissions: {} }
    };
    const before = await readText('groups.json');

    const res = await request(appFor(ADMIN)).post(
      '/api/admin/changes/group/child/snap.json/rollback'
    );

    expect(res.status).toBe(400);
    expect(await readText('groups.json')).toBe(before);
  });
});

describe('DELETE keeps an administrator who can sign in', () => {
  test('deleting the custom admin group every admin is in is LAST_ADMIN, nothing written', async () => {
    // `admins` keeps the flag (so the old "only adminAccess group" rule passes),
    // but nobody is in it: every admin user gets their rights through it-admins.
    await writeConfig('groups.json', {
      groups: {
        admins: { id: 'admins', name: 'Admins', permissions: { adminAccess: true } },
        'it-admins': { id: 'it-admins', name: 'IT', permissions: { adminAccess: true } }
      },
      metadata: {}
    });
    const users = JSON.parse(await readText('users.json'));
    users.users.a.internalGroups = ['it-admins'];
    await writeConfig('users.json', users);
    const before = await readText('groups.json');

    const res = await del('it-admins');

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LAST_ADMIN');
    expect(res.body.details).toEqual({ groupId: 'it-admins' });
    expect(await readText('groups.json')).toBe(before);
  });

  test('the same delete is allowed while an admin remains through another group', async () => {
    await writeConfig('groups.json', {
      groups: {
        admins: { id: 'admins', name: 'Admins', permissions: { adminAccess: true } },
        'it-admins': { id: 'it-admins', name: 'IT', permissions: { adminAccess: true } }
      },
      metadata: {}
    });
    const users = JSON.parse(await readText('users.json'));
    users.users.a.internalGroups = ['it-admins', 'admins'];
    await writeConfig('users.json', users);

    const res = await del('it-admins');

    expect(res.status).toBe(204);
  });
});

describe('a stored groups.json that does not resolve', () => {
  /** A hand edit: x and y inherit from each other. */
  const withCycle = () => {
    const broken = structuredClone(GROUPS);
    broken.groups.x = { id: 'x', name: 'X', inherits: ['y'], permissions: {} };
    broken.groups.y = { id: 'y', name: 'Y', inherits: ['x'], permissions: {} };
    return broken;
  };

  beforeEach(async () => {
    await writeConfig('groups.json', withCycle());
    state.lastGoodGroups = resolveGroupInheritance(structuredClone(GROUPS));
  });

  test('the PUT that breaks the cycle is saved', async () => {
    const res = await put('x', { inherits: [] });

    expect(res.status).toBe(200);
    expect(() => resolveGroupInheritance(readGroupsSync())).not.toThrow();
  });

  test('a PUT that leaves the cycle in place names the stored problem', async () => {
    const res = await put('ops', { inherits: [] });

    // Still broken afterwards (the cycle is untouched): the stored problem is named.
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/stored group configuration already does not resolve/);
  });

  test('an unrelated create is 400 naming the stored problem, not the new group', async () => {
    const before = await readText('groups.json');

    const res = await post({ id: 'fresh', name: 'Fresh', permissions: {} });

    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/stored group configuration already does not resolve/);
    expect(await readText('groups.json')).toBe(before);
  });

  test('with no groups in force either, the repairing PUT is 503 (unevaluable)', async () => {
    state.lastGoodGroups = null;

    const res = await put('x', { inherits: [] });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('ADMIN_CHECK_FAILED');
  });
});
