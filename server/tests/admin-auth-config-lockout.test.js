// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A platform save never locks the signed-in admin, or every admin, out
 * (ID-B1). Before this guard, a local admin who unticked Local sign-in lost
 * the session on the next request, and the admin rescue then made the next
 * person who signed in through OIDC, proxy or NTLM an administrator.
 *
 * `POST /api/admin/configs/platform` and the platform rollback refuse such a
 * change with 409 `AUTH_LOCKOUT` and leave platform.json untouched. There is
 * no override. Evaluated on real files under a temporary contents directory,
 * through the real ConfigStore and the real adminAuth.
 *
 * Native-ESM jest (`jest.unstable_mockModule` + dynamic imports).
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const state = { rootDir: null, snapshot: null };

jest.unstable_mockModule('../pathUtils.js', () => ({
  getRootDir: () => state.rootDir
}));

jest.unstable_mockModule('../storage/bootstrap.js', () => ({
  getStorage: () => null
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    refreshCacheEntry: async () => {},
    getPlatform: () => ({})
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
  saveSnapshot: async () => {},
  listSnapshots: async () => [],
  getSnapshot: async () => state.snapshot
}));

const { default: registerAdminConfigRoutes } = await import('../routes/admin/configs.js');
const { default: registerAdminChangesRoutes } = await import('../routes/admin/changes.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { assertPlatformChangeKeepsAccess } = await import('../utils/adminGuards.js');

/** A signed-in local admin (what jwtAuth + enhanceUserWithPermissions give). */
const LOCAL_ADMIN = {
  id: 'user_local',
  username: 'admin',
  groups: ['admins'],
  authMode: 'local',
  isAdmin: true
};

/** A signed-in OIDC admin. */
const OIDC_ADMIN = {
  id: 'user_oidc',
  username: 'oidc-admin',
  groups: ['admins'],
  authMode: 'oidc',
  authProvider: 'entra',
  isAdmin: true
};

const BASE_PLATFORM = {
  defaultLanguage: 'en',
  auth: { mode: 'local' },
  anonymousAuth: { enabled: false },
  localAuth: { enabled: true },
  oidcAuth: { enabled: true, providers: [{ name: 'entra', clientId: 'x' }] },
  proxyAuth: { enabled: false },
  ldapAuth: { enabled: false, providers: [] },
  ntlmAuth: { enabled: false }
};

const GROUPS = {
  groups: {
    admins: { id: 'admins', name: 'Admins', permissions: { adminAccess: true } },
    users: { id: 'users', name: 'Users', permissions: { adminAccess: false } }
  }
};

const LOCAL_RECORD = {
  id: 'user_local',
  username: 'admin',
  active: true,
  authMethods: ['local'],
  passwordHash: 'hash',
  internalGroups: ['admins']
};

const OIDC_RECORD = {
  id: 'user_oidc',
  username: 'oidc-admin',
  active: true,
  authMethods: ['oidc'],
  internalGroups: ['admins']
};

const file = name => path.join(state.rootDir, 'contents', 'config', name);
const writeConfig = (name, data) => fs.writeFile(file(name), JSON.stringify(data, null, 2));
const readText = name => fs.readFile(file(name), 'utf8');

function appFor(user) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  registerAdminConfigRoutes(app);
  registerAdminChangesRoutes(app);
  app.use(errorHandler);
  return app;
}

const save = (user, body) => request(appFor(user)).post('/api/admin/configs/platform').send(body);

beforeEach(async () => {
  state.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-lockout-'));
  await fs.mkdir(path.join(state.rootDir, 'contents', 'config'), { recursive: true });
  await writeConfig('platform.json', BASE_PLATFORM);
  await writeConfig('groups.json', GROUPS);
  await writeConfig('users.json', { users: { user_local: LOCAL_RECORD }, metadata: {} });
  state.snapshot = null;
});

afterEach(async () => {
  delete process.env.IHUB_PLATFORM__LOCAL_AUTH__ENABLED;
  await fs.rm(state.rootDir, { recursive: true, force: true });
});

