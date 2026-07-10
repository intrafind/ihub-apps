/**
 * Regression tests for #1763: concurrent admin saves to platform.json.
 *
 * GET /api/admin/configs/platform now returns a `_version` content-hash of
 * the on-disk config. POST /api/admin/configs/platform accepts that value
 * back as `_baseVersion` (or `_version`) and rejects the save with 409 if the
 * on-disk config has changed since it was read, instead of silently
 * overwriting a concurrent admin's change (the "last write wins" bug the
 * issue describes). Callers that don't send a base version keep the previous
 * unchecked behavior, so unmigrated admin pages are unaffected.
 *
 * Note: The repo's source is native ESM (uses `import.meta.url`), so this
 * file uses `jest.unstable_mockModule` + dynamic imports rather than the
 * CommonJS-only `jest.mock` API. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const mockAdminUser = {
  id: 'admin-user',
  username: 'admin',
  groups: ['admin']
};

const mockGroups = {
  admin: {
    id: 'admin',
    permissions: { adminAccess: true }
  }
};

// Mutable holder so each test can point getRootDir() at a fresh temp root
// without re-registering the mock factory.
const state = { rootDir: os.tmpdir() };

jest.unstable_mockModule('../pathUtils.js', () => ({
  getRootDir: () => state.rootDir
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    refreshCacheEntry: async () => {},
    getPlatform: () => ({})
  }
}));

jest.unstable_mockModule('../services/TokenStorageService.js', () => ({
  default: {
    isEncrypted: () => false,
    encryptString: value => value,
    decryptString: value => value
  }
}));

jest.unstable_mockModule('../middleware/oidcAuth.js', () => ({
  reconfigureOidcProviders: () => {}
}));

jest.unstable_mockModule('../websocket/realtimeTranscription.js', () => ({
  testRealtimeConnection: async () => ({ ok: true })
}));

jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: async () => {}
}));

jest.unstable_mockModule('../services/ChangeHistoryService.js', () => ({
  saveSnapshot: async () => {}
}));

jest.unstable_mockModule('../utils/authorization.js', () => ({
  loadGroupsConfiguration: () => ({ groups: mockGroups }),
  enhanceUserWithPermissions: user => user,
  isAnonymousAccessAllowed: () => false
}));

const { default: registerAdminConfigRoutes } = await import('../routes/admin/configs.js');

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = mockAdminUser;
    next();
  });
  registerAdminConfigRoutes(app);
  return app;
}

async function readPlatformConfig(tmpRoot) {
  const raw = await fs.readFile(path.join(tmpRoot, 'contents', 'config', 'platform.json'), 'utf8');
  return JSON.parse(raw);
}

describe('Admin platform config optimistic concurrency (#1763)', () => {
  let tmpRoot;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-platform-config-'));
    await fs.mkdir(path.join(tmpRoot, 'contents', 'config'), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, 'contents', 'config', 'platform.json'),
      JSON.stringify({ auth: { mode: 'local' }, anonymousAuth: { enabled: false } }, null, 2)
    );
    state.rootDir = tmpRoot;
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  test('GET returns a non-empty _version content hash', async () => {
    const app = createTestApp();
    const response = await request(app).get('/api/admin/configs/platform');

    expect(response.status).toBe(200);
    expect(typeof response.body._version).toBe('string');
    expect(response.body._version.length).toBeGreaterThan(0);
  });

  test('_version is computed from the sanitized config, not raw secret material', async () => {
    // Regression test for a CodeQL "hash of insufficiently protected secret"
    // finding: the version must be derived from the redacted view (every real
    // secret collapses to the same '***REDACTED***' placeholder) so two
    // configs that differ only in their raw secret value hash identically,
    // proving the raw secret never flows into the hash.
    await fs.writeFile(
      path.join(tmpRoot, 'contents', 'config', 'platform.json'),
      JSON.stringify({ auth: { mode: 'local', jwtSecret: 'super-secret-value-one' } }, null, 2)
    );
    const app = createTestApp();
    const first = await request(app).get('/api/admin/configs/platform');
    expect(first.body.auth.jwtSecret).toBe('***REDACTED***');

    await fs.writeFile(
      path.join(tmpRoot, 'contents', 'config', 'platform.json'),
      JSON.stringify(
        { auth: { mode: 'local', jwtSecret: 'a-totally-different-secret-value' } },
        null,
        2
      )
    );
    const second = await request(app).get('/api/admin/configs/platform');

    expect(second.body._version).toBe(first.body._version);
  });

  test('POST without a base version overwrites unconditionally (back-compat)', async () => {
    const app = createTestApp();

    const first = await request(app)
      .post('/api/admin/configs/platform')
      .send({ auth: { mode: 'local' }, anonymousAuth: { enabled: true } });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/api/admin/configs/platform')
      .send({ auth: { mode: 'proxy' }, anonymousAuth: { enabled: false } });
    expect(second.status).toBe(200);

    const onDisk = await readPlatformConfig(tmpRoot);
    expect(onDisk.auth.mode).toBe('proxy');
  });

  test('POST with a stale base version is rejected with 409 and does not clobber the winning save', async () => {
    const app = createTestApp();

    const loaded = await request(app).get('/api/admin/configs/platform');
    const baseVersion = loaded.body._version;

    // Admin tab A saves first, based on the same version, changing a value.
    const saveA = await request(app)
      .post('/api/admin/configs/platform')
      .send({
        auth: { mode: 'local' },
        anonymousAuth: { enabled: true },
        _baseVersion: baseVersion
      });
    expect(saveA.status).toBe(200);
    expect(saveA.body.config._version).not.toBe(baseVersion);

    // Admin tab B, still holding the config it loaded before A's save, tries
    // to save based on the now-stale version.
    const saveB = await request(app)
      .post('/api/admin/configs/platform')
      .send({
        auth: { mode: 'oidc' },
        anonymousAuth: { enabled: false },
        _baseVersion: baseVersion
      });

    expect(saveB.status).toBe(409);
    expect(saveB.body.error).toBe('conflict');
    expect(saveB.body.config._version).toBe(saveA.body.config._version);

    // B's change must not have overwritten A's already-persisted save.
    const onDisk = await readPlatformConfig(tmpRoot);
    expect(onDisk.auth.mode).toBe('local');
    expect(onDisk.anonymousAuth.enabled).toBe(true);
  });

  test('POST with the current base version succeeds and returns a fresh version', async () => {
    const app = createTestApp();

    const loaded = await request(app).get('/api/admin/configs/platform');
    const baseVersion = loaded.body._version;

    const save = await request(app)
      .post('/api/admin/configs/platform')
      .send({
        auth: { mode: 'proxy' },
        anonymousAuth: { enabled: false },
        _baseVersion: baseVersion
      });

    expect(save.status).toBe(200);
    expect(save.body.config._version).toBeTruthy();
    expect(save.body.config._version).not.toBe(baseVersion);

    const onDisk = await readPlatformConfig(tmpRoot);
    expect(onDisk.auth.mode).toBe('proxy');
    expect(onDisk._version).toBeUndefined();
    expect(onDisk._baseVersion).toBeUndefined();
  });
});
