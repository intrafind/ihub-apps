// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `PATCH /api/admin/configs/platform` (decision 6): a JSON Merge Patch (RFC
 * 7396) over the sections the POST may change, through the same writer as the
 * POST — same validators, secret restore, marker refusal, lockout invariant,
 * If-Match, snapshot and audit — so it can never become the way around them.
 *
 * Sections with their own validated routes (ssl, ssrf, cors, rateLimit, proxy,
 * logging) and unknown keys are refused with 400 `VALIDATION_FAILED` and
 * `errors[].pointer`.
 *
 * Real ConfigStore and adminAuth on a temporary contents directory.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const state = { rootDir: null };
const auditEntries = [];
const snapshots = [];

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

const reconfigureOidcProviders = jest.fn();
jest.unstable_mockModule('../middleware/oidcAuth.js', () => ({
  reconfigureOidcProviders
}));

const clearExchangedTokenCache = jest.fn();
jest.unstable_mockModule('../services/integrations/iFinderTokenProvider.js', () => ({
  clearExchangedTokenCache
}));

jest.unstable_mockModule('../services/TokenStorageService.js', () => ({
  default: {
    encryptionKey: 'test',
    initializeEncryptionKey: async () => {},
    isEncrypted: v => typeof v === 'string' && v.startsWith('ENC['),
    encryptString: v => `ENC[${v}]`,
    decryptString: v => v.slice(4, -1)
  }
}));

jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: async entry => {
    auditEntries.push({ ...entry, req: undefined });
  }
}));

jest.unstable_mockModule('../services/ChangeHistoryService.js', () => ({
  saveSnapshot: async snapshot => {
    snapshots.push(snapshot);
  }
}));

const { default: registerAdminConfigRoutes } = await import('../routes/admin/configs.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const LOCAL_ADMIN = {
  id: 'user_local',
  username: 'admin',
  groups: ['admins'],
  authMode: 'local',
  isAdmin: true
};

const PLATFORM = {
  defaultLanguage: 'en',
  auth: { mode: 'local', jwtSecret: 'auth-secret' },
  anonymousAuth: { enabled: false },
  localAuth: { enabled: true, jwtSecret: 'local-secret', sessionTimeoutMinutes: 480 },
  oidcAuth: { enabled: false, providers: [] },
  ldapAuth: { enabled: false, providers: [] },
  ntlmAuth: { enabled: false },
  proxyAuth: {
    enabled: false,
    jwtProviders: [
      { name: 'a', header: 'X-A', jwkUrl: 'https://a.example.com/jwks' },
      { name: 'b', header: 'X-B', jwkUrl: 'https://b.example.com/jwks' }
    ]
  },
  speech: { azure: { region: 'westeurope', subscriptionKey: 'ENC[speech-key]' } },
  telemetry: { enabled: false, exporter: { endpoint: 'http://otel:4318' } },
  toolApproval: { defaults: { external: 'writes' } },
  ssl: { ignoreInvalidCertificates: false, domainWhitelist: [] },
  cors: { origin: ['https://a.example.com'] },
  logging: { level: 'info' }
};

const GROUPS = {
  groups: { admins: { id: 'admins', name: 'Admins', permissions: { adminAccess: true } } }
};
const USERS = {
  users: {
    user_local: {
      id: 'user_local',
      username: 'admin',
      active: true,
      authMethods: ['local'],
      passwordHash: 'hash',
      internalGroups: ['admins']
    }
  }
};

const file = name => path.join(state.rootDir, 'contents', 'config', name);
const writeConfig = (name, data) => fs.writeFile(file(name), JSON.stringify(data, null, 2));
const readText = () => fs.readFile(file('platform.json'), 'utf8');
const readPlatform = async () => JSON.parse(await readText());

function appFor(user) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  registerAdminConfigRoutes(app);
  app.use(errorHandler);
  return app;
}

const patch = (body, options = {}) => {
  const { ifMatch } = options;
  const user = Object.hasOwn(options, 'user') ? options.user : LOCAL_ADMIN;
  const call = request(appFor(user)).patch('/api/admin/configs/platform');
  if (ifMatch !== undefined) call.set('If-Match', ifMatch);
  return call.send(body);
};