describe('POST /api/admin/configs/platform lockout guard', () => {
  test('a local admin turning local sign-in off is refused and nothing is written', async () => {
    const before = await readText('platform.json');

    const res = await save(LOCAL_ADMIN, { ...BASE_PLATFORM, localAuth: { enabled: false } });

    expect(res.status).toBe(409);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('AUTH_LOCKOUT');
    expect(res.body.details).toMatchObject({ reason: 'callerLosesSignIn', authMode: 'local' });
    expect(res.body.detail).toMatch(/sign in with it as an administrator/);
    expect(await readText('platform.json')).toBe(before);
  });

  test('is refused even while another method stays on: the caller would lose their session', async () => {
    const res = await save(LOCAL_ADMIN, {
      ...BASE_PLATFORM,
      localAuth: { enabled: false },
      proxyAuth: { enabled: true }
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AUTH_LOCKOUT');
  });

  test('the client built-in defaults after a failed load (proxy mode, local off) are refused', async () => {
    const res = await save(LOCAL_ADMIN, {
      auth: { mode: 'proxy' },
      anonymousAuth: { enabled: false },
      localAuth: { enabled: false },
      proxyAuth: { enabled: false },
      oidcAuth: { enabled: false, providers: [] }
    });

    expect(res.status).toBe(409);
  });

  test('an OIDC admin removing their own provider is refused', async () => {
    await writeConfig('users.json', {
      users: { user_local: LOCAL_RECORD, user_oidc: OIDC_RECORD }
    });

    const res = await save(OIDC_ADMIN, {
      ...BASE_PLATFORM,
      oidcAuth: { enabled: true, providers: [{ name: 'other' }] }
    });

    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ authMode: 'oidc', authProvider: 'entra' });
  });

  test('an OIDC admin may turn local sign-in off while an OIDC admin remains (the safe path)', async () => {
    await writeConfig('users.json', {
      users: { user_local: LOCAL_RECORD, user_oidc: OIDC_RECORD }
    });

    const res = await save(OIDC_ADMIN, { ...BASE_PLATFORM, localAuth: { enabled: false } });

    expect(res.status).toBe(200);
    expect(JSON.parse(await readText('platform.json')).localAuth.enabled).toBe(false);
  });

  test('a change leaving no administrator who can sign in is refused', async () => {
    // The OIDC admin is an admin through an IdP mapping, not users.json: the only
    // persisted admin signs in locally, and the rescue would fire after the save.
    const res = await save(OIDC_ADMIN, { ...BASE_PLATFORM, localAuth: { enabled: false } });

    expect(res.status).toBe(409);
    expect(res.body.details.reason).toBe('noAdminSignIn');
  });

  test('a method forced on by IHUB_PLATFORM__ overrides counts as on', async () => {
    process.env.IHUB_PLATFORM__LOCAL_AUTH__ENABLED = 'true';

    const res = await save(LOCAL_ADMIN, { ...BASE_PLATFORM, localAuth: { enabled: false } });

    expect(res.status).toBe(200);
  });

  test('an unrelated change is saved', async () => {
    const res = await save(LOCAL_ADMIN, { ...BASE_PLATFORM, defaultLanguage: 'de' });

    expect(res.status).toBe(200);
    expect(JSON.parse(await readText('platform.json')).defaultLanguage).toBe('de');
  });

  test('a body without auth blocks is saved and keeps them', async () => {
    const res = await save(LOCAL_ADMIN, { defaultLanguage: 'de' });

    expect(res.status).toBe(200);
    expect(JSON.parse(await readText('platform.json')).localAuth.enabled).toBe(true);
  });

  test('a human caller whose sign-in route is unknown is refused (fails closed)', async () => {
    const res = await save(
      { id: 'x', groups: ['admins'], isAdmin: true },
      { ...BASE_PLATFORM, proxyAuth: { enabled: true } }
    );

    expect(res.status).toBe(409);
  });

  test('an unreadable users.json refuses the save with ADMIN_CHECK_FAILED', async () => {
    await fs.writeFile(file('users.json'), '{ not json');
    const before = await readText('platform.json');

    const res = await save(LOCAL_ADMIN, { ...BASE_PLATFORM, proxyAuth: { enabled: true } });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('ADMIN_CHECK_FAILED');
    expect(await readText('platform.json')).toBe(before);
  });

  test('an anonymous caller never reaches the guard (real adminAuth)', async () => {
    const before = await readText('platform.json');

    const res = await save(
      { id: 'anonymous', name: 'Anonymous', groups: ['admins'] },
      { ...BASE_PLATFORM, localAuth: { enabled: false } }
    );

    expect(res.status).toBe(403);
    expect(await readText('platform.json')).toBe(before);
  });
});

describe('platform rollback lockout guard', () => {
  test('rolling back to a snapshot with local sign-in off is refused for a local admin', async () => {
    state.snapshot = {
      ts: '2026-01-01T00:00:00.000Z',
      before: { ...BASE_PLATFORM, localAuth: { enabled: false } }
    };
    const before = await readText('platform.json');

    const res = await request(appFor(LOCAL_ADMIN)).post(
      '/api/admin/changes/platform/platform/snap.json/rollback'
    );

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AUTH_LOCKOUT');
    expect(await readText('platform.json')).toBe(before);
  });
});

describe('assertPlatformChangeKeepsAccess', () => {
  test('a machine caller skips the own-route check but not the admin check', async () => {
    const machine = { id: 'client_ci', authMode: 'oauth_client_credentials', isOAuthClient: true };
    // Proxy on, nothing else lost: allowed for a machine caller.
    await expect(
      assertPlatformChangeKeepsAccess(machine, BASE_PLATFORM, {
        ...BASE_PLATFORM,
        proxyAuth: { enabled: true }
      })
    ).resolves.toBeUndefined();
    // Turning off the only admin's method: refused.
    await expect(
      assertPlatformChangeKeepsAccess(machine, BASE_PLATFORM, {
        ...BASE_PLATFORM,
        localAuth: { enabled: false }
      })
    ).rejects.toMatchObject({ code: 'AUTH_LOCKOUT', status: 409 });
  });
});
