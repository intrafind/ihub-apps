// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * The integration builder's routes (routes/admin/integrationBuilder.js) on a
 * temp definitions tree and an in-memory integrations.json: create, load,
 * save, export, and the export round trip through a fresh registry.
 */

const state = { integrations: null, credentials: { credentials: {} } };

jest.unstable_mockModule('../../services/config/ConfigStore.js', () => ({
  default: {
    writeJson: async (file, data) => {
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
    getCredentials: () => ({ credentials: {} }),
    refreshCacheEntry: async () => {},
    refreshCredentialsCache: async () => {},
    getPlatform: () => ({}),
    getModels: () => ({ data: [] }),
    getTools: () => ({ data: [] })
  },
  resolveEnvVarsInObject: value => value
}));
jest.unstable_mockModule('../../services/TokenStorageService.js', () => ({
  default: { encryptString: value => `ENC[${value}]`, isEncrypted: () => false }
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
jest.unstable_mockModule('../../configSync.js', () => ({ announceConfigChange: () => {} }));
jest.unstable_mockModule('../../toolLoader.js', () => ({
  loadTools: async () => [
    { id: 'write_memory', name: 'Write memory', description: 'Agent memory' },
    {
      id: 'legacyLookup',
      name: 'Legacy: lookup',
      _integration: { instanceId: 'legacy', instanceLabel: 'Legacy', action: 'lookup' }
    }
  ]
}));
// The runner pulls in the dereferencing parser, which jest cannot load as ESM.
jest.unstable_mockModule('../../services/tools/OpenApiToolRunner.js', () => ({
  invalidateSpecCache: () => {},
  invalidateToolsWithPrefix: () => {},
  getOpenApiToolParameters: async () => ({ type: 'object', properties: {} }),
  runOpenApiTool: async () => ({}),
  resolveCredentialAuth: async () => ({ headers: {}, queryParam: null })
}));

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-builder-routes-'));
const shippedDir = path.join(root, 'shipped');
const contentsDir = path.join(root, 'contents');
await fs.mkdir(path.join(shippedDir, 'org.example__shipped'), { recursive: true });
await fs.writeFile(
  path.join(shippedDir, 'org.example__shipped', 'integration.json'),
  JSON.stringify({
    id: 'org.example/shipped',
    version: '1.0.0',
    name: { en: 'Shipped' },
    protocol: { type: 'http', baseUrl: 'https://x.example' },
    auth: { modes: ['none'] },
    actions: [{ name: 'a', request: { url: '/a' } }]
  })
);

const registryModule =
  await import('../../services/integrations/definitions/IntegrationRegistry.js');
const { IntegrationRegistry } = registryModule;
const registry = new IntegrationRegistry({ shippedDir, contentsDir });
// Point the singleton at the temp trees (it is the one the services import).
registryModule.default.shippedDir = shippedDir;
registryModule.default.contentsDirOverride = contentsDir;
void registry;

const { default: installedIntegrationService } =
  await import('../../services/integrations/InstalledIntegrationService.js');
const { default: registerAdminIntegrationBuilderRoutes } =
  await import('../../routes/admin/integrationBuilder.js');
const { exportPackage, nextVersion, draftToPackage } =
  await import('../../services/integrations/builder/builderPackage.js');
const { listOpenApiOperations } =
  await import('../../services/integrations/builder/IntegrationBuilderService.js');
const { validateCatalog } = await import('../../validators/catalogSchema.js');
const { checkScriptCodeFiles } =
  await import('../../services/integrations/definitions/scriptModule.js');

const app = express();
app.use(express.json({ limit: '5mb' }));
registerAdminIntegrationBuilderRoutes(app);
const admin = r => r.set('X-Admin', 'yes');

const httpDraft = {
  instanceId: 'orders',
  name: { en: 'Orders', de: 'Bestellungen' },
  description: { en: 'The ERP orders' },
  icon: 'https://erp.example.com/icon.svg',
  source: 'http',
  auth: { mode: 'none' },
  http: { baseUrl: 'https://erp.example.com/api', headers: { Accept: 'application/json' } },
  approvalDefault: 'writes',
  actions: [
    {
      name: 'get_order',
      description: { en: 'Get one order' },
      sideEffect: 'read',
      dataFlow: 'internal',
      approval: 'never',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id']
      },
      request: { method: 'GET', url: '/orders/{id}' },
      response: { result: '$.data', fields: { id: 'id', total: 'amount.total' } }
    },
    {
      name: 'cancel_order',
      sideEffect: 'destructive',
      dataFlow: 'internal',
      approval: 'always',
      enabled: false,
      parameters: { type: 'object', properties: { id: { type: 'string' } } },
      request: { method: 'DELETE', url: '/orders/{id}' }
    }
  ]
};

const scriptDraft = {
  instanceId: 'echo',
  name: { en: 'Echo' },
  source: 'script',
  auth: { mode: 'none' },
  script: {
    module: 'export default { actions: { echo: { run: async args => `echo ${args.text}` } } };\n'
  },
  actions: [
    {
      name: 'echo',
      sideEffect: 'read',
      dataFlow: 'internal',
      parameters: { type: 'object', properties: { text: { type: 'string' } } }
    }
  ]
};

beforeAll(async () => {
  state.integrations = { installed: [], security: { blockPrivateIps: true, allowedHosts: [] } };
  await registryModule.default.reload();
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('admin only', () => {
  it.each([
    ['get', '/api/admin/integrations/tools'],
    ['post', '/api/admin/integrations/builder'],
    ['get', '/api/admin/integrations/builder/orders'],
    ['put', '/api/admin/integrations/builder/orders'],
    ['post', '/api/admin/integrations/builder/_import'],
    ['post', '/api/admin/integrations/builder/_export/orders']
  ])('%s %s answers 401 without admin', async (method, url) => {
    await request(app)[method](url).send({}).expect(401);
  });
});

describe('create, load, save', () => {
  it('refuses an invalid draft with the paths', async () => {
    const res = await admin(request(app).post('/api/admin/integrations/builder'))
      .send({ ...httpDraft, actions: [] })
      .expect(400);
    expect(res.body.code).toBe('INVALID_DRAFT');
    expect(res.body.details.some(d => d.path.join('.') === 'actions')).toBe(true);
  });

  it('creates the definition folder and the installation', async () => {
    const res = await admin(request(app).post('/api/admin/integrations/builder'))
      .send(httpDraft)
      .expect(201);
    expect(res.body.definitionId).toBe('custom/orders');
    const definition = JSON.parse(
      await fs.readFile(path.join(contentsDir, 'custom__orders', 'integration.json'), 'utf8')
    );
    expect(definition).toMatchObject({
      id: 'custom/orders',
      version: '1.0.0',
      protocol: { type: 'http', baseUrl: 'https://erp.example.com/api' },
      icon: 'https://erp.example.com/icon.svg'
    });
    expect(definition.actions[0].request).toEqual({ method: 'GET', url: '/orders/{id}' });
    const instance = state.integrations.installed.find(i => i.id === 'orders');
    expect(instance).toMatchObject({
      definition: 'custom/orders',
      definitionVersion: '1.0.0',
      auth: { mode: 'none' },
      actions: { disabled: ['cancel_order'] },
      approval: { default: 'writes', actions: { get_order: 'never', cancel_order: 'always' } }
    });
    expect(registryModule.default.get('custom/orders')).toBeTruthy();
    expect(audits.at(-1)).toMatchObject({ action: 'create', resourceId: 'orders' });
  });

  it('refuses a second integration under the same id', async () => {
    const res = await admin(request(app).post('/api/admin/integrations/builder'))
      .send(httpDraft)
      .expect(409);
    expect(res.body.code).toBe('DUPLICATE_ID');
  });

  it('loads the draft back as it was saved', async () => {
    const res = await admin(request(app).get('/api/admin/integrations/builder/orders')).expect(200);
    expect(res.body).toMatchObject({
      instanceId: 'orders',
      definitionId: 'custom/orders',
      source: 'http',
      http: httpDraft.http,
      approvalDefault: 'writes'
    });
    expect(res.body.actions.map(a => [a.name, a.approval, a.enabled])).toEqual([
      ['get_order', 'never', true],
      ['cancel_order', 'always', false]
    ]);
    expect(res.body.actions[0].response).toEqual(httpDraft.actions[0].response);
  });

  it('saves with the next patch version', async () => {
    const draft = {
      ...httpDraft,
      actions: [{ ...httpDraft.actions[0], description: { en: 'Changed' } }]
    };
    await admin(request(app).put('/api/admin/integrations/builder/orders')).send(draft).expect(200);
    const definition = registryModule.default.get('custom/orders').definition;
    expect(definition.version).toBe('1.0.1');
    expect(definition.actions).toHaveLength(1);
    const instance = state.integrations.installed.find(i => i.id === 'orders');
    expect(instance.definitionVersion).toBe('1.0.1');
    expect(instance.approval.actions).toEqual({ get_order: 'never' });
  });

  it('puts the previous folder back when the installation is refused', async () => {
    const original = installedIntegrationService.update;
    installedIntegrationService.update = async () => {
      throw Object.assign(new Error('refused'), { status: 400 });
    };
    try {
      await admin(request(app).put('/api/admin/integrations/builder/orders'))
        .send({ ...httpDraft, name: { en: 'Never saved' } })
        .expect(500);
    } finally {
      installedIntegrationService.update = original;
    }
    const definition = registryModule.default.get('custom/orders').definition;
    expect(definition.version).toBe('1.0.1');
    expect(definition.name).toEqual({ en: 'Orders', de: 'Bestellungen' });
  });

  it('keeps only the tool ids a migrated tool brought', async () => {
    // As migration V211 wrote it: the action keeps the tool file's id.
    const dir = path.join(contentsDir, 'custom__legacy');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'integration.json'),
      JSON.stringify({
        id: 'custom/legacy',
        version: '1.0.0',
        name: { en: 'Legacy' },
        protocol: { type: 'http', baseUrl: 'https://legacy.example' },
        auth: { modes: ['none'] },
        actions: [{ name: 'lookup', toolId: 'legacyLookup', request: { url: '/l' } }]
      })
    );
    await registryModule.default.reload();
    state.integrations.installed.push({
      id: 'legacy',
      definition: 'custom/legacy',
      definitionVersion: '1.0.0',
      enabled: true,
      values: {},
      auth: { mode: 'none' },
      actions: { enabled: ['*'], disabled: [], overrides: {} }
    });
    const loaded = await admin(request(app).get('/api/admin/integrations/builder/legacy')).expect(
      200
    );
    expect(loaded.body.actions[0].toolId).toBe('legacyLookup');
    const draft = {
      ...loaded.body,
      actions: [
        { ...loaded.body.actions[0], toolId: 'hijacked' },
        { name: 'other', toolId: 'ask_user', request: { url: '/o' } }
      ]
    };
    await admin(request(app).put('/api/admin/integrations/builder/legacy')).send(draft).expect(200);
    const actions = registryModule.default.get('custom/legacy').definition.actions;
    expect(actions.map(a => a.toolId)).toEqual(['legacyLookup', undefined]);
  });

  it('builds a script integration with its module under actions/', async () => {
    await admin(request(app).post('/api/admin/integrations/builder')).send(scriptDraft).expect(201);
    const source = await fs.readFile(
      path.join(contentsDir, 'custom__echo', 'actions', 'connector.js'),
      'utf8'
    );
    expect(source).toContain('echo');
    const loaded = await admin(request(app).get('/api/admin/integrations/builder/echo')).expect(
      200
    );
    expect(loaded.body.script.module).toBe(scriptDraft.script.module);
  });

  it('refuses to open an installation that is not custom', async () => {
    state.integrations.installed.push({
      id: 'shipped',
      definition: 'org.example/shipped',
      enabled: true,
      values: {},
      auth: { mode: 'none' },
      actions: { enabled: ['*'], disabled: [], overrides: {} }
    });
    const res = await admin(request(app).get('/api/admin/integrations/builder/shipped')).expect(
      400
    );
    expect(res.body.code).toBe('NOT_CUSTOM');
  });
});

describe('export', () => {
  it('exports a package a registry serves, and it installs on a fresh server', async () => {
    const res = await admin(
      request(app).post('/api/admin/integrations/builder/_export/echo')
    ).expect(200);
    const pkg = res.body;
    expect(pkg.format).toBe('ihub-integration-package');
    expect(pkg.catalogItem).toMatchObject({
      type: 'integration',
      name: 'custom__echo',
      version: '1.0.0',
      source: {
        type: 'relative',
        path: 'integration-definitions/custom__echo/integration.json',
        companions: ['actions/connector.js']
      }
    });
    expect(pkg.catalogItem.source.integrity['actions/connector.js']).toMatch(/^sha256-/);
    expect(validateCatalog({ items: [pkg.catalogItem] }).success).toBe(true);

    // A second iHub: a fresh contents tree, installed through the registry
    // as the marketplace does it (code from a registry trusted for code).
    const { verifyIntegrationCode } =
      await import('../../services/marketplace/ContentInstaller.js');
    expect(() =>
      verifyIntegrationCode(pkg.catalogItem, { files: pkg.files }, { id: 'r', trustCode: true })
    ).not.toThrow();
    checkScriptCodeFiles(pkg.files['integration.json'], pkg.files);
    const fresh = new IntegrationRegistry({
      shippedDir: path.join(root, 'none'),
      contentsDir: path.join(root, 'second-ihub')
    });
    await fresh.writeInstalled('custom/echo', pkg.files);
    const entry = fresh.get('custom/echo');
    expect(entry.status).toBe('ok');
    expect(entry.definition.protocol).toEqual({ type: 'script', module: 'actions/connector.js' });
  });

  it('leaves out the tool ids this server keeps', async () => {
    const res = await admin(
      request(app).post('/api/admin/integrations/builder/_export/legacy')
    ).expect(200);
    expect(res.body.files['integration.json'].actions[0].toolId).toBeUndefined();
  });

  it('refuses to publish a local MCP process', async () => {
    const pkg = draftToPackage({
      instanceId: 'local',
      name: { en: 'Local' },
      source: 'mcp',
      auth: { mode: 'none' },
      mcp: { transport: 'stdio', command: 'node', args: ['server.js'] },
      actions: []
    });
    await registryModule.default.writeInstalled(pkg.definitionId, pkg.files, { local: true });
    state.integrations.installed.push({ ...pkg.installation, definitionVersion: '1.0.0' });
    const res = await admin(
      request(app).post('/api/admin/integrations/builder/_export/local')
    ).expect(409);
    expect(res.body.code).toBe('NOT_PUBLISHABLE');
  });
});

describe('tool catalog', () => {
  it('lists every tool the admin pickers offer, with its installation', async () => {
    const res = await admin(request(app).get('/api/admin/integrations/tools')).expect(200);
    expect(res.body).toEqual([
      { id: 'write_memory', name: 'Write memory', description: 'Agent memory' },
      {
        id: 'legacyLookup',
        name: 'Legacy: lookup',
        integration: { instanceId: 'legacy', label: 'Legacy', action: 'lookup' }
      }
    ]);
  });
});

describe('package helpers', () => {
  it('counts versions up', () => {
    expect(nextVersion('1.0.9')).toBe('1.0.10');
    expect(nextVersion(undefined)).toBe('1.0.0');
  });

  it('lists OpenAPI operations with the side effect of their method', () => {
    const ops = listOpenApiOperations({
      paths: { '/a': { get: { operationId: 'a' }, delete: { operationId: 'd' } } }
    });
    expect(ops.map(o => [o.operationId, o.sideEffect])).toEqual([
      ['a', 'read'],
      ['d', 'destructive']
    ]);
  });

  it('exports companion code with its hash', () => {
    const pkg = exportPackage({
      definition: { id: 'custom/x', version: '1.0.0', name: 'X', protocol: { type: 'script' } },
      companions: { 'actions/connector.js': 'export default {}' }
    });
    expect(pkg.catalogItem.displayName).toEqual({ en: 'X' });
    expect(Object.keys(pkg.catalogItem.source.integrity)).toEqual(['actions/connector.js']);
  });
});