beforeEach(async () => {
  reconfigureOidcProviders.mockClear();
  clearExchangedTokenCache.mockClear();
  auditEntries.length = 0;
  snapshots.length = 0;
  state.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-patch-'));
  await fs.mkdir(path.join(state.rootDir, 'contents', 'config'), { recursive: true });
  await writeConfig('platform.json', PLATFORM);
  await writeConfig('groups.json', GROUPS);
  await writeConfig('users.json', USERS);
});

afterEach(async () => {
  await fs.rm(state.rootDir, { recursive: true, force: true });
});

describe('PATCH /api/admin/configs/platform: merge semantics', () => {
  test('a telemetry patch changes only telemetry; every other key stays as stored', async () => {
    const response = await patch({ telemetry: { enabled: true } });

    expect(response.status).toBe(200);
    const { telemetry, ...rest } = await readPlatform();
    const { telemetry: _before, ...restBefore } = PLATFORM;
    expect(telemetry).toEqual({ enabled: true, exporter: { endpoint: 'http://otel:4318' } });
    expect(rest).toEqual(restBefore);
  });

  test('answers with the configuration as the read shows it, and the new ETag', async () => {
    const response = await patch({ setup: { disabled: true } });

    expect(response.status).toBe(200);
    expect(response.headers.etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(response.body.setup).toEqual({ disabled: true });
    expect(response.body.auth.jwtSecret).toBe('***REDACTED***');
    expect(response.body.config).toBeUndefined();
  });

  test('null removes a non-secret member', async () => {
    await patch({ localAuth: { sessionTimeoutMinutes: null } }).expect(200);

    expect((await readPlatform()).localAuth).toEqual({ enabled: true, jwtSecret: 'local-secret' });
  });

  test('a patch that does not name the secret keeps it', async () => {
    await patch({ localAuth: { enabled: true, sessionTimeoutMinutes: 60 } }).expect(200);

    expect((await readPlatform()).localAuth.jwtSecret).toBe('local-secret');
  });

  test('the marker on a secret keeps the stored secret', async () => {
    await patch({ auth: { jwtSecret: '***REDACTED***', mode: 'local' } }).expect(200);

    expect((await readPlatform()).auth.jwtSecret).toBe('auth-secret');
  });

  test('null on the secret itself clears it; a new value replaces it (encrypted where stored encrypted)', async () => {
    await patch({ auth: { jwtSecret: null } }).expect(200);
    expect((await readPlatform()).auth).toEqual({ mode: 'local' });

    await patch({ speech: { azure: { subscriptionKey: 'rotated' } } }).expect(200);
    expect((await readPlatform()).speech.azure.subscriptionKey).toBe('ENC[rotated]');
  });

  test('null on an object that holds a secret is refused', async () => {
    const before = await readText();

    const response = await patch({ speech: { azure: null } });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(response.body.errors).toEqual([
      expect.objectContaining({ pointer: '/speech/azure', code: 'null_not_allowed' })
    ]);
    expect(await readText()).toBe(before);
  });

  test('null on a whole section is refused, except toolApproval (turns approval off)', async () => {
    const refused = await patch({ localAuth: null });
    expect(refused.status).toBe(400);
    expect(refused.body.errors[0].pointer).toBe('/localAuth');

    await patch({ toolApproval: null }).expect(200);
    expect((await readPlatform()).toolApproval).toBeUndefined();
  });

  test('jwtProviders are replaced as an array; jwkUrl is restored by provider name', async () => {
    await patch({
      proxyAuth: {
        jwtProviders: [
          { name: 'b', header: 'X-B2' },
          { name: 'a', header: 'X-A' }
        ]
      }
    }).expect(200);

    expect((await readPlatform()).proxyAuth.jwtProviders).toEqual([
      { name: 'b', header: 'X-B2', jwkUrl: 'https://b.example.com/jwks' },
      { name: 'a', header: 'X-A', jwkUrl: 'https://a.example.com/jwks' }
    ]);
  });

  test('provenance keeps its own merge: a partial block, null on a tunable means default', async () => {
    await writeConfig('platform.json', {
      ...PLATFORM,
      provenance: {
        retentionDays: 90,
        verify: { access: 'authenticated' },
        watermark: { alpha: 0.001, minScoredTokens: 300 }
      }
    });

    await patch({
      provenance: { retentionDays: 30, watermark: { alpha: null, minScoredTokens: 500 } }
    }).expect(200);

    expect((await readPlatform()).provenance).toEqual({
      retentionDays: 30,
      verify: { access: 'authenticated' },
      watermark: { minScoredTokens: 500 }
    });
  });

  test('a redaction marker without a stored value is refused', async () => {
    const response = await patch({ telemetry: { exporter: { token: '[REDACTED]' } } });

    expect(response.status).toBe(400);
    expect(response.body.errors[0].pointer).toBe('/telemetry/exporter/token');
  });
});

describe('review round 4: secret containers, deletions, a missing file', () => {
  test.each([
    ['an array', []],
    ['a string', 'key'],
    ['a number', 1]
  ])('speech.azure as %s is refused and the stored key is kept', async (_label, azure) => {
    const before = await readText();

    const response = await patch({ speech: { azure } });

    expect(response.status).toBe(400);
    expect(response.body.detail).toMatch(/speech\.azure must be an object/);
    expect(await readText()).toBe(before);
  });

  test('a POST with speech.azure as an array is refused too', async () => {
    const before = await readText();
    const response = await request(appFor(LOCAL_ADMIN))
      .post('/api/admin/configs/platform')
      .send({ speech: { azure: [] } });
    expect(response.status).toBe(400);
    expect(await readText()).toBe(before);
  });

  test('a sibling speech field is still patched, and null on the key still clears it', async () => {
    await patch({ speech: { defaultService: 'model' } }).expect(200);
    expect((await readPlatform()).speech).toEqual({
      defaultService: 'model',
      azure: { region: 'westeurope', subscriptionKey: 'ENC[speech-key]' }
    });

    await patch({ speech: { azure: { subscriptionKey: null } } }).expect(200);
    expect((await readPlatform()).speech.azure).toEqual({ region: 'westeurope' });
  });

  test('null on an aiAcknowledgement field deletes it; the server-owned fields stay', async () => {
    await writeConfig('platform.json', {
      ...PLATFORM,
      aiAcknowledgement: {
        enabled: true,
        policyUrl: '/policy',
        requiredVersion: 3,
        resetAt: '2026-01-01T00:00:00.000Z'
      }
    });

    await patch({ aiAcknowledgement: { policyUrl: null } }).expect(200);

    expect((await readPlatform()).aiAcknowledgement).toEqual({
      enabled: true,
      requiredVersion: 3,
      resetAt: '2026-01-01T00:00:00.000Z'
    });
  });

  test('a POST that leaves out an aiAcknowledgement field keeps it (partial POST)', async () => {
    await writeConfig('platform.json', {
      ...PLATFORM,
      aiAcknowledgement: { enabled: true, policyUrl: '/policy', requiredVersion: 3 }
    });

    await request(appFor(LOCAL_ADMIN))
      .post('/api/admin/configs/platform')
      .send({ aiAcknowledgement: { enabled: false } })
      .expect(200);

    expect((await readPlatform()).aiAcknowledgement).toEqual({
      enabled: false,
      policyUrl: '/policy',
      requiredVersion: 3
    });
  });

  test('If-Match: * on a missing platform.json is 412 and creates nothing', async () => {
    await fs.rm(file('platform.json'));

    const response = await patch({ setup: { disabled: true } }, { ifMatch: '*' });

    expect(response.status).toBe(412);
    await expect(fs.access(file('platform.json'))).rejects.toThrow();
  });

  test('If-Match: * on a stored empty platform.json is applied', async () => {
    await writeConfig('platform.json', {});

    const response = await patch({ setup: { disabled: true } }, { ifMatch: '*' });

    expect(response.status).toBe(200);
    expect((await readPlatform()).setup).toEqual({ disabled: true });
  });
});

describe('PATCH /api/admin/configs/platform: allowlist', () => {
  test.each(['ssl', 'ssrf', 'cors', 'rateLimit', 'proxy', 'logging'])(
    '%s has its own route and is refused',
    async section => {
      const before = await readText();

      const response = await patch({ [section]: { anything: true } });

      expect(response.status).toBe(400);
      expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(response.body.code).toBe('VALIDATION_FAILED');
      expect(response.body.errors).toEqual([
        expect.objectContaining({ pointer: `/${section}`, code: 'not_patchable' })
      ]);
      expect(response.body.errors[0].message).toMatch(/own validated route/);
      expect(await readText()).toBe(before);
    }
  );

  test('an unknown key is refused, and nothing of the rest of the patch is applied', async () => {
    const before = await readText();

    const response = await patch({ telemetry: { enabled: true }, features: { x: true } });

    expect(response.status).toBe(400);
    expect(response.body.errors).toEqual([expect.objectContaining({ pointer: '/features' })]);
    expect(await readText()).toBe(before);
  });

  test('a body that is not an object is BAD_REQUEST', async () => {
    const response = await request(appFor(LOCAL_ADMIN))
      .patch('/api/admin/configs/platform')
      .set('Content-Type', 'application/json')
      .send('[1,2]');

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('BAD_REQUEST');
  });
});

describe('PATCH /api/admin/configs/platform: the POST checks apply', () => {
  test('section validators run on the patched section', async () => {
    const response = await patch({ cookieSettings: { disableSecure: 'yes' } });
    expect(response.status).toBe(400);
    expect(response.body.detail).toMatch(/cookieSettings/);

    const language = await patch({ defaultLanguage: '../../etc' });
    expect(language.status).toBe(400);
  });

  test('the lockout invariant: turning off the caller’s own sign-in method is 409 AUTH_LOCKOUT', async () => {
    const before = await readText();

    const response = await patch({ localAuth: { enabled: false } });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('AUTH_LOCKOUT');
    expect(await readText()).toBe(before);
  });

  test('a stale If-Match is 412; a fresh one is applied', async () => {
    const read = await request(appFor(LOCAL_ADMIN)).get('/api/admin/configs/platform');
    expect((await patch({ setup: { disabled: true } })).status).toBe(200);

    const stale = await patch({ setup: { disabled: false } }, { ifMatch: read.headers.etag });
    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe('PRECONDITION_FAILED');
    expect((await readPlatform()).setup.disabled).toBe(true);

    const fresh = await request(appFor(LOCAL_ADMIN)).get('/api/admin/configs/platform');
    const applied = await patch({ setup: { disabled: false } }, { ifMatch: fresh.headers.etag });
    expect(applied.status).toBe(200);
    expect((await readPlatform()).setup.disabled).toBe(false);
  });

  test('a snapshot (as stored, secrets encrypted) and an audit entry naming the sections', async () => {
    await patch({ speech: { azure: { subscriptionKey: 'rotated' } } }).expect(200);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].after.speech.azure.subscriptionKey).toBe('ENC[rotated]');
    expect(auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource: 'platform',
          summary: 'Updated platform configuration (speech)'
        })
      ])
    );
  });

  test('a caller who is not signed in is refused and nothing is written', async () => {
    const before = await readText();

    const response = await patch({ setup: { disabled: true } }, { user: undefined });

    expect(response.status).toBe(403);
    expect(await readText()).toBe(before);
  });

  test('a signed-in non-admin is refused', async () => {
    const response = await patch(
      { setup: { disabled: true } },
      { user: { id: 'u', username: 'u', groups: ['users'], authMode: 'local', isAdmin: false } }
    );
    expect(response.status).toBe(403);
  });
});

