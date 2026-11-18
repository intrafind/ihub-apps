// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * No redacted or whole-file overwrites (PL-B4, snapshot leak).
 *
 * The admin read of platform.json redacts secrets; every admin page sends that
 * body back on save. Before this fix the read left `jwkUrl` out of every proxy
 * JWT provider, so each save of the Authentication page (and the Advanced and
 * Provenance cards, which posted the whole read back) deleted it, and a save
 * that omitted `jwtSecret` deleted that too.
 *
 * Contract: GET → POST of the unchanged body leaves platform.json identical,
 * secrets included. Omitted secret = keep; `null` = clear; a marker that has no
 * stored value to stand for is refused (400, naming the field). Snapshot reads
 * are redacted; a rollback keeps the current secrets.
 *
 * Real ConfigStore, real ChangeHistoryService, real adminAuth on a temporary
 * contents directory. Native-ESM jest (`jest.unstable_mockModule`).
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const state = { rootDir: null };
const auditEntries = [];

jest.unstable_mockModule('../pathUtils.js', () => ({
  getRootDir: () => state.rootDir
}));

jest.unstable_mockModule('../storage/bootstrap.js', () => ({
  getStorage: () => null,
  readFacet: () => null
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

// A visible stand-in for AES-GCM: `ENC[...]` is "encrypted".
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

const { default: registerAdminConfigRoutes } = await import('../routes/admin/configs.js');
const { default: registerAdminChangesRoutes } = await import('../routes/admin/changes.js');
const { default: registerAdminLoggingRoutes } = await import('../routes/admin/logging.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const LOCAL_ADMIN = {
  id: 'user_local',
  username: 'admin',
  groups: ['admins'],
  authMode: 'local',
  isAdmin: true
};

/** Every field the admin read redacts or used to leave out. */
const FULL_PLATFORM = {
  defaultLanguage: 'en',
  auth: { mode: 'local', jwtSecret: 'auth-jwt-secret' },
  anonymousAuth: { enabled: false },
  localAuth: { enabled: true, jwtSecret: 'local-jwt-secret', sessionTimeoutMinutes: 480 },
  oidcAuth: { enabled: false, providers: [] },
  ldapAuth: { enabled: false, providers: [] },
  ntlmAuth: { enabled: false },
  proxyAuth: {
    enabled: false,
    jwtProviders: [
      {
        name: 'sso',
        header: 'X-Token',
        issuer: 'https://sso.example.com',
        audience: 'ihub',
        jwkUrl: 'https://sso.example.com/jwks'
      },
      {
        name: 'internal',
        header: 'Authorization',
        issuer: 'https://idp.internal',
        audience: 'ihub',
        jwkUrl: 'https://svc:pa55@idp.internal/keys?token=abc123'
      }
    ]
  },
  speech: { azure: { region: 'westeurope', subscriptionKey: 'ENC[speech-key]' } },
  ssl: { ignoreInvalidCertificates: false, domainWhitelist: [] },
  features: { anything: true }
};

const GROUPS = {
  groups: {
    admins: { id: 'admins', name: 'Admins', permissions: { adminAccess: true } }
  }
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
const readPlatform = async () => JSON.parse(await fs.readFile(file('platform.json'), 'utf8'));

function appFor(user = LOCAL_ADMIN) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = user;
    next();
  });
  registerAdminConfigRoutes(app);
  registerAdminChangesRoutes(app);
  registerAdminLoggingRoutes(app);
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  auditEntries.length = 0;
  state.rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-roundtrip-'));
  await fs.mkdir(path.join(state.rootDir, 'contents', 'config'), { recursive: true });
  await writeConfig('platform.json', FULL_PLATFORM);
  await writeConfig('groups.json', GROUPS);
  await writeConfig('users.json', USERS);
});

afterEach(async () => {
  await fs.rm(state.rootDir, { recursive: true, force: true });
});

