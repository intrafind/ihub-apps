/**
 * The admin configuration pages must not render an unreadable file as an
 * empty one.
 *
 * `configStore.readJson` folds absent, unreadable and malformed into one
 * `null`, and both of these handlers used to read that as "not configured
 * yet". A `platform.json` or `groups.json` with a trailing comma in it
 * therefore rendered as a fresh installation — no providers, no groups, no
 * permissions — which is the one reading that is not true, and the first thing
 * such a page invites is a Save.
 *
 * The save path already fails closed. These are the reads in front of it.
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

// Seeded before the dynamic imports below: `TokenStorageService` resolves its
// key path at import time, so `getRootDir()` is called once before any test
// runs and must already answer with a directory.
const state = { rootDir: mkdtempSync(path.join(os.tmpdir(), 'ihub-admin-read-boot-')) };

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

// No provider, so ConfigStore takes its filesystem path under the mocked root.
jest.unstable_mockModule('../storage/bootstrap.js', () => ({
  getStorage: () => null
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getGroups: () => ({ data: { groups: {} } }),
    refreshCacheEntry: async () => {},
    refreshAppsCache: async () => {},
    refreshPromptsCache: async () => {},
    refreshModelsCache: async () => {},
    getPlatform: () => ({ data: {} })
  }
}));

jest.unstable_mockModule('../middleware/oidcAuth.js', () => ({
  reconfigureOidcProviders: async () => {}
}));

jest.unstable_mockModule('../websocket/realtimeTranscription.js', () => ({
  testRealtimeConnection: async () => ({ ok: true })
}));

const { default: registerAdminConfigRoutes } = await import('../routes/admin/configs.js');
const { default: registerAdminGroupRoutes } = await import('../routes/admin/groups.js');

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: 'admin-user', username: 'admin', groups: ['admin'] };
    next();
  });
  registerAdminConfigRoutes(app);
  registerAdminGroupRoutes(app);
  return app;
}

const configPath = name => path.join(state.rootDir, 'contents', 'config', name);

const created = [state.rootDir];

beforeEach(async () => {
  state.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-admin-read-'));
  created.push(state.rootDir);
  await fs.mkdir(path.join(state.rootDir, 'contents', 'config'), { recursive: true });
});

afterAll(async () => {
  for (const dir of created) await fs.rm(dir, { recursive: true, force: true });
});

describe('GET /api/admin/configs/platform', () => {
  it('reports a platform.json that cannot be parsed instead of answering with defaults', async () => {
    await fs.writeFile(configPath('platform.json'), '{ "auth": { "mode": "oidc", } }');

    const response = await request(createTestApp()).get('/api/admin/configs/platform');

    expect(response.status).toBe(500);
  });

  it('still answers with defaults when the file is genuinely absent', async () => {
    const response = await request(createTestApp()).get('/api/admin/configs/platform');

    expect(response.status).toBe(200);
    expect(response.body.auth.mode).toBe('local');
  });

  it('answers with the stored configuration when the file is fine', async () => {
    await fs.writeFile(
      configPath('platform.json'),
      JSON.stringify({ auth: { mode: 'proxy' }, features: { magicPrompt: true } }, null, 2)
    );

    const response = await request(createTestApp()).get('/api/admin/configs/platform');

    expect(response.status).toBe(200);
    expect(response.body.auth.mode).toBe('proxy');
  });
});

describe('GET /api/admin/groups', () => {
  it('reports a groups.json that cannot be parsed instead of answering with no groups', async () => {
    await fs.writeFile(configPath('groups.json'), '{ "groups": { "admin": {}, } }');

    const response = await request(createTestApp()).get('/api/admin/groups');

    expect(response.status).toBe(500);
  });

  it('still answers with an empty list when the file is genuinely absent', async () => {
    const response = await request(createTestApp()).get('/api/admin/groups');

    expect(response.status).toBe(200);
    expect(response.body.groups).toEqual({});
  });

  it('answers with the stored groups when the file is fine', async () => {
    await fs.writeFile(
      configPath('groups.json'),
      JSON.stringify({ groups: { editors: { id: 'editors' } }, metadata: {} }, null, 2)
    );

    const response = await request(createTestApp()).get('/api/admin/groups');

    expect(response.status).toBe(200);
    expect(Object.keys(response.body.groups)).toEqual(['editors']);
  });
});