describe('review fixes: marker scope and unsafe keys', () => {
  const post = body => request(appFor(LOCAL_ADMIN)).post('/api/admin/configs/platform').send(body);

  test('a full-body save is not refused for a marker stored in a section it cannot change (R8)', async () => {
    await writeConfig('platform.json', {
      ...PLATFORM,
      features: { banner: '[REDACTED]' },
      cors: { origin: ['https://a.example.com/?token=REDACTED'] }
    });
    const read = await request(appFor(LOCAL_ADMIN)).get('/api/admin/configs/platform');

    const response = await post({ ...read.body, defaultLanguage: 'de' });

    expect(response.status).toBe(200);
    const stored = await readPlatform();
    expect(stored.defaultLanguage).toBe('de');
    expect(stored.features).toEqual({ banner: '[REDACTED]' });
  });

  test('a marker already stored in a section the request sends back unchanged is kept (R8)', async () => {
    await writeConfig('platform.json', {
      ...PLATFORM,
      globalPromptVariables: { context: '[REDACTED]' }
    });

    const response = await patch({ globalPromptVariables: { extra: 'x' } });

    expect(response.status).toBe(200);
    expect((await readPlatform()).globalPromptVariables).toEqual({
      context: '[REDACTED]',
      extra: 'x'
    });
  });

  test('a marker the request writes in a section it changes is still refused (R8)', async () => {
    await writeConfig('platform.json', {
      ...PLATFORM,
      globalPromptVariables: { context: '[REDACTED]' }
    });

    const response = await patch({ globalPromptVariables: { other: '[REDACTED]' } });

    expect(response.status).toBe(400);
    expect(response.body.errors.map(error => error.pointer)).toEqual([
      '/globalPromptVariables/other'
    ]);
  });

  test.each(['__proto__', 'constructor', 'prototype'])(
    'a "%s" member of a patch is dropped, never assigned (R9)',
    async key => {
      const body = JSON.parse(
        `{"telemetry":{"enabled":true,"${key}":{"polluted":true,"enabled":false}}}`
      );

      const response = await patch(body);

      expect(response.status).toBe(200);
      const stored = await readPlatform();
      expect(stored.telemetry.enabled).toBe(true);
      expect(Object.hasOwn(stored.telemetry, key)).toBe(false);
      expect(stored.telemetry.polluted).toBeUndefined();
      expect(Object.getPrototypeOf(stored.telemetry)).toBe(Object.prototype);
      expect({}.polluted).toBeUndefined();
    }
  );
});

