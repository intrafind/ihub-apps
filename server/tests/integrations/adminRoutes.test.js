// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Admin API of the installed integrations (routes/admin/integrations.js)
 * against an in-memory integrations.json and credentials.json, with a
 * shipped definition in a temp directory and a stubbed adapter run.
 */

const state = { integrations: null, credentials: { credentials: {} }, writes: [], refreshed: [] };

jest.unstable_mockModule('../../services/config/ConfigStore.js', () => ({
  default: {
    writeJson: async (file, data) => {
      state.writes.push({ file, data: structuredClone(data) });
      if (file === 'config/integrations.json') state.integrations = structuredClone(data);
      if (file === 'config/credentials.json') state.credentials = structuredClone(data);
    },
    readJsonStrict: async file =>
      file === 'config/credentials.json' ? structuredClone(state.credentials) : null
  }
}));
jest.unstable_mockModule('../../configCache.js', () => ({
  default: {
    get: key =>
      key === 'config/integrations.json'
        ? { data: structuredClone(state.integrations), etag: null }
        : { data: null, etag: null },
    getIntegrations: () => ({ data: structuredClone(state.integrations), etag: null }),
    getCredentials: () => ({
      credentials: Object.fromEntries(
        Object.entries(state.credentials.credentials).map(([id, p]) => [
          id,
          { ...p, value: String(p.value).replace(/^ENC\[(.*)\]$/, '$1') }
        ])
      )
    }),
    refreshCacheEntry: async key => state.refreshed.push(key),
    refreshCredentialsCache: async () => state.refreshed.push('credentials'),
    getPlatform: () => ({}),
    getModels: () => ({ data: [] }),
    getTools: () => ({ data: [] })
  },
  resolveEnvVarsInObject: value => value
}));
jest.unstable_mockModule('../../services/TokenStorageService.js', () => ({
  default: {
    encryptString: value => `ENC[${value}]`,
    isEncrypted: value => /^ENC\[/.test(value)
  }
}));
jest.unstable_mockModule('../../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) =>
    req.headers['x-admin'] === 'yes' ? next() : res.status(401).json({ error: 'no' })
}));
jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));
const audits = [];
jest.unstable_mockModule('../../services/AuditLogService.js', () => ({
  logAudit: entry => audits.push(entry)
}));
jest.unstable_mockModule('../../services/integrations/integrationTools.js', () => ({
  syncIntegrationScopeProviders: async () => []
}));

// The adapter's network call is stubbed; everything around it is real.
const runCalls = [];
jest.unstable_mockModule('../../services/tools/OpenApiToolRunner.js', () => ({
  parseOpenApiText: text => JSON.parse(text),
  invalidateSpecCache: () => {},
  getOpenApiToolParameters: async () => ({
    type: 'object',
    properties: { q: { type: 'string' }, rows: { type: 'integer' } },
    required: []
  }),
  runOpenApiTool: async (tool, args) => {
    runCalls.push({ tool, args });
    if (tool.openapi.baseUrl.includes('broken')) return { error: true, status: 503, body: 'down' };
    return { help: 'h', success: true, result: { count: 7, results: [] } };
  }
}));

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-integrations-routes-'));
const shippedDir = path.join(root, 'shipped');
await fs.mkdir(path.join(shippedDir, 'org.ckan__portal'), { recursive: true });
await fs.writeFile(
  path.join(shippedDir, 'org.ckan__portal', 'integration.json'),
  JSON.stringify({
    id: 'org.ckan/portal',
    version: '1.2.3',
    name: { en: 'Portal', de: 'Portal' },
    protocol: {
      type: 'openapi',
      document: 'api.json',
      baseUrl: '{baseUrl}',
      responseEnvelope: { success: 'success', result: 'result', error: 'error.message' }
    },
    auth: {
      modes: ['none', 'service-account'],
      serviceAccount: { kind: 'header', header: 'Authorization', field: 'apiToken' }
    },
    install: [
      { key: 'baseUrl', type: 'url', title: { en: 'URL' }, required: true },
      { key: 'apiToken', type: 'secret', title: { en: 'Token' } },
      { key: 'maxRows', type: 'number', title: { en: 'Rows' }, default: 10, min: 1, max: 50 }
    ],
    health: { action: 'search', args: { rows: 0 } },
    actions: [
      {
        name: 'search',
        operationId: 'package_search',
        sideEffect: 'read',
        defaults: { rows: { value: '{maxRows}', mode: 'cap' } }
      },
      {
        name: 'secret_only',
        operationId: 'package_search',
        sideEffect: 'read',
        connection: 'token'
      }
    ]
  })
);
await fs.writeFile(
  path.join(shippedDir, 'org.ckan__portal', 'api.json'),
  JSON.stringify({
    openapi: '3.0.0',
    info: {},
    paths: { '/package_search': { get: { operationId: 'package_search', responses: {} } } }
  })
);

