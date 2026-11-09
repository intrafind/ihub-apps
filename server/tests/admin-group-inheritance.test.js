// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Saving a group through the admin API must not store inheritance that
 * `loadGroupsConfiguration()` cannot resolve.
 *
 * A group naming a parent that does not exist, itself, or a parent that leads
 * back to it makes `resolveGroupInheritance` throw at the next load. The admin
 * form now offers `inherits`, so the create and update handlers refuse such a
 * list with a 400 and leave `groups.json` as it was.
 *
 * Note: The repo's source is native ESM, so this file uses
 * `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import fs from 'fs/promises';
import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';

const state = { rootDir: mkdtempSync(path.join(os.tmpdir(), 'ihub-group-inherits-boot-')) };

jest.unstable_mockModule('../pathUtils.js', () => ({
  getRootDir: () => state.rootDir
}));

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));

jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: async () => {}
}));

jest.unstable_mockModule('../services/ChangeHistoryService.js', () => ({
  saveSnapshot: async () => {},
  listSnapshots: async () => [],
  getSnapshot: async () => null
}));

jest.unstable_mockModule('../storage/bootstrap.js', () => ({
  getStorage: () => null
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getGroups: () => ({ data: { groups: {} } }),
    refreshCacheEntry: async () => {},
    getPlatform: () => ({ data: {} })
  }
}));

const { default: registerAdminGroupRoutes } = await import('../routes/admin/groups.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: 'admin-user', username: 'admin', groups: ['admins'] };
    next();
  });
  registerAdminGroupRoutes(app);
  app.use(errorHandler);
  return app;
}

const groupsPath = () => path.join(state.rootDir, 'contents', 'config', 'groups.json');
const readGroups = async () => JSON.parse(await fs.readFile(groupsPath(), 'utf8')).groups;
const perms = { apps: [], adminAccess: false };

const created = [state.rootDir];

beforeEach(async () => {
  state.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-group-inherits-'));
  created.push(state.rootDir);
  await fs.mkdir(path.join(state.rootDir, 'contents', 'config'), { recursive: true });
  await fs.writeFile(
    groupsPath(),
    JSON.stringify({
      groups: {
        anonymous: { id: 'anonymous', name: 'Anonymous', permissions: perms },
        authenticated: {
          id: 'authenticated',
          name: 'Authenticated',
          inherits: ['anonymous'],
          permissions: perms
        },
        editors: {
          id: 'editors',
          name: 'Editors',
          inherits: ['authenticated'],
          permissions: perms
        }
      },
      metadata: { lastModified: '2026-01-01T00:00:00.000Z' }
    })
  );
});

afterAll(async () => {
  for (const dir of created) await fs.rm(dir, { recursive: true, force: true });
});

describe('POST /api/admin/groups with inherits', () => {
  const create = inherits =>
    request(createTestApp())
      .post('/api/admin/groups')
      .send({ id: 'qa', name: 'QA', permissions: perms, inherits });

  it('stores a valid list of parents, without duplicates', async () => {
    const response = await create(['editors', 'editors', 'anonymous']);

    expect(response.status).toBe(200);
    expect(response.body.inherits).toEqual(['editors', 'anonymous']);
    expect((await readGroups()).qa.inherits).toEqual(['editors', 'anonymous']);
  });

  it('accepts a group without parents', async () => {
    const response = await create([]);

    expect(response.status).toBe(200);
    expect((await readGroups()).qa.inherits).toEqual([]);
  });

  it('refuses a parent that does not exist and writes nothing', async () => {
    const response = await create(['ghosts']);

    expect(response.status).toBe(400);
    expect(response.body.detail).toMatch(/Parent group not found: ghosts/);
    expect((await readGroups()).qa).toBeUndefined();
  });

  it('refuses names that are only on Object.prototype', async () => {
    const response = await create(['constructor']);

    expect(response.status).toBe(400);
  });

  it('refuses a parent that is not a string', async () => {
    const response = await create([{ id: 'editors' }]);

    expect(response.status).toBe(400);
  });
});

describe('PUT /api/admin/groups/:groupId with inherits', () => {
  const update = (groupId, inherits) =>
    request(createTestApp()).put(`/api/admin/groups/${groupId}`).send({ inherits });

  it('stores a new list of parents', async () => {
    const response = await update('editors', ['anonymous']);

    expect(response.status).toBe(200);
    expect((await readGroups()).editors.inherits).toEqual(['anonymous']);
  });

  it('clears the parents with an empty list', async () => {
    const response = await update('editors', []);

    expect(response.status).toBe(200);
    expect((await readGroups()).editors.inherits).toEqual([]);
  });

  it('refuses a group that inherits itself', async () => {
    const response = await update('editors', ['editors']);

    expect(response.status).toBe(400);
    expect((await readGroups()).editors.inherits).toEqual(['authenticated']);
  });

  it('refuses a cycle and leaves the file as it was', async () => {
    // editors -> authenticated -> anonymous; anonymous -> editors closes the loop.
    const response = await update('anonymous', ['editors']);

    expect(response.status).toBe(400);
    expect(response.body.detail).toMatch(/Circular dependency/);
    expect((await readGroups()).anonymous.inherits).toBeUndefined();
  });

  it('refuses a parent that does not exist', async () => {
    const response = await update('editors', ['ghosts']);

    expect(response.status).toBe(400);
    expect((await readGroups()).editors.inherits).toEqual(['authenticated']);
  });

  it('does not check inheritance when the request leaves it alone', async () => {
    const response = await request(createTestApp())
      .put('/api/admin/groups/editors')
      .send({ name: 'Writers' });

    expect(response.status).toBe(200);
    expect((await readGroups()).editors.inherits).toEqual(['authenticated']);
  });
});

describe('group routes answer errors in the shared shape', () => {
  it('answers an unsafe id with BAD_REQUEST', async () => {
    const response = await request(createTestApp()).delete('/api/admin/groups/bad%20id');

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('BAD_REQUEST');
  });

  it('refuses to delete a protected system group', async () => {
    const response = await request(createTestApp()).delete('/api/admin/groups/admins');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'BAD_REQUEST' });
    expect(response.body.detail).toMatch(/protected system group/);
  });

  it('answers an unknown group with NOT_FOUND and an existing id with CONFLICT', async () => {
    const missing = await request(createTestApp()).delete('/api/admin/groups/ghosts');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'NOT_FOUND', detail: 'Group not found' });

    const exists = await request(createTestApp())
      .post('/api/admin/groups')
      .send({ id: 'editors', name: 'Again', permissions: perms });
    expect(exists.status).toBe(409);
    expect(exists.body).toMatchObject({ code: 'CONFLICT', detail: 'Group ID already exists' });
  });
});
