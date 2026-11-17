// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Cross-file write skew between the lockout guards (review finding R4).
 *
 * Each guard holds only its own file's lock and reads the other files
 * unlocked. Without one lock around all guarded writers, a platform save that
 * turns local sign-in off and a user edit that removes the admin group from
 * the only OIDC administrator could each pass against the other's old file and
 * together leave no administrator. `withAdminInvariantLock` serializes them.
 *
 * Real ConfigStore on a temporary contents directory. Native-ESM jest.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const state = { rootDir: os.tmpdir() };

jest.unstable_mockModule('../pathUtils.js', () => ({ getRootDir: () => state.rootDir }));
jest.unstable_mockModule('../storage/bootstrap.js', () => ({ getStorage: () => null }));
jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => ({}),
    get: () => null,
    getGroups: () => null,
    refreshCacheEntry: async () => {},
    setCacheEntry: () => undefined
  }
}));
jest.unstable_mockModule('../middleware/oidcAuth.js', () => ({
  reconfigureOidcProviders: () => {}
}));
jest.unstable_mockModule('../services/TokenStorageService.js', () => ({
  default: { isEncrypted: () => false, encryptString: v => v, decryptString: v => v }
}));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({ logAudit: async () => {} }));
jest.unstable_mockModule('../services/ChangeHistoryService.js', () => ({
  saveSnapshot: async () => {},
  listSnapshots: async () => [],
  getSnapshot: async () => null
}));
jest.unstable_mockModule('../services/userDeletion.js', () => ({ startUserCleanup: () => {} }));
jest.unstable_mockModule('../services/integrations/iFinderTokenProvider.js', () => ({
  deleteLoginTokens: async () => {}
}));

const { default: registerAdminConfigRoutes } = await import('../routes/admin/configs.js');
const { default: registerAdminAuthRoutes } = await import('../routes/admin/auth.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { withAdminInvariantLock } = await import('../utils/adminInvariantLock.js');
const { countUsableAdmins, effectivePlatformConfig } = await import('../utils/authInvariants.js');
const { resolveGroupInheritance } = await import('../utils/authorization.js');

const PLATFORM = {
  auth: { mode: 'local' },
  localAuth: { enabled: true },
  oidcAuth: { enabled: true, providers: [{ name: 'entra', clientId: 'x' }] },
  proxyAuth: { enabled: false }
};
const GROUPS = {
  groups: {
    admins: { id: 'admins', name: 'Admins', permissions: { adminAccess: true } },
    users: { id: 'users', name: 'Users', permissions: { adminAccess: false } }
  }
};
const USERS = {
  users: {
    a: {
      id: 'a',
      username: 'a',
      active: true,
      authMethods: ['local'],
      passwordHash: 'h',
      internalGroups: ['admins']
    },
    b: { id: 'b', username: 'b', active: true, authMethods: ['oidc'], internalGroups: ['admins'] }
  },
  metadata: { version: '2.0.0' }
};

/** Admin A signs in locally, admin B through OIDC. */
const A = { id: 'a', username: 'a', groups: ['admins'], authMode: 'local', isAdmin: true };
const B = {
  id: 'b',
  username: 'b',
  groups: ['admins'],
  authMode: 'oidc',
  authProvider: 'entra',
  isAdmin: true
};

const file = name => path.join(state.rootDir, 'contents', 'config', name);
const writeConfig = (name, data) => fs.writeFile(file(name), JSON.stringify(data, null, 2));
const readConfig = async name => JSON.parse(await fs.readFile(file(name), 'utf8'));

function appFor(user) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  registerAdminConfigRoutes(app);
  registerAdminAuthRoutes(app);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  state.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-invariant-lock-'));
  await fs.mkdir(path.join(state.rootDir, 'contents', 'config'), { recursive: true });
  await writeConfig('platform.json', PLATFORM);
  await writeConfig('groups.json', GROUPS);
  await writeConfig('users.json', USERS);
});

afterEach(async () => {
  await fs.rm(state.rootDir, { recursive: true, force: true });
});

describe('cross-file write skew', () => {
  test('a platform save and a user demotion at once never leave zero admins', async () => {
    for (let round = 0; round < 5; round++) {
      await writeConfig('platform.json', PLATFORM);
      await writeConfig('users.json', USERS);

      // B turns local off (fine while B is an admin); A demotes B (fine while local is on).
      await Promise.all([
        request(appFor(B))
          .post('/api/admin/configs/platform')
          .send({ ...PLATFORM, localAuth: { enabled: false } }),
        request(appFor(A))
          .put('/api/admin/auth/users/b')
          .send({ internalGroups: ['users'] })
      ]);

      const platform = effectivePlatformConfig(await readConfig('platform.json'), {});
      const users = await readConfig('users.json');
      const admins = countUsableAdmins(users, resolveGroupInheritance(GROUPS), platform);
      expect(admins).toBeGreaterThan(0);
    }
  });
});

describe('withAdminInvariantLock', () => {
  test('runs one guarded write at a time, in call order', async () => {
    const events = [];
    const task = (name, ms) => () =>
      new Promise(resolve => {
        events.push(`start ${name}`);
        setTimeout(() => {
          events.push(`end ${name}`);
          resolve(name);
        }, ms);
      });

    const results = await Promise.all([
      withAdminInvariantLock(task('first', 20)),
      withAdminInvariantLock(task('second', 1))
    ]);

    expect(results).toEqual(['first', 'second']);
    expect(events).toEqual(['start first', 'end first', 'start second', 'end second']);
  });

  test('is reentrant within one call chain and survives a failed holder', async () => {
    await expect(
      withAdminInvariantLock(async () => withAdminInvariantLock(async () => 'inner'))
    ).resolves.toBe('inner');
    await expect(
      withAdminInvariantLock(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    await expect(withAdminInvariantLock(async () => 'next')).resolves.toBe('next');
  });
});
