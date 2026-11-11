// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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

const auditEntries = [];
jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: async entry => {
    auditEntries.push({ ...entry, req: undefined });
  }
}));

jest.unstable_mockModule('../services/ChangeHistoryService.js', () => ({
  saveSnapshot: async () => {}
}));

const { default: registerAdminConfigRoutes } = await import('../routes/admin/configs.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: 'admin-user', username: 'admin', groups: ['admins'] };
    next();
  });
  registerAdminConfigRoutes(app);
  app.use(errorHandler);
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

  test('persists speech.voiceMode (Admin → Voice Input → Voice mode), prompt included', async () => {
    const app = createTestApp();
    const existing = await readPlatform();
    const voiceMode = {
      enabled: true,
      appDefault: true,
      ttsModelId: 'voxtral-mini-tts',
      listeningStyle: 'push-to-talk',
      bargeIn: false,
      endOfTurnSilenceMs: 1200,
      thinkingLevel: 'minimal',
      maxSessionMinutes: 45,
      systemPrompt: { en: 'Be brief.', de: 'Fasse dich kurz.' }
    };

    const response = await request(app)
      .post('/api/admin/configs/platform')
      .send({ ...existing, speech: { defaultService: 'browser', voiceMode } });

    expect(response.status).toBe(200);
    expect((await readPlatform()).speech.voiceMode).toEqual(voiceMode);
  });

  test('keeps the stored speech.voiceMode when a save omits speech', async () => {
    const voiceMode = { enabled: true, appDefault: false, systemPrompt: { de: 'Kurz.' } };
    await fs.writeFile(
      platformPath(),
      JSON.stringify({ ...(await readPlatform()), speech: { voiceMode } })
    );
    const app = createTestApp();
    const { speech: _omitted, ...withoutSpeech } = await readPlatform();

    await request(app).post('/api/admin/configs/platform').send(withoutSpeech);

    expect((await readPlatform()).speech.voiceMode).toEqual(voiceMode);
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

  test('a save carrying only toolApproval stores it and leaves proxyAuth (jwkUrl) as stored', async () => {
    const app = createTestApp();
    const before = await readPlatform();

    const response = await request(app)
      .post('/api/admin/configs/platform')
      .send({ toolApproval: { defaults: { external: 'writes' } } });

    expect(response.status).toBe(200);
    const saved = await readPlatform();
    expect(saved.toolApproval).toEqual({ defaults: { external: 'writes' } });
    expect(saved.proxyAuth).toEqual(before.proxyAuth);
  });

  test('a save carrying only cookieSettings stores it and leaves proxyAuth (jwkUrl) as stored', async () => {
    const app = createTestApp();
    const before = await readPlatform();

    const response = await request(app)
      .post('/api/admin/configs/platform')
      .send({ cookieSettings: { disableSecure: true } });

    expect(response.status).toBe(200);
    const saved = await readPlatform();
    expect(saved.cookieSettings).toEqual({ disableSecure: true });
    expect(saved.proxyAuth).toEqual(before.proxyAuth);
  });

  test('keeps the stored cookieSettings when a save omits them', async () => {
    const app = createTestApp();
    await request(app)
      .post('/api/admin/configs/platform')
      .send({ cookieSettings: { disableSecure: true } })
      .expect(200);
    await request(app)
      .post('/api/admin/configs/platform')
      .send({ defaultLanguage: 'de' })
      .expect(200);
    expect((await readPlatform()).cookieSettings).toEqual({ disableSecure: true });
  });

  test('refuses cookieSettings that are not an object with a boolean disableSecure', async () => {
    const app = createTestApp();
    for (const bad of [null, 'yes', ['x'], { disableSecure: 'true' }]) {
      const response = await request(app)
        .post('/api/admin/configs/platform')
        .send({ cookieSettings: bad });
      expect(response.status).toBe(400);
    }
  });

  test('toolApproval: null removes the block instead of storing null', async () => {
    const app = createTestApp();
    await request(app)
      .post('/api/admin/configs/platform')
      .send({ toolApproval: { defaults: { default: 'always' } } });
    expect((await readPlatform()).toolApproval).toEqual({ defaults: { default: 'always' } });

    const response = await request(app)
      .post('/api/admin/configs/platform')
      .send({ toolApproval: null });

    expect(response.status).toBe(200);
    expect(Object.hasOwn(await readPlatform(), 'toolApproval')).toBe(false);
  });

  test.each([{ defaults: null }, { defaults: { external: null } }])(
    'refuses the toolApproval block %j the platform schema rejects',
    async toolApproval => {
      const before = await readPlatform();
      const response = await request(createTestApp())
        .post('/api/admin/configs/platform')
        .send({ toolApproval });

      expect(response.status).toBe(400);
      expect(await readPlatform()).toEqual(before);
    }
  );
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
      expect(response.body.code).toBe('BAD_REQUEST');
      expect(response.body.detail).toContain('proxyAuth.sharedSecretHeader');
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

describe('POST /api/admin/configs/platform answers refusals in the shared shape', () => {
  beforeEach(async () => {
    state.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-platform-cfg-errors-'));
    await fs.mkdir(path.join(state.rootDir, 'contents', 'config'), { recursive: true });
    await fs.writeFile(platformPath(), JSON.stringify({ auth: { mode: 'local' } }));
  });

  afterEach(async () => {
    await fs.rm(state.rootDir, { recursive: true, force: true });
  });

  test("a request without a body is BAD_REQUEST with the route's own message", async () => {
    // No body: the JSON parser leaves `req.body` unset and the route refuses it.
    const response = await request(createTestApp()).post('/api/admin/configs/platform');

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('BAD_REQUEST');
    expect(response.body.detail).toBe('Invalid configuration data');
  });

  test('a default language that is not a language code is BAD_REQUEST and stores nothing', async () => {
    const response = await request(createTestApp())
      .post('/api/admin/configs/platform')
      .send({ defaultLanguage: '../../etc/passwd' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'BAD_REQUEST' });
    expect(response.body.detail).toContain('defaultLanguage');
    expect(await readPlatform()).toEqual({ auth: { mode: 'local' } });
  });
});

describe('POST /api/admin/configs/platform provenance block', () => {
  const stored = {
    auth: { mode: 'local' },
    chats: { enabled: true, retentionDays: 90 },
    provenance: {
      retentionDays: 365,
      storeRecords: true,
      verify: { access: 'authenticated', futureFlag: 'keep' },
      media: { maxVerifyBytes: 52428800, readC2pa: true, extra: 1 },
      watermark: { alpha: 0.001, minScoredTokens: 300 },
      somethingElse: { nested: true }
    }
  };

  beforeEach(async () => {
    auditEntries.length = 0;
    state.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-platform-prov-'));
    await fs.mkdir(path.join(state.rootDir, 'contents', 'config'), { recursive: true });
    await fs.writeFile(platformPath(), JSON.stringify(stored, null, 2));
  });
  afterEach(async () => {
    await fs.rm(state.rootDir, { recursive: true, force: true });
  });

  const post = body => request(createTestApp()).post('/api/admin/configs/platform').send(body);

  test('a partial provenance body changes its keys and keeps every other key, nested ones too', async () => {
    const res = await post({
      provenance: {
        retentionDays: 30,
        verify: { access: 'public' },
        media: { readC2pa: false },
        watermark: { minScoredTokens: 500 }
      }
    });
    expect(res.status).toBe(200);
    const saved = await readPlatform();
    expect(saved.chats).toEqual(stored.chats);
    expect(saved.provenance).toEqual({
      retentionDays: 30,
      storeRecords: true,
      verify: { access: 'public', futureFlag: 'keep' },
      media: { maxVerifyBytes: 52428800, readC2pa: false, extra: 1 },
      watermark: { alpha: 0.001, minScoredTokens: 500 },
      somethingElse: { nested: true }
    });
  });

  test('null on a watermark tunable removes it (code default again); an emptied block is dropped', async () => {
    await post({ provenance: { watermark: { alpha: null, minScoredTokens: null } } });
    const saved = await readPlatform();
    expect(saved.provenance.watermark).toBeUndefined();
  });

  test('a body without provenance leaves the block untouched', async () => {
    await post({ chats: { enabled: false } });
    expect((await readPlatform()).provenance).toEqual(stored.provenance);
  });

  test.each([
    [{ retentionDays: -1 }, 'retentionDays'],
    [{ retentionDays: 1.5 }, 'retentionDays'],
    [{ retentionDays: 36501 }, 'retentionDays'],
    [{ retentionDays: '30' }, 'retentionDays'],
    [{ storeRecords: 'yes' }, 'storeRecords'],
    [{ verify: { access: 'everyone' } }, 'verify.access'],
    [{ media: { maxVerifyBytes: 10 } }, 'media.maxVerifyBytes'],
    [{ media: { maxVerifyBytes: 2 * 1024 * 1024 * 1024 } }, 'media.maxVerifyBytes'],
    [{ watermark: { alpha: 0 } }, 'watermark.alpha'],
    [{ watermark: { alpha: 1 } }, 'watermark.alpha'],
    [{ watermark: { minScoredTokens: 0 } }, 'watermark.minScoredTokens'],
    [{ watermark: { detectorTimeoutMs: 999 } }, 'watermark.detectorTimeoutMs'],
    [{ watermark: { detectorTimeoutMs: 120001 } }, 'watermark.detectorTimeoutMs']
  ])('rejects %j with 400 naming %s and writes nothing', async (provenance, field) => {
    const res = await post({ provenance });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain(field);
    expect((await readPlatform()).provenance).toEqual(stored.provenance);
    expect(auditEntries).toHaveLength(0);
  });

  test('accepts the bounds themselves', async () => {
    const res = await post({
      provenance: {
        retentionDays: 0,
        media: { maxVerifyBytes: 1024 },
        watermark: { alpha: 0.5, minScoredTokens: 1, detectorTimeoutMs: 120000 }
      }
    });
    expect(res.status).toBe(200);
  });

  test('a legacy stored block sent back unchanged is not re-validated', async () => {
    const legacy = { ...stored, provenance: { ...stored.provenance, retentionDays: -5 } };
    await fs.writeFile(platformPath(), JSON.stringify(legacy));
    const res = await post({ ...legacy, chats: { enabled: false } });
    expect(res.status).toBe(200);
    expect((await readPlatform()).provenance.retentionDays).toBe(-5);
  });

  test('a change is audit-logged with old and new values; no change writes no provenance entry', async () => {
    await post({ provenance: { retentionDays: 30, verify: { access: 'public' } } });
    const entry = auditEntries.find(e => e.resource === 'provenanceSettings');
    expect(entry).toMatchObject({ action: 'update', resourceId: 'settings' });
    expect(entry.details.changed).toEqual([
      { key: 'retentionDays', from: 365, to: 30 },
      { key: 'verify.access', from: 'authenticated', to: 'public' }
    ]);

    auditEntries.length = 0;
    await post({ provenance: { retentionDays: 30 } });
    expect(auditEntries.find(e => e.resource === 'provenanceSettings')).toBeUndefined();
  });
});
