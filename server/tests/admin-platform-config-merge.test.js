/**
 * Regression tests for the platform config save path.
 *
 * POST /api/admin/configs/platform rebuilds the file from an explicit
 * allowlist of sections spread over `...existingConfig`. Any section missing
 * from that allowlist is silently dropped from the request: the endpoint
 * answers 200 while the on-disk value stays as it was, so the admin UI
 * appears to save and then reverts on reload.
 *
 * `mcpServer` (Admin → MCP gateway) and `globalPromptVariables`
 * (Admin → Prompts → Variables) are edited through this generic endpoint
 * rather than a dedicated route, so they must round-trip.
 *
 * `proxyAuth.sharedSecretHeader` is removed from every request at runtime, so
 * a save naming a header that sign-in or request handling needs is refused.
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

const state = { rootDir: null };

jest.unstable_mockModule('../pathUtils.js', () => ({
  getRootDir: () => state.rootDir
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    refreshCacheEntry: async () => {},
    getPlatform: () => ({})
  }
}));

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => next()
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
  saveSnapshot: async () => {}
}));

const { default: registerAdminConfigRoutes } = await import('../routes/admin/configs.js');

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: 'admin-user', username: 'admin', groups: ['admin'] };
    next();
  });
  registerAdminConfigRoutes(app);
  return app;
}

const platformPath = () => path.join(state.rootDir, 'contents', 'config', 'platform.json');

async function readPlatform() {
  return JSON.parse(await fs.readFile(platformPath(), 'utf8'));
}

describe('POST /api/admin/configs/platform section persistence', () => {
  beforeEach(async () => {
    state.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-platform-cfg-'));
    await fs.mkdir(path.join(state.rootDir, 'contents', 'config'), { recursive: true });
    await fs.writeFile(
      platformPath(),
      JSON.stringify(
        {
          auth: { mode: 'local' },
          oauth: { enabled: { authz: false, clients: false } },
          mcpServer: {
            enabled: false,
            requireConsent: true,
            expose: { tools: true, apps: true, workflows: true, resources: false }
          },
          proxyAuth: {
            enabled: true,
            jwtProviders: [
              { name: 'sso', header: 'X-Token', jwkUrl: 'https://sso.example.com/jwks' }
            ]
          },
          globalPromptVariables: {
            context: 'The current date is {{date}}.',
            variables: {}
          }
        },
        null,
        2
      )
    );
  });

  afterEach(async () => {
    await fs.rm(state.rootDir, { recursive: true, force: true });
  });

  test('persists mcpServer.enabled instead of silently keeping the on-disk value', async () => {
    const app = createTestApp();
    const existing = await readPlatform();

    const response = await request(app)
      .post('/api/admin/configs/platform')
      .send({ ...existing, mcpServer: { ...existing.mcpServer, enabled: true } });

    expect(response.status).toBe(200);
    // The actual regression: a 200 with the old value still on disk.
    expect((await readPlatform()).mcpServer.enabled).toBe(true);
  });

  test('persists nested mcpServer fields (expose / publicUrl)', async () => {
    const app = createTestApp();
    const existing = await readPlatform();

    await request(app)
      .post('/api/admin/configs/platform')
      .send({
        ...existing,
        mcpServer: {
          ...existing.mcpServer,
          enabled: true,
          publicUrl: 'https://ihub.example.com',
          expose: { ...existing.mcpServer.expose, resources: true }
        }
      });

    const saved = await readPlatform();
    expect(saved.mcpServer.publicUrl).toBe('https://ihub.example.com');
    expect(saved.mcpServer.expose.resources).toBe(true);
    expect(saved.mcpServer.expose.tools).toBe(true);
  });

  test('keeps the existing mcpServer section when the request omits it', async () => {
    const app = createTestApp();
    const { mcpServer: _omitted, ...withoutGateway } = await readPlatform();

    await request(app).post('/api/admin/configs/platform').send(withoutGateway);

    const saved = await readPlatform();
    expect(saved.mcpServer).toBeDefined();
    expect(saved.mcpServer.enabled).toBe(false);
    expect(saved.mcpServer.requireConsent).toBe(true);
  });

  test('persists the oauth section alongside the gateway (single save from the MCP page)', async () => {
    const app = createTestApp();
    const existing = await readPlatform();

    await request(app)
      .post('/api/admin/configs/platform')
      .send({
        ...existing,
        mcpServer: { ...existing.mcpServer, enabled: true },
        oauth: {
          ...existing.oauth,
          enabled: { authz: true, clients: true },
          authorizationCodeEnabled: true,
          refreshTokenEnabled: true,
          dcr: { enabled: true, maxClients: 100 }
        }
      });

    const saved = await readPlatform();
    expect(saved.mcpServer.enabled).toBe(true);
    expect(saved.oauth.enabled.authz).toBe(true);
    expect(saved.oauth.dcr.enabled).toBe(true);
  });

  test('persists globalPromptVariables (edited context and a new custom variable)', async () => {
    const app = createTestApp();
    const existing = await readPlatform();

    const response = await request(app)
      .post('/api/admin/configs/platform')
      .send({
        ...existing,
        globalPromptVariables: {
          context: 'The current date is {{date}}. Company: {{company}}.',
          variables: { company: 'ACME Corp' }
        }
      });

    expect(response.status).toBe(200);
    expect((await readPlatform()).globalPromptVariables).toEqual({
      context: 'The current date is {{date}}. Company: {{company}}.',
      variables: { company: 'ACME Corp' }
    });
  });

  test('keeps the existing globalPromptVariables when the request omits them', async () => {
    const app = createTestApp();
    const { globalPromptVariables: _omitted, ...withoutVariables } = await readPlatform();

    await request(app).post('/api/admin/configs/platform').send(withoutVariables);

    expect((await readPlatform()).globalPromptVariables).toEqual({
      context: 'The current date is {{date}}.',
      variables: {}
    });
  });

  test('a save carrying only globalPromptVariables leaves every other section as stored', async () => {
    const app = createTestApp();
    const before = await readPlatform();
    const globalPromptVariables = {
      context: 'Company: {{company}}.',
      variables: { company: 'ACME' }
    };

    const response = await request(app)
      .post('/api/admin/configs/platform')
      .send({ globalPromptVariables });

    expect(response.status).toBe(200);
    const saved = await readPlatform();
    expect(saved.globalPromptVariables).toEqual(globalPromptVariables);
    // The admin read leaves `jwkUrl` out, so it survives only when the save omits `proxyAuth`.
    expect(saved.proxyAuth).toEqual(before.proxyAuth);
    expect(saved.mcpServer).toEqual(before.mcpServer);
    expect(saved.auth).toEqual(before.auth);
    expect(saved.oauth).toEqual(before.oauth);
  });
});

describe('POST /api/admin/configs/platform proxyAuth.sharedSecretHeader', () => {
  const stored = {
    auth: { mode: 'proxy' },
    proxyAuth: {
      enabled: true,
      userHeader: 'X-Remote-User',
      jwtProviders: [{ name: 'sso', header: 'X-Token', jwkUrl: 'https://sso.example.com/jwks' }]
    }
  };

  beforeEach(async () => {
    state.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-platform-cfg-'));
    await fs.mkdir(path.join(state.rootDir, 'contents', 'config'), { recursive: true });
    await fs.writeFile(platformPath(), JSON.stringify(stored, null, 2));
  });

  afterEach(async () => {
    await fs.rm(state.rootDir, { recursive: true, force: true });
  });

  test.each(['Authorization', 'X-Forwarded-Email', 'X-Remote-User', 'x-token', 'X Secret'])(
    'refuses %s and leaves the file as stored',
    async sharedSecretHeader => {
      const response = await request(createTestApp())
        .post('/api/admin/configs/platform')
        .send({ ...stored, proxyAuth: { ...stored.proxyAuth, sharedSecretHeader } });

      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).toContain('proxyAuth.sharedSecretHeader');
      expect(await readPlatform()).toEqual(stored);
    }
  );

  test('saves a header name nothing else reads', async () => {
    const response = await request(createTestApp())
      .post('/api/admin/configs/platform')
      .send({ ...stored, proxyAuth: { ...stored.proxyAuth, sharedSecretHeader: 'X-Gate' } });

    expect(response.status).toBe(200);
    expect((await readPlatform()).proxyAuth.sharedSecretHeader).toBe('X-Gate');
  });
});