describe('GET /api/admin/configs/platform redacts, and its body saves back unchanged', () => {
  test('the read redacts secrets and masks JWKS URL credentials, but keeps the providers whole', async () => {
    const response = await request(appFor()).get('/api/admin/configs/platform');

    expect(response.status).toBe(200);
    expect(response.body.auth.jwtSecret).toBe('***REDACTED***');
    expect(response.body.localAuth.jwtSecret).toBe('***REDACTED***');
    expect(response.body.speech.azure.subscriptionKey).toBe('***REDACTED***');
    const [sso, internal] = response.body.proxyAuth.jwtProviders;
    expect(sso).toEqual(FULL_PLATFORM.proxyAuth.jwtProviders[0]);
    expect(internal.jwkUrl).toBe('https://REDACTED@idp.internal/keys?token=REDACTED');
    expect(JSON.stringify(response.body)).not.toMatch(/pa55|abc123|jwt-secret|speech-key/);
  });

  test('GET → POST of the unchanged body leaves platform.json identical', async () => {
    const app = appFor();
    const before = await readPlatform();
    const read = await request(app).get('/api/admin/configs/platform');

    const saved = await request(app).post('/api/admin/configs/platform').send(read.body);

    expect(saved.status).toBe(200);
    expect(await readPlatform()).toEqual(before);
    // The response is redacted like the read.
    expect(saved.body.config.auth.jwtSecret).toBe('***REDACTED***');
    expect(saved.body.config.speech.azure.subscriptionKey).toBe('***REDACTED***');
  });

  test('the Authentication page round trip (only auth blocks) keeps jwkUrl and the JWT secrets', async () => {
    const app = appFor();
    const read = await request(app).get('/api/admin/configs/platform');
    const { auth, anonymousAuth, proxyAuth, localAuth, oidcAuth, ldapAuth, ntlmAuth } = read.body;

    const saved = await request(app)
      .post('/api/admin/configs/platform')
      .send({ auth, anonymousAuth, proxyAuth, localAuth, oidcAuth, ldapAuth, ntlmAuth });

    expect(saved.status).toBe(200);
    const stored = await readPlatform();
    expect(stored.proxyAuth).toEqual(FULL_PLATFORM.proxyAuth);
    expect(stored.auth.jwtSecret).toBe('auth-jwt-secret');
    expect(stored.localAuth.jwtSecret).toBe('local-jwt-secret');
  });

  test('providers are matched by name, not by position', async () => {
    const app = appFor();
    const read = await request(app).get('/api/admin/configs/platform');
    const reversed = [...read.body.proxyAuth.jwtProviders].reverse();

    await request(app)
      .post('/api/admin/configs/platform')
      .send({ proxyAuth: { ...read.body.proxyAuth, jwtProviders: reversed } })
      .expect(200);

    const stored = await readPlatform();
    expect(stored.proxyAuth.jwtProviders).toEqual(
      [...FULL_PLATFORM.proxyAuth.jwtProviders].reverse()
    );
  });

  test('a provider sent without jwkUrl keeps the stored one', async () => {
    const providers = FULL_PLATFORM.proxyAuth.jwtProviders.map(
      ({ jwkUrl: _omit, ...rest }) => rest
    );

    await request(appFor())
      .post('/api/admin/configs/platform')
      .send({ proxyAuth: { enabled: false, jwtProviders: providers } })
      .expect(200);

    expect((await readPlatform()).proxyAuth.jwtProviders).toEqual(
      FULL_PLATFORM.proxyAuth.jwtProviders
    );
  });

  test('a new jwkUrl is stored as sent', async () => {
    const providers = structuredClone(FULL_PLATFORM.proxyAuth.jwtProviders);
    providers[0].jwkUrl = 'https://sso.example.com/new-jwks';

    await request(appFor())
      .post('/api/admin/configs/platform')
      .send({ proxyAuth: { enabled: false, jwtProviders: providers } })
      .expect(200);

    expect((await readPlatform()).proxyAuth.jwtProviders[0].jwkUrl).toBe(
      'https://sso.example.com/new-jwks'
    );
  });
});

