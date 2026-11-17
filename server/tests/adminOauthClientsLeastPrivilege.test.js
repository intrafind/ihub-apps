// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Least privilege for OAuth clients created by an admin (ID-B6):
 *
 * - The resource lists are stored as sent. An empty or missing list stays
 *   empty; it is never widened to `["*"]`. Only an explicit `["*"]` is stored
 *   as "all".
 * - A client-credentials (machine) token whose client stores `[]` reaches
 *   nothing; `["*"]` reaches everything.
 * - A user-delegated (authorization-code) token keeps today's meaning: an empty
 *   client list is no extra restriction on the user's group permissions.
 * - The create and rotate-secret responses carry a plain-text secret and are
 *   sent with `Cache-Control: no-store`.
 *
 * The client manager is the real one, writing to a temporary file.
 *
 * Native ESM, so `jest.unstable_mockModule` + dynamic imports.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-oauth-clients-'));
const clientsFile = path.join(tmpDir, 'oauth-clients.json');

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => {
    req.user = { id: 'admin' };
    next();
  }
}));
jest.unstable_mockModule('../services/AuditLogService.js', () => ({ logAudit: () => {} }));
jest.unstable_mockModule('../services/oauth/ConnectionService.js', () => ({
  countByClient: async () => ({})
}));
jest.unstable_mockModule('../services/oauth/CimdGovernanceService.js', () => ({
  listCimdClientRows: () => []
}));
const cacheEntries = new Map();
jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => ({ oauth: { enabled: { clients: true }, clientsFile } }),
    get: key => cacheEntries.get(key) ?? null,
    setCacheEntry: (key, data) => cacheEntries.set(key, { data })
  }
}));

const { default: registerAdminOAuthRoutes } = await import('../routes/admin/oauthClients.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');
const { loadOAuthClients, findClientById } = await import('../utils/oauthClientManager.js');
const { enhanceUserWithPermissions, filterResourcesByPermissions, applyOAuthClientFilter } =
  await import('../utils/authorization.js');

const app = express();
app.use(express.json());
registerAdminOAuthRoutes(app);
app.use(errorHandler);

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** The client as stored in the clients file. */
function stored(clientId) {
  return findClientById(loadOAuthClients(clientsFile), clientId);
}

/** The `req.user` jwtAuth builds for a client-credentials token of this client. */
function machineUser(client) {
  return {
    id: client.clientId,
    name: client.name,
    groups: ['oauth_clients'],
    authMode: 'oauth_client_credentials',
    isOAuthClient: true,
    allowedApps: client.allowedApps || [],
    allowedModels: client.allowedModels || [],
    allowedPrompts: client.allowedPrompts || []
  };
}

const APPS = [{ id: 'chat' }, { id: 'summarizer' }];

describe('admin OAuth clients: empty lists mean none for machine clients', () => {
  it('stores empty lists as empty, not as ["*"]', async () => {
    const res = await request(app)
      .post('/api/admin/oauth/clients')
      .send({ name: 'Empty lists', allowedApps: [], allowedModels: [], allowedPrompts: [] });

    expect(res.status).toBe(201);
    expect(res.body.allowedApps).toEqual([]);
    expect(res.body.allowedModels).toEqual([]);
    expect(res.body.allowedPrompts).toEqual([]);

    const client = stored(res.body.clientId);
    expect(client.allowedApps).toEqual([]);
    expect(client.allowedModels).toEqual([]);
    expect(client.allowedPrompts).toEqual([]);
  });

  it('stores missing lists as empty, not as ["*"]', async () => {
    const res = await request(app).post('/api/admin/oauth/clients').send({ name: 'No lists' });

    expect(res.status).toBe(201);
    const client = stored(res.body.clientId);
    expect(client.allowedApps).toEqual([]);
    expect(client.allowedModels).toEqual([]);
    expect(client.allowedPrompts).toEqual([]);
  });

  it('stores an explicit ["*"] and a list of ids as sent', async () => {
    const res = await request(app)
      .post('/api/admin/oauth/clients')
      .send({ name: 'Explicit', allowedApps: ['*'], allowedModels: ['gpt-x'], allowedPrompts: [] });

    const client = stored(res.body.clientId);
    expect(client.allowedApps).toEqual(['*']);
    expect(client.allowedModels).toEqual(['gpt-x']);
    expect(client.allowedPrompts).toEqual([]);
  });

  it('gives a machine token of an empty-list client no apps, and of a ["*"] client all apps', async () => {
    const empty = await request(app)
      .post('/api/admin/oauth/clients')
      .send({ name: 'Machine none', grantTypes: ['client_credentials'] });
    const all = await request(app)
      .post('/api/admin/oauth/clients')
      .send({ name: 'Machine all', grantTypes: ['client_credentials'], allowedApps: ['*'] });

    const noneUser = enhanceUserWithPermissions(machineUser(stored(empty.body.clientId)), {}, {});
    expect(noneUser.permissions.apps.size).toBe(0);
    expect(filterResourcesByPermissions(APPS, noneUser.permissions.apps)).toEqual([]);
    expect(noneUser.permissions.models.size).toBe(0);
    expect(noneUser.permissions.prompts.size).toBe(0);

    const allUser = enhanceUserWithPermissions(machineUser(stored(all.body.clientId)), {}, {});
    expect(filterResourcesByPermissions(APPS, allUser.permissions.apps)).toEqual(APPS);
  });

  it('keeps an empty list as "no extra restriction" for user-delegated tokens', () => {
    const groupPermissions = {
      apps: new Set(['chat', 'summarizer']),
      models: new Set(['*']),
      prompts: new Set(['p1'])
    };
    const filtered = applyOAuthClientFilter(groupPermissions, {
      clientAllowedApps: [],
      clientAllowedModels: [],
      clientAllowedPrompts: []
    });
    expect([...filtered.apps]).toEqual(['chat', 'summarizer']);
    expect([...filtered.models]).toEqual(['*']);
    expect([...filtered.prompts]).toEqual(['p1']);
  });
});

describe('admin OAuth clients: secrets are not cached', () => {
  it('sends the create response with Cache-Control: no-store', async () => {
    const res = await request(app)
      .post('/api/admin/oauth/clients')
      .send({ name: 'No store', allowedApps: ['chat'] });

    expect(res.status).toBe(201);
    expect(typeof res.body.clientSecret).toBe('string');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('sends the rotate-secret response with Cache-Control: no-store', async () => {
    const created = await request(app)
      .post('/api/admin/oauth/clients')
      .send({ name: 'Rotate me', allowedApps: ['chat'] });

    const res = await request(app).post(
      `/api/admin/oauth/clients/${created.body.clientId}/rotate-secret`
    );

    expect(res.status).toBe(200);
    expect(typeof res.body.clientSecret).toBe('string');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
