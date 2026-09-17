/**
 * Regression test for rolling a group back through the change history.
 *
 * The rollback handler rebuilds `config/groups.json` around the snapshot it is
 * restoring, so where it reads the rest of the file from decides what happens
 * to every group it is not restoring. `configCache.getGroups()` is the wrong
 * source: the cache stores groups with inheritance already resolved, each
 * child carrying the union of its parents' permissions, and writing that back
 * replaces the authored file with its own expansion.
 *
 * What makes this worth a test rather than a comment is that it is silent and
 * it is permissions. Nothing fails, the rolled-back group is correct, and the
 * hierarchy is gone: children now hold as their own what they used to inherit,
 * so a later revoke at the top of the tree changes nothing anywhere below it.
 *
 * Note: The repo's source is native ESM, so this file uses
 * `jest.unstable_mockModule` + dynamic imports. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const state = { rootDir: null, snapshot: null };

/** The file as an admin authored it: permissions stated once, then inherited. */
const AUTHORED = {
  groups: {
    anonymous: {
      id: 'anonymous',
      name: 'Anonymous',
      permissions: { apps: ['chat'], adminAccess: false }
    },
    authenticated: {
      id: 'authenticated',
      name: 'Authenticated',
      inherits: ['anonymous'],
      permissions: { apps: [], adminAccess: false }
    },
    editors: {
      id: 'editors',
      name: 'Editors',
      inherits: ['authenticated'],
      permissions: { apps: ['editor'], adminAccess: false }
    }
  },
  metadata: { lastModified: '2026-01-01T00:00:00.000Z' }
};

/**
 * The same groups as the cache holds them: every inherited permission copied
 * down into the child. This is what `configCache.getGroups()` returns, and
 * writing it to disk is the defect.
 */
const RESOLVED = {
  groups: {
    anonymous: { ...AUTHORED.groups.anonymous },
    authenticated: {
      ...AUTHORED.groups.authenticated,
      permissions: { apps: ['chat'], adminAccess: false }
    },
    editors: {
      ...AUTHORED.groups.editors,
      permissions: { apps: ['editor', 'chat'], adminAccess: false }
    }
  }
};

jest.unstable_mockModule('../pathUtils.js', () => ({
  getRootDir: () => state.rootDir
}));

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
}));

jest.unstable_mockModule('../services/ChangeHistoryService.js', () => ({
  listSnapshots: async () => [],
  getSnapshot: async () => state.snapshot
}));

jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: async () => {}
}));

// No provider in this test, so ConfigStore takes its filesystem path under the
// mocked root — the same path a server that has not finished bootstrapping
// storage would take.
jest.unstable_mockModule('../storage/bootstrap.js', () => ({
  getStorage: () => null
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getGroups: () => ({ data: structuredClone(RESOLVED) }),
    refreshCacheEntry: async () => {},
    refreshAppsCache: async () => {},
    refreshPromptsCache: async () => {},
    refreshModelsCache: async () => {}
  }
}));

const { default: registerAdminChangesRoutes } = await import('../routes/admin/changes.js');

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: 'admin-user', username: 'admin', groups: ['admin'] };
    next();
  });
  registerAdminChangesRoutes(app);
  return app;
}

const groupsPath = () => path.join(state.rootDir, 'contents', 'config', 'groups.json');

async function readGroups() {
  return JSON.parse(await fs.readFile(groupsPath(), 'utf8'));
}

describe('POST /api/admin/changes/group/:id/:filename/rollback', () => {
  beforeEach(async () => {
    state.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-group-rollback-'));
    await fs.mkdir(path.join(state.rootDir, 'contents', 'config'), { recursive: true });
    await fs.writeFile(groupsPath(), JSON.stringify(AUTHORED, null, 2));
    state.snapshot = {
      ts: '2026-01-02T00:00:00.000Z',
      // The groups routes snapshot from the authored file, so this is the
      // authored shape and merges back into the authored file unchanged.
      before: {
        id: 'editors',
        name: 'Editors',
        inherits: ['authenticated'],
        permissions: { apps: ['editor'], adminAccess: false }
      },
      after: null
    };
  });

  afterEach(async () => {
    await fs.rm(state.rootDir, { recursive: true, force: true });
  });

  test('restores the snapshotted group', async () => {
    const response = await request(createTestApp()).post(
      '/api/admin/changes/group/editors/snap.json/rollback'
    );

    expect(response.status).toBe(200);
    expect((await readGroups()).groups.editors).toEqual(state.snapshot.before);
  });

  test('leaves every other group as it was authored, not as it resolves', async () => {
    await request(createTestApp()).post('/api/admin/changes/group/editors/snap.json/rollback');

    const onDisk = await readGroups();
    // The defect in one line: `authenticated` inherits `chat` from `anonymous`
    // and states nothing of its own. Writing the resolved cache back makes
    // `['chat']` its own permission, and revoking `chat` from `anonymous`
    // afterwards silently leaves it granted here.
    expect(onDisk.groups.authenticated.permissions.apps).toEqual([]);
    expect(onDisk.groups.authenticated.inherits).toEqual(['anonymous']);
    expect(onDisk.groups.anonymous).toEqual(AUTHORED.groups.anonymous);
  });

  test('keeps the parts of the file the cache does not carry', async () => {
    await request(createTestApp()).post('/api/admin/changes/group/editors/snap.json/rollback');

    // The cache holds groups; the file holds more than groups. Rebuilding it
    // from the cache drops whatever the cache never had a reason to keep.
    expect((await readGroups()).metadata).toEqual(AUTHORED.metadata);
  });
});
