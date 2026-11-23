// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Optional `If-Match` on group saves.
 *
 * GET /api/admin/groups answers with the revision of the stored groups.json as
 * `ETag` (utils/configRevision.js, the same revision the platform and UI
 * config saves use). PUT /api/admin/groups/{id}:
 *   - with an `If-Match` that names the stored revision: saved, and the
 *     response carries the new `ETag`;
 *   - with a stale `If-Match`: 412 `PRECONDITION_FAILED`, nothing written;
 *   - without `If-Match`: saved as before.
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
const state = { rootDir: os.tmpdir() };

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
    getGroups: () => null,
    refreshCacheEntry: async () => {},
    setCacheEntry: () => undefined
  }
}));

jest.unstable_mockModule('../services/AuditLogService.js', () => ({ logAudit: async () => {} }));
jest.unstable_mockModule('../services/ChangeHistoryService.js', () => ({
  saveSnapshot: async () => {}
}));

const { default: registerAdminGroupRoutes } = await import('../routes/admin/groups.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const ADMIN = { id: 'a', username: 'a', groups: ['admins'], authMode: 'local', isAdmin: true };

const GROUPS = {
  groups: {
    admins: { id: 'admins', name: 'Admins', permissions: { adminAccess: true } },
    authenticated: { id: 'authenticated', name: 'Authenticated', permissions: { models: [] } },
    team: { id: 'team', name: 'Team', permissions: { models: ['a'] } }
  },
  metadata: {}
};

const file = name => path.join(state.rootDir, 'contents', 'config', name);
const writeConfig = (name, data) => fs.writeFile(file(name), JSON.stringify(data, null, 2));
const readText = name => fs.readFile(file(name), 'utf8');

function app() {
  const server = express();
  server.use(express.json());
  server.use((req, res, next) => {
    req.user = ADMIN;
    next();
  });
  registerAdminGroupRoutes(server);
  server.use(errorHandler);
  return server;
}

const list = () => request(app()).get('/api/admin/groups');
const put = (id, body, ifMatch) => {
  const req = request(app()).put(`/api/admin/groups/${id}`);
  if (ifMatch !== undefined) req.set('If-Match', ifMatch);
  return req.send(body);
};

beforeEach(async () => {
  state.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-group-if-match-'));
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
        internalGroups: ['admins']
      }
    }
  });
});

afterEach(async () => {
  await fs.rm(state.rootDir, { recursive: true, force: true });
});

describe('GET /api/admin/groups', () => {
  test('answers the revision of groups.json as a strong ETag', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.headers.etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('the ETag changes when a group changes', async () => {
    const before = (await list()).headers.etag;
    await put('team', { permissions: { models: ['a', 'b'] } });
    expect((await list()).headers.etag).not.toBe(before);
  });
});

describe('PUT /api/admin/groups/{id} with If-Match', () => {
  test('a matching If-Match saves and answers the new ETag', async () => {
    const etag = (await list()).headers.etag;

    const res = await put('team', { permissions: { models: ['a', 'b'] } }, etag);

    expect(res.status).toBe(200);
    expect(res.body.permissions.models).toEqual(['a', 'b']);
    const after = (await list()).headers.etag;
    expect(res.headers.etag).toBe(after);
    expect(after).not.toBe(etag);

    // The new ETag is good for the next save.
    const again = await put('team', { permissions: { models: ['a', 'b', 'c'] } }, res.headers.etag);
    expect(again.status).toBe(200);
  });

  test('a stale If-Match is 412 PRECONDITION_FAILED and writes nothing', async () => {
    const etag = (await list()).headers.etag;
    // Another admin saves in between.
    expect((await put('authenticated', { permissions: { models: ['x'] } })).status).toBe(200);
    const stored = await readText('groups.json');

    const res = await put('team', { permissions: { models: [] } }, etag);

    expect(res.status).toBe(412);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('PRECONDITION_FAILED');
    expect(res.body.details).toEqual({ resource: 'groups' });
    expect(await readText('groups.json')).toBe(stored);
  });

  test('without If-Match the save behaves as before', async () => {
    await put('authenticated', { permissions: { models: ['x'] } });

    const res = await put('team', { permissions: { models: [] } });

    expect(res.status).toBe(200);
    expect(res.headers.etag).toMatch(/^"/);
    const saved = JSON.parse(await readText('groups.json'));
    expect(saved.groups.team.permissions.models).toEqual([]);
    expect(saved.groups.authenticated.permissions.models).toEqual(['x']);
  });

  test('a weak tag from a proxy counts as its strong value', async () => {
    const etag = (await list()).headers.etag;
    const res = await put('team', { name: 'Team 2' }, `W/${etag}`);
    expect(res.status).toBe(200);
  });
});
