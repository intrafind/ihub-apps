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
    updateJson: async function (file, mutate) {
      const current =
        file === 'config/integrations.json'
          ? structuredClone(state.integrations)
          : file === 'config/credentials.json'
            ? structuredClone(state.credentials)
            : null;
      const next = await mutate(current);
      if (next === undefined) return { data: current, written: false };
      await this.writeJson(file, next);
      return { data: next, written: true };
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
    getModels: () => ({ data: [] })
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
jest.unstable_mockModule('../../services/tools/catalog.js', () => ({
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

const { default: errorHandler } = await import('../../middleware/errorHandler.js');
const app = express();
app.use(express.json({ limit: '5mb' }));
registerAdminIntegrationBuilderRoutes(app);
app.use(errorHandler);
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
    expect(res.body.errors.some(e => e.pointer === '/actions')).toBe(true);
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

  it('shows an action detail override as the builder value, and keeps what the builder does not edit', async () => {
    const stored = state.integrations.installed.find(i => i.id === 'orders');
    const bogus = `sha256:${'a'.repeat(64)}`;
    stored.actions = {
      ...stored.actions,
      overrides: {
        get_order: {
          guidance: { en: 'Ask for the order id first' },
          // The definition declares `internal`; the admin set this in the action detail.
          dataFlow: 'external',
          description: { en: 'Get one order, as the model reads it' }
        },
        gone: { guidance: { en: 'An action the draft no longer has' } }
      },
      fingerprints: { get_order: bogus },
      reviewedAt: '2026-11-01T00:00:00.000Z'
    };
    stored.approval = { ...stored.approval, newOrChanged: 'writes' };
    const loaded = await admin(request(app).get('/api/admin/integrations/builder/orders')).expect(
      200
    );
    // The effective value, as the action runs with it.
    const shown = loaded.body.actions.find(a => a.name === 'get_order');
    expect(shown.dataFlow).toBe('external');
    expect(shown.description).toEqual({ en: 'Get one order, as the model reads it' });

    await admin(request(app).put('/api/admin/integrations/builder/orders'))
      .send(loaded.body)
      .expect(200);
    const instance = state.integrations.installed.find(i => i.id === 'orders');
    // The builder wrote its three fields into the definition, so nothing
    // overrides them any more; the guidance is the action detail's and stays.
    expect(instance.actions.overrides).toEqual({
      get_order: { guidance: { en: 'Ask for the order id first' } }
    });
    const declared = registryModule.default
      .get('custom/orders')
      .definition.actions.find(a => a.name === 'get_order');
    expect(declared).toMatchObject({
      dataFlow: 'external',
      description: { en: 'Get one order, as the model reads it' }
    });
    expect(instance.approval).toEqual({
      default: 'writes',
      actions: { get_order: 'never' },
      newOrChanged: 'writes'
    });
  });

  it('changes the value a declared action runs with when the builder edits it', async () => {
    const stored = state.integrations.installed.find(i => i.id === 'orders');
    stored.actions = {
      ...stored.actions,
      overrides: { get_order: { dataFlow: 'external' } }
    };
    const loaded = await admin(request(app).get('/api/admin/integrations/builder/orders')).expect(
      200
    );
    loaded.body.actions.find(a => a.name === 'get_order').dataFlow = 'internal';
    await admin(request(app).put('/api/admin/integrations/builder/orders'))
      .send(loaded.body)
      .expect(200);
    const instance = state.integrations.installed.find(i => i.id === 'orders');
    // Without the override dropped, the old value would still win.
    expect(instance.actions.overrides?.get_order?.dataFlow).toBeUndefined();
    const declared = registryModule.default
      .get('custom/orders')
      .definition.actions.find(a => a.name === 'get_order');
    expect(declared.dataFlow).toBe('internal');
  });

  /** The review state of every action of the stored installation. */
  const reviewStates = async instanceId => {
    const { currentActionsOf } = await import('../../services/integrations/actionReview.js');
    const { actionReviewState } = await import('../../utils/actionFingerprint.js');
    const resolved = await installedIntegrationService.resolve(instanceId, 'en');
    const { fingerprints } = await currentActionsOf(resolved, 'en');
    const stored = installedIntegrationService.get(instanceId);
    return Object.fromEntries(
      Object.entries(fingerprints).map(([name, fp]) => [name, actionReviewState(stored, name, fp)])
    );
  };

  it('marks the actions it edited or added as reviewed', async () => {
    // Take the baseline of the current actions, as the first chat run would.
    const { currentActionsOf } = await import('../../services/integrations/actionReview.js');
    const resolved = await installedIntegrationService.resolve('orders', 'en');
    const { fingerprints: baseline } = await currentActionsOf(resolved, 'en');
    await installedIntegrationService.markActionsReviewed('orders', baseline, null);
    expect(await reviewStates('orders')).toEqual({ get_order: null });
    const before = state.integrations.installed.find(i => i.id === 'orders').actions;

    // Edit one action (its side effect is part of the fingerprint) and add one.
    const loaded = await admin(request(app).get('/api/admin/integrations/builder/orders')).expect(
      200
    );
    const draft = loaded.body;
    draft.actions.find(a => a.name === 'get_order').sideEffect = 'write';
    draft.actions.push({
      name: 'list_orders',
      sideEffect: 'read',
      dataFlow: 'internal',
      parameters: { type: 'object', properties: {} },
      request: { method: 'GET', url: '/orders' }
    });
    await admin(request(app).put('/api/admin/integrations/builder/orders')).send(draft).expect(200);

    // Nobody has to click "Mark reviewed" on what the admin just wrote.
    expect(await reviewStates('orders')).toEqual({ get_order: null, list_orders: null });
    const after = state.integrations.installed.find(i => i.id === 'orders').actions;
    expect(after.fingerprints.get_order).not.toBe(before.fingerprints.get_order);
    expect(Object.keys(after.fingerprints).sort()).toEqual(['get_order', 'list_orders']);
  });

  it('leaves an action that was already pending alone when the save does not change it', async () => {
    // get_order was accepted with a fingerprint that is no longer its own (it
    // is "changed" before the save); the admin edits a different action.
    const stored = state.integrations.installed.find(i => i.id === 'orders');
    const staleFingerprint = `sha256:${'b'.repeat(64)}`;
    stored.actions.fingerprints = { ...stored.actions.fingerprints, get_order: staleFingerprint };
    expect((await reviewStates('orders')).get_order).toBe('changed');

    const loaded = await admin(request(app).get('/api/admin/integrations/builder/orders')).expect(
      200
    );
    const draft = loaded.body;
    draft.actions.push({
      name: 'count_orders',
      sideEffect: 'read',
      dataFlow: 'internal',
      parameters: { type: 'object', properties: {} },
      request: { method: 'GET', url: '/orders/count' }
    });
    await admin(request(app).put('/api/admin/integrations/builder/orders')).send(draft).expect(200);

    // The new action is the admin's own edit; the pending one is not touched.
    const states = await reviewStates('orders');
    expect(states.count_orders).toBeNull();
    expect(states.get_order).toBe('changed');
    expect(
      state.integrations.installed.find(i => i.id === 'orders').actions.fingerprints.get_order
    ).toBe(staleFingerprint);
  });

  it('does not take a baseline on a save: an installation without one is left alone', async () => {
    const stored = state.integrations.installed.find(i => i.id === 'orders');
    delete stored.actions.fingerprints;
    delete stored.actions.reviewedAt;
    const loaded = await admin(request(app).get('/api/admin/integrations/builder/orders')).expect(
      200
    );
    await admin(request(app).put('/api/admin/integrations/builder/orders'))
      .send(loaded.body)
      .expect(200);
    expect(
      state.integrations.installed.find(i => i.id === 'orders').actions.fingerprints
    ).toBeUndefined();
  });

  it('removes the approval a save no longer names', async () => {
    const stored = state.integrations.installed.find(i => i.id === 'orders');
    stored.approval = { default: 'writes', actions: { get_order: 'never' } };
    const loaded = await admin(request(app).get('/api/admin/integrations/builder/orders')).expect(
      200
    );
    expect(loaded.body.approvalDefault).toBe('writes');
    // The admin cleared the default and every action's own mode.
    const draft = { ...loaded.body, approvalDefault: undefined };
    draft.actions = draft.actions.map(({ approval: _approval, ...rest }) => rest);
    await admin(request(app).put('/api/admin/integrations/builder/orders')).send(draft).expect(200);
    expect(state.integrations.installed.find(i => i.id === 'orders').approval).toBeUndefined();
  });

  it('keeps newOrChanged when the default and the action modes are cleared', async () => {
    const stored = state.integrations.installed.find(i => i.id === 'orders');
    stored.approval = { default: 'writes', newOrChanged: 'always' };
    const loaded = await admin(request(app).get('/api/admin/integrations/builder/orders')).expect(
      200
    );
    const draft = { ...loaded.body, approvalDefault: undefined };
    await admin(request(app).put('/api/admin/integrations/builder/orders')).send(draft).expect(200);
    expect(state.integrations.installed.find(i => i.id === 'orders').approval).toEqual({
      newOrChanged: 'always'
    });
  });

  it('refuses a description longer than the action detail allows, and accepts the longest', async () => {
    const loaded = await admin(request(app).get('/api/admin/integrations/builder/orders')).expect(
      200
    );
    const withDescription = text => ({
      ...loaded.body,
      actions: loaded.body.actions.map(a =>
        a.name === 'get_order' ? { ...a, description: { en: text } } : a
      )
    });
    const refused = await admin(request(app).put('/api/admin/integrations/builder/orders'))
      .send(withDescription('x'.repeat(4001)))
      .expect(400);
    expect(refused.body.code).toBe('INVALID_DRAFT');
    expect(refused.body.errors.some(e => e.pointer.startsWith('/actions/0/description'))).toBe(
      true
    );
    await admin(request(app).put('/api/admin/integrations/builder/orders'))
      .send(withDescription('x'.repeat(4000)))
      .expect(200);
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

  it('decides the remote overrides and keeps the action detail texts', () => {
    const existingInstance = {
      id: 'remote',
      actions: {
        overrides: {
          search: {
            description: { en: 'Old' },
            sideEffect: 'write',
            guidance: { en: 'Prefer exact titles' },
            examples: [{ en: 'Find the handbook' }]
          }
        }
      }
    };
    const { installation } = draftToPackage(
      {
        instanceId: 'remote',
        name: { en: 'Remote' },
        source: 'mcp',
        auth: { mode: 'none' },
        mcp: { transport: 'streamableHttp', url: 'https://mcp.example.com/mcp' },
        actions: [{ name: 'search', sideEffect: 'read', dataFlow: 'external' }]
      },
      { existingInstance }
    );
    expect(installation.actions.overrides).toEqual({
      search: {
        sideEffect: 'read',
        guidance: { en: 'Prefer exact titles' },
        examples: [{ en: 'Find the handbook' }]
      }
    });
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
    expect(res.body.items).toEqual([
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