const { IntegrationRegistry } =
  await import('../../services/integrations/definitions/IntegrationRegistry.js');
const registryModule =
  await import('../../services/integrations/definitions/IntegrationRegistry.js');
const registry = new IntegrationRegistry({ shippedDir, contentsDir: path.join(root, 'contents') });
// Point the singletons at the temp registry.
Object.assign(registryModule.default, registry);
registryModule.default.reload = registry.reload.bind(registry);
registryModule.default.ensureLoaded = registry.ensureLoaded.bind(registry);
registryModule.default.list = registry.list.bind(registry);
registryModule.default.get = registry.get.bind(registry);
registryModule.default.isInstalled = registry.isInstalled.bind(registry);

const { default: registerAdminIntegrationsRoutes } =
  await import('../../routes/admin/integrations.js');

const app = express();
app.use(express.json());
registerAdminIntegrationsRoutes(app);
const admin = r => r.set('X-Admin', 'yes');

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

beforeEach(() => {
  state.integrations = { installed: [], security: { blockPrivateIps: true, allowedHosts: [] } };
  state.credentials = { credentials: {} };
  state.writes = [];
  state.refreshed = [];
  audits.length = 0;
  runCalls.length = 0;
});

describe('catalog', () => {
  it('requires admin', async () => {
    await request(app).get('/api/admin/integrations/catalog').expect(401);
  });

  it('lists definitions with their install fields and actions', async () => {
    const res = await admin(request(app).get('/api/admin/integrations/catalog?lang=de')).expect(
      200
    );
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      id: 'org.ckan/portal',
      name: 'Portal',
      protocol: 'openapi',
      supported: true,
      authModes: ['none', 'service-account'],
      actionCount: 2,
      installedInstances: []
    });
    const detail = await admin(
      request(app).get(`/api/admin/integrations/catalog/${encodeURIComponent('org.ckan/portal')}`)
    ).expect(200);
    expect(detail.body.definition.install.map(f => f.key)).toEqual([
      'baseUrl',
      'apiToken',
      'maxRows'
    ]);
    expect(detail.body.definition.actions[0].name).toBe('search');
    await admin(request(app).get('/api/admin/integrations/catalog/nope.missing')).expect(404);
    await admin(request(app).get('/api/admin/integrations/catalog/Bad%20Id')).expect(400);
  });

  it('tests an unsaved draft without writing anything', async () => {
    const res = await admin(
      request(app)
        .post(`/api/admin/integrations/catalog/${encodeURIComponent('org.ckan/portal')}/_test`)
        .send({ values: { baseUrl: 'https://portal.example' }, auth: { mode: 'none' } })
    ).expect(200);
    expect(res.body.result.success).toBe(true);
    expect(res.body.result.steps.map(s => s.status)).toEqual(['ok', 'ok', 'ok']);
    expect(runCalls[0].args.rows).toBe(0);
    expect(state.writes).toEqual([]);
    expect(audits[0]).toMatchObject({ action: 'execute', resource: 'integration' });
  });

  it('tests a draft with an inline secret that is never stored', async () => {
    const res = await admin(
      request(app)
        .post(`/api/admin/integrations/catalog/${encodeURIComponent('org.ckan/portal')}/_test`)
        .send({
          values: { baseUrl: 'https://portal.example' },
          auth: { mode: 'service-account' },
          secrets: { apiToken: 'inline-token' }
        })
    ).expect(200);
    expect(res.body.result.success).toBe(true);
    expect(runCalls[0].tool.openapi.headers.Authorization).toBe('inline-token');
    expect(state.writes).toEqual([]);
  });
});