describe('omitted vs null secrets', () => {
  test('an auth block without jwtSecret keeps the stored secret', async () => {
    await request(appFor())
      .post('/api/admin/configs/platform')
      .send({ localAuth: { enabled: true, sessionTimeoutMinutes: 60 } })
      .expect(200);

    const stored = await readPlatform();
    expect(stored.localAuth).toEqual({
      enabled: true,
      sessionTimeoutMinutes: 60,
      jwtSecret: 'local-jwt-secret'
    });
  });

  test('jwtSecret: null clears the secret', async () => {
    await request(appFor())
      .post('/api/admin/configs/platform')
      .send({ localAuth: { enabled: true, jwtSecret: null } })
      .expect(200);

    expect((await readPlatform()).localAuth).toEqual({ enabled: true });
  });

  test('a speech block without the key keeps it (still encrypted); a new key is encrypted', async () => {
    const app = appFor();
    await request(app)
      .post('/api/admin/configs/platform')
      .send({ speech: { azure: { region: 'northeurope' } } })
      .expect(200);
    expect((await readPlatform()).speech.azure).toEqual({
      region: 'northeurope',
      subscriptionKey: 'ENC[speech-key]'
    });

    await request(app)
      .post('/api/admin/configs/platform')
      .send({ speech: { azure: { region: 'northeurope', subscriptionKey: 'new-key' } } })
      .expect(200);
    expect((await readPlatform()).speech.azure.subscriptionKey).toBe('ENC[new-key]');
  });

  test('a marker with no stored value behind it is refused, naming the field, and nothing is written', async () => {
    const before = await fs.readFile(file('platform.json'), 'utf8');

    const response = await request(appFor())
      .post('/api/admin/configs/platform')
      .send({
        proxyAuth: {
          enabled: false,
          jwtProviders: [{ name: 'renamed', jwkUrl: 'https://REDACTED@idp.internal/keys' }]
        }
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_FAILED');
    expect(response.body.errors).toEqual([
      expect.objectContaining({ pointer: '/proxyAuth/jwtProviders/0/jwkUrl' })
    ]);
    expect(await fs.readFile(file('platform.json'), 'utf8')).toBe(before);
  });

  test('a marker anywhere in a submitted section is refused', async () => {
    const response = await request(appFor())
      .post('/api/admin/configs/platform')
      .send({ telemetry: { exporter: { headers: { authorization: '***REDACTED***' } } } });

    expect(response.status).toBe(400);
    expect(response.body.errors[0].pointer).toBe('/telemetry/exporter/headers/authorization');
  });
});

describe('change-history snapshots of platform.json', () => {
  async function latestSnapshot(app) {
    const list = await request(app).get('/api/admin/changes/platform/platform').expect(200);
    return list.body[0].filename;
  }

  test('the snapshot read contains no secret', async () => {
    const app = appFor();
    await request(app)
      .post('/api/admin/configs/platform')
      .send({ auth: { mode: 'local', jwtSecret: 'rotated-secret' } })
      .expect(200);

    const filename = await latestSnapshot(app);
    const response = await request(app).get(`/api/admin/changes/platform/platform/${filename}`);

    expect(response.status).toBe(200);
    const text = JSON.stringify(response.body);
    expect(text).not.toMatch(
      /auth-jwt-secret|rotated-secret|local-jwt-secret|speech-key|pa55|abc123/
    );
    expect(response.body.before.auth.jwtSecret).toBe('***REDACTED***');
    expect(response.body.after.auth.jwtSecret).toBe('***REDACTED***');
  });

  test('a rollback keeps the current secrets and restores the rest', async () => {
    const app = appFor();
    await request(app)
      .post('/api/admin/configs/platform')
      .send({ defaultLanguage: 'de', auth: { mode: 'local', jwtSecret: 'rotated-secret' } })
      .expect(200);
    const filename = await latestSnapshot(app);

    await request(app)
      .post(`/api/admin/changes/platform/platform/${filename}/rollback`)
      .expect(200);

    const stored = await readPlatform();
    expect(stored.defaultLanguage).toBe('en');
    expect(stored.auth.jwtSecret).toBe('rotated-secret');
    expect(JSON.stringify(stored)).not.toContain('REDACTED');
  });

  test('a rollback to a snapshot that holds a marker keeps the current secret, never the marker', async () => {
    const app = appFor();
    await request(app)
      .post('/api/admin/configs/platform')
      .send({ defaultLanguage: 'de' })
      .expect(200);
    const filename = await latestSnapshot(app);
    const snapshotPath = await findFile(path.join(state.rootDir, 'contents'), filename);
    const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
    snapshot.before.localAuth.jwtSecret = '***REDACTED***';
    await fs.writeFile(snapshotPath, JSON.stringify(snapshot));

    await request(app)
      .post(`/api/admin/changes/platform/platform/${filename}/rollback`)
      .expect(200);

    expect((await readPlatform()).localAuth.jwtSecret).toBe('local-jwt-secret');
  });
});

describe('PUT /api/admin/logging/config (OB-B10, OB-B6)', () => {
  test('a privacy-only body changes only anonymizeIp, and is audit-logged with a snapshot', async () => {
    await writeConfig('platform.json', {
      ...FULL_PLATFORM,
      logging: { level: 'debug', format: 'text', anonymizeIp: 'off' }
    });
    const app = appFor();

    await request(app).put('/api/admin/logging/config').send({ anonymizeIp: 'mask' }).expect(200);

    expect((await readPlatform()).logging).toEqual({
      level: 'debug',
      format: 'text',
      anonymizeIp: 'mask'
    });
    expect(auditEntries).toEqual([
      expect.objectContaining({ resource: 'platform', resourceId: 'logging', action: 'update' })
    ]);
    const list = await request(app).get('/api/admin/changes/platform/platform').expect(200);
    expect(list.body).toHaveLength(1);
  });
});

/** Find a file by name below `dir`. */
async function findFile(dir, name) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFile(full, name).catch(() => null);
      if (found) return found;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}