describe('runtime reconfiguration follows what changed, not what the request named', () => {
  const post = body => request(appFor(LOCAL_ADMIN)).post('/api/admin/configs/platform').send(body);

  test('a PATCH of setup reconfigures no sign-in method and keeps the iFinder tokens', async () => {
    await patch({ setup: { disabled: true } }).expect(200);

    expect(reconfigureOidcProviders).not.toHaveBeenCalled();
    expect(clearExchangedTokenCache).not.toHaveBeenCalled();
  });

  test('a partial POST (Cookies) reports no auth method as changed or needing a restart', async () => {
    const response = await post({ cookieSettings: { disableSecure: true } });

    expect(response.status).toBe(200);
    expect(response.body.reconfiguration).toEqual({
      reconfigured: [],
      requiresRestart: [],
      notes: []
    });
    expect(reconfigureOidcProviders).not.toHaveBeenCalled();
    expect(clearExchangedTokenCache).not.toHaveBeenCalled();
  });

  test('a PATCH that changes oidcAuth still reconfigures OIDC and clears the iFinder tokens', async () => {
    await patch({ oidcAuth: { enabled: true } }).expect(200);

    expect(reconfigureOidcProviders).toHaveBeenCalledTimes(1);
    expect(clearExchangedTokenCache).toHaveBeenCalledTimes(1);
  });

  test('a partial POST that changes ntlmAuth still says it needs a restart, and only that', async () => {
    const response = await post({ ntlmAuth: { enabled: false, domain: 'EXAMPLE' } });

    expect(response.status).toBe(200);
    expect(response.body.reconfiguration.requiresRestart).toEqual(['NTLM authentication']);
    expect(response.body.reconfiguration.reconfigured).toEqual([]);
    expect(reconfigureOidcProviders).not.toHaveBeenCalled();
  });
});