describe('installed instances', () => {
  const payload = {
    id: 'ckan-demo',
    definition: 'org.ckan/portal',
    label: { en: 'Demo' },
    values: { baseUrl: 'https://portal.example', maxRows: 5 },
    auth: { mode: 'none' }
  };

  it('installs, lists, reads with live actions, updates, toggles and uninstalls', async () => {
    const created = await admin(
      request(app).post('/api/admin/integrations/installed').send(payload)
    ).expect(201);
    expect(created.body.instance).toMatchObject({
      id: 'ckan-demo',
      definitionVersion: '1.2.3',
      enabled: true,
      values: { baseUrl: 'https://portal.example', maxRows: 5 }
    });
    expect(state.integrations.installed).toHaveLength(1);
    expect(state.refreshed).toContain('config/integrations.json');
    expect(audits.at(-1)).toMatchObject({ action: 'create', resourceId: 'ckan-demo' });

    const list = await admin(request(app).get('/api/admin/integrations/installed')).expect(200);
    expect(list.body.items[0]).toMatchObject({
      id: 'ckan-demo',
      label: 'Demo',
      definitionName: 'Portal'
    });

    const detail = await admin(
      request(app).get('/api/admin/integrations/installed/ckan-demo')
    ).expect(200);
    expect(detail.body.values).toEqual({ baseUrl: 'https://portal.example', maxRows: 5 });
    const actions = Object.fromEntries(detail.body.actions.map(a => [a.name, a]));
    expect(actions.search.available).toBe(true);
    expect(actions.search.parameters.properties.rows.maximum).toBe(5);
    expect(actions.secret_only.available).toBe(false); // needs a token, auth is none
    expect(actions.secret_only.needsToken).toBe(true);

    await admin(
      request(app)
        .put('/api/admin/integrations/installed/ckan-demo')
        .send({ ...payload, values: { baseUrl: 'https://other.example' } })
    ).expect(200);
    expect(state.integrations.installed[0].values.baseUrl).toBe('https://other.example');
    expect(state.integrations.installed[0].installedAt).toBe(created.body.instance.installedAt);

    const disabled = await admin(
      request(app).post('/api/admin/integrations/installed/ckan-demo/_disable')
    ).expect(200);
    expect(disabled.body.instance.enabled).toBe(false);

    const test = await admin(
      request(app).post('/api/admin/integrations/installed/ckan-demo/_test')
    ).expect(200);
    expect(test.body.result.success).toBe(true);

    await admin(request(app).delete('/api/admin/integrations/installed/ckan-demo')).expect(204);
    expect(state.integrations.installed).toEqual([]);
    await admin(request(app).get('/api/admin/integrations/installed/ckan-demo')).expect(404);
  });

  it('rejects duplicates, unknown definitions, bad values and reserved ids', async () => {
    await admin(request(app).post('/api/admin/integrations/installed').send(payload)).expect(201);
    const dup = await admin(
      request(app).post('/api/admin/integrations/installed').send(payload)
    ).expect(409);
    expect(dup.body.code).toBe('DUPLICATE_ID');
    const unknown = await admin(
      request(app)
        .post('/api/admin/integrations/installed')
        .send({ ...payload, id: 'x', definition: 'org.none/x' })
    ).expect(404);
    expect(unknown.body.code).toBe('UNKNOWN_DEFINITION');
    const bad = await admin(
      request(app)
        .post('/api/admin/integrations/installed')
        .send({ ...payload, id: 'y', values: { baseUrl: 'ftp://x', maxRows: 99 } })
    ).expect(400);
    expect(bad.body.code).toBe('INVALID_VALUES');
    expect(bad.body.details.map(d => d.key).sort()).toEqual(['baseUrl', 'maxRows']);
    const reserved = await admin(
      request(app)
        .post('/api/admin/integrations/installed')
        .send({ ...payload, id: 'a2a' })
    ).expect(400);
    expect(reserved.body.code).toBe('INVALID_ID');
    const sensitive = await admin(
      request(app)
        .post('/api/admin/integrations/installed')
        .send({ ...payload, id: 'z', values: { baseUrl: 'https://x.org', apiToken: 'leak' } })
    ).expect(400);
    expect(sensitive.body.details[0].key).toBe('apiToken');
  });

  it('stores the service-account secret in the credential store, never in integrations.json', async () => {
    const res = await admin(
      request(app)
        .post('/api/admin/integrations/installed')
        .send({
          ...payload,
          id: 'private',
          auth: { mode: 'service-account' },
          secrets: { apiToken: 's3cret' }
        })
    ).expect(201);
    expect(res.body.instance.auth).toEqual({
      mode: 'service-account',
      credentialRef: 'integration-private-apiToken'
    });
    expect(JSON.stringify(state.integrations)).not.toContain('s3cret');
    expect(state.credentials.credentials['integration-private-apiToken']).toMatchObject({
      type: 'secret',
      value: 'ENC[s3cret]'
    });
    // without a secret the service-account mode is refused
    const missing = await admin(
      request(app)
        .post('/api/admin/integrations/installed')
        .send({ ...payload, id: 'nosecret', auth: { mode: 'service-account' } })
    ).expect(400);
    expect(missing.body.details[0].key).toBe('apiToken');
    // updating without a new secret keeps the stored credential
    await admin(
      request(app)
        .put('/api/admin/integrations/installed/private')
        .send({ ...payload, id: 'private', auth: { mode: 'service-account' } })
    ).expect(200);
    expect(state.integrations.installed[0].auth.credentialRef).toBe('integration-private-apiToken');
    // uninstalling removes the managed credential
    await admin(request(app).delete('/api/admin/integrations/installed/private')).expect(204);
    expect(state.credentials.credentials['integration-private-apiToken']).toBeUndefined();
  });

  it('reports a failed probe for an unreachable portal', async () => {
    await admin(
      request(app)
        .post('/api/admin/integrations/installed')
        .send({ ...payload, id: 'broken', values: { baseUrl: 'https://broken.example' } })
    ).expect(201);
    const res = await admin(
      request(app).post('/api/admin/integrations/installed/broken/_test')
    ).expect(200);
    expect(res.body.result.success).toBe(false);
    expect(res.body.result.steps.find(s => s.id === 'probe').status).toBe('fail');
  });
});
