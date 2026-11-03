// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/** V211: admin-created tool files become custom integrations. */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  up,
  precondition,
  version,
  slugOf,
  isMigratableTool,
  migrateApp,
  actionsOf
} from '../migrations/V211__tools_to_custom_integrations.js';
import { IntegrationRegistry } from '../services/integrations/definitions/IntegrationRegistry.js';
import { validateIntegrationsConfig } from '../validators/integrationsConfigSchema.js';

const SPEC = {
  openapi: '3.0.0',
  info: { title: 'Orders', version: '1.0.0' },
  servers: [{ url: 'https://erp.example.com/api' }],
  paths: {
    '/orders/{id}': {
      get: {
        operationId: 'getOrder',
        summary: 'Get an order',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]
      }
    }
  }
};

/** Tool files as admins wrote them with the Tools page. */
const FIXTURES = {
  // A script tool with functions and #2945 approval fields.
  'crm.json': {
    id: 'crm',
    name: { en: 'CRM', de: 'CRM' },
    description: { en: 'Customer records' },
    script: 'crmTool.js',
    enabled: true,
    approval: 'writes',
    functions: {
      findCustomer: {
        description: { en: 'Find a customer' },
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: { en: 'Name', de: 'Name' } } },
          required: ['name']
        },
        sideEffect: 'read',
        dataFlow: 'internal'
      },
      updateCustomer: {
        description: { en: 'Update a customer' },
        parameters: { type: 'object', properties: { id: { type: 'string' } } },
        sideEffect: 'write',
        approval: 'always'
      }
    }
  },
  // A single-function script tool, switched off, that requires approval.
  'pingTool.json': {
    id: 'pingTool',
    name: 'Ping',
    description: 'Pings a host',
    script: 'pingTool.js',
    enabled: false,
    requiresApproval: true,
    parameters: { properties: { host: { type: 'string' } } }
  },
  // An OpenAPI tool with an inline spec and a credential.
  'orders.json': {
    id: 'orders',
    name: { en: 'Orders' },
    type: 'openapi',
    sideEffect: 'read',
    openapi: {
      source: { type: 'inline', spec: SPEC },
      operationId: 'getOrder',
      baseUrl: 'https://erp.example.com/api',
      auth: { credentialRef: 'erp-token' },
      headers: { 'X-Client': 'ihub' },
      xDisplay: { hideFields: ['internalId'] },
      security: { blockPrivateIps: true, allowedHosts: ['erp.internal'] }
    }
  },
  // An OpenAPI tool fetching its document by URL, without a base URL.
  'weather.json': {
    id: 'weather',
    name: 'Weather',
    type: 'openapi',
    openapi: {
      source: { type: 'url', url: 'https://api.example.com/openapi.json' },
      operationId: 'forecast'
    }
  },
  // Shipped / platform tools stay.
  'iFinder.json': {
    id: 'iFinder',
    name: 'iFinder',
    script: 'iFinder.js',
    functions: { search: {} }
  },
  'write_memory.json': { id: 'write_memory', name: 'Write memory', script: 'agentTools.js' },
  'native.json': { id: 'native', name: 'Native', isSpecialTool: true, provider: 'google' }
};

let root;
let contentsDir;

async function writeJson(rel, data) {
  const file = path.join(contentsDir, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

async function readJson(rel) {
  return JSON.parse(await fs.readFile(path.join(contentsDir, rel), 'utf8'));
}

async function exists(rel) {
  try {
    await fs.access(path.join(contentsDir, rel));
    return true;
  } catch {
    return false;
  }
}

/** The migration context the runner builds, on a real folder. */
function makeCtx() {
  const logs = [];
  const warnings = [];
  return {
    logs,
    warnings,
    contentsDir,
    readJson,
    writeJson,
    fileExists: exists,
    deleteFile: rel => fs.unlink(path.join(contentsDir, rel)),
    listFiles: async (dir, pattern) => {
      try {
        const entries = await fs.readdir(path.join(contentsDir, dir));
        return pattern === '*.json' ? entries.filter(e => e.endsWith('.json')) : entries;
      } catch {
        return [];
      }
    },
    log: message => logs.push(message),
    warn: message => warnings.push(message)
  };
}

/** Every file under the contents folder: relative path → text. */
async function snapshot() {
  const out = {};
  async function walk(dir, prefix) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else out[rel] = await fs.readFile(path.join(dir, entry.name), 'utf8');
    }
  }
  await walk(contentsDir, '');
  return out;
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-v211-'));
  contentsDir = path.join(root, 'contents');
  for (const [file, tool] of Object.entries(FIXTURES)) await writeJson(`tools/${file}`, tool);
  await writeJson('config/integrations.json', {
    installed: [
      // Another definition already holds the slug "orders": the tool takes "orders-2".
      { id: 'orders', definition: 'com.example/orders', enabled: true, values: {} }
    ],
    security: { blockPrivateIps: true, allowedHosts: [] }
  });
  await writeJson('config/groups.json', {
    groups: {
      admins: { id: 'admins', permissions: { integrations: ['*'] } },
      users: { id: 'users', permissions: { integrations: ['ihub'] } },
      legacy: { id: 'legacy', permissions: {} }
    }
  });
  await writeJson('apps/support.json', {
    id: 'support',
    tools: ['crm', 'ask_user', 'pingTool'],
    integrations: { jira: {} }
  });
  await writeJson('apps/lookup.json', { id: 'lookup', tools: ['crm_findCustomer', 'orders'] });
  await writeJson('apps/plain.json', { id: 'plain', tools: ['ask_user'] });
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('V211 tool files → custom integrations', () => {
  it('declares its version', () => assert.equal(version, '211'));

  it('runs only when tool files exist', async () => {
    assert.equal(await precondition(makeCtx()), true);
    const empty = { listFiles: async () => [] };
    assert.equal(await precondition(empty), false);
  });

  it('migrates admin tools only', () => {
    assert.equal(isMigratableTool(FIXTURES['crm.json']), true);
    assert.equal(isMigratableTool(FIXTURES['orders.json']), true);
    assert.equal(isMigratableTool(FIXTURES['iFinder.json']), false);
    assert.equal(isMigratableTool(FIXTURES['write_memory.json']), false);
    assert.equal(isMigratableTool(FIXTURES['native.json']), false);
    assert.equal(isMigratableTool({ id: 'a2', name: 'x', isAgentTool: true }), false);
  });

  it('derives installation ids builders accept', () => {
    assert.equal(slugOf('pingTool'), 'ping-tool');
    assert.equal(slugOf('my_tool.v2'), 'my-tool-v2');
    assert.equal(slugOf('_x'), 'x');
  });

  it('keeps the tool ids of every function', () => {
    const ids = actionsOf(FIXTURES['crm.json']).map(({ action }) => action.toolId);
    assert.deepEqual(ids, ['crm_findCustomer', 'crm_updateCustomer']);
  });

  it('writes definitions, installations, bindings and grants, and removes the tool files', async () => {
    const ctx = makeCtx();
    await up(ctx);

    // Tool files: the admin's are gone, iHub's stay.
    for (const file of ['crm.json', 'pingTool.json', 'orders.json', 'weather.json']) {
      assert.equal(await exists(`tools/${file}`), false, file);
    }
    for (const file of ['iFinder.json', 'write_memory.json', 'native.json']) {
      assert.equal(await exists(`tools/${file}`), true, file);
    }

    // Installations validate and keep the tools' state and approval.
    const config = await readJson('config/integrations.json');
    assert.equal(validateIntegrationsConfig(config).success, true);
    const byId = Object.fromEntries(config.installed.map(inst => [inst.id, inst]));
    assert.equal(byId.crm.definition, 'custom/crm');
    assert.deepEqual(byId.crm.approval, {
      default: 'writes',
      actions: { updateCustomer: 'always' }
    });
    assert.equal(byId['ping-tool'].enabled, false);
    assert.deepEqual(byId['ping-tool'].approval, { actions: { pingTool: 'always' } });
    assert.equal(byId['orders-2'].definition, 'custom/orders-2');
    assert.deepEqual(byId['orders-2'].auth, {
      mode: 'service-account',
      credentialRef: 'erp-token'
    });
    assert.equal(byId.orders.definition, 'com.example/orders', 'the other holder is untouched');
    assert.ok(config.security.allowedHosts.includes('erp.internal'));

    // Definitions load in the registry with the kept tool ids.
    const registry = new IntegrationRegistry({
      shippedDir: path.join(root, 'no-shipped'),
      contentsDir: path.join(contentsDir, 'integration-definitions')
    });
    await registry.reload();
    const crm = registry.get('custom/crm');
    assert.ok(crm, 'custom/crm loads');
    assert.equal(crm.definition.protocol.type, 'script');
    assert.deepEqual(
      crm.definition.actions.map(a => [a.name, a.toolId, a.sideEffect, a.dataFlow]),
      [
        ['findCustomer', 'crm_findCustomer', 'read', 'internal'],
        ['updateCustomer', 'crm_updateCustomer', 'write', 'internal']
      ]
    );
    const orders = registry.get('custom/orders-2');
    assert.equal(orders.definition.protocol.type, 'openapi');
    assert.equal(orders.definition.protocol.document, 'openapi.json');
    assert.equal(orders.document.paths['/orders/{id}'].get.operationId, 'getOrder');
    assert.equal(orders.definition.auth.serviceAccount.kind, 'credential');
    assert.deepEqual(orders.definition.actions[0].hideFields, ['internalId']);
    assert.equal(orders.definition.actions[0].toolId, 'orders');
    const weather = registry.get('custom/weather');
    assert.equal(weather.definition.protocol.document, 'https://api.example.com/openapi.json');
    assert.equal(weather.definition.protocol.baseUrl, undefined);
    const ping = registry.get('custom/ping-tool');
    assert.equal(ping.definition.actions[0].toolId, 'pingTool');
    assert.equal(ping.definition.actions[0].parameters.type, 'object');

    // Apps bind the installations instead of listing the tools.
    const support = await readJson('apps/support.json');
    assert.deepEqual(support.tools, ['ask_user']);
    assert.deepEqual(support.integrations, { jira: {}, crm: {}, 'ping-tool': {} });
    const lookup = await readJson('apps/lookup.json');
    assert.equal(lookup.tools, undefined);
    assert.deepEqual(lookup.integrations, {
      crm: { actions: ['findCustomer'] },
      'orders-2': {}
    });
    assert.deepEqual(await readJson('apps/plain.json'), { id: 'plain', tools: ['ask_user'] });

    // Groups with an explicit list are granted; `*` and no list are left alone.
    const groups = await readJson('config/groups.json');
    assert.deepEqual(groups.groups.admins.permissions.integrations, ['*']);
    assert.deepEqual(groups.groups.users.permissions.integrations, [
      'ihub',
      'crm',
      'orders-2',
      'ping-tool',
      'weather'
    ]);
    assert.deepEqual(groups.groups.legacy.permissions, {});
  });

  it('generates a connector that runs the tool script with each function', async () => {
    const file = path.join(contentsDir, 'integration-definitions/custom__crm/actions/connector.js');
    const { default: connector } = await import(pathToFileURL(file).href);
    const calls = [];
    const ctx = {
      runToolScript: async (script, options) => {
        calls.push([script, options]);
        return 'ok';
      }
    };
    assert.equal(await connector.actions.findCustomer.run({ name: 'A' }, ctx), 'ok');
    await connector.actions.updateCustomer.run({}, ctx);
    assert.deepEqual(calls, [
      ['crmTool.js', { method: 'findCustomer' }],
      ['crmTool.js', { method: 'updateCustomer' }]
    ]);
    const pingFile = path.join(
      contentsDir,
      'integration-definitions/custom__ping-tool/actions/connector.js'
    );
    const { default: ping } = await import(pathToFileURL(pingFile).href);
    calls.length = 0;
    await ping.actions.pingTool.run({ host: 'x' }, ctx);
    assert.deepEqual(calls, [['pingTool.js', {}]]);
  });

  it('is a no-op the second time', async () => {
    const before = await snapshot();
    await up(makeCtx());
    assert.deepEqual(await snapshot(), before);
  });

  it('finishes a run that stopped before the tool file was removed', async () => {
    // As if the run had stopped after writing the installation.
    await writeJson('tools/crm.json', FIXTURES['crm.json']);
    const ctx = makeCtx();
    await up(ctx);
    assert.equal(await exists('tools/crm.json'), false);
    const config = await readJson('config/integrations.json');
    assert.equal(config.installed.filter(inst => inst.definition === 'custom/crm').length, 1);
    assert.equal(
      config.installed.some(inst => inst.id === 'crm-2'),
      false
    );
  });

  it('gives a second tool with the same slug its own installation', async () => {
    await writeJson('tools/Crm2.json', { ...FIXTURES['crm.json'], id: 'CRM' });
    await up(makeCtx());
    const config = await readJson('config/integrations.json');
    assert.ok(config.installed.some(inst => inst.id === 'crm-2'));
    assert.ok(await exists('integration-definitions/custom__crm-2/integration.json'));
  });
});

describe('V211 app rewrite', () => {
  const migrated = [
    {
      instanceId: 'crm',
      toolId: 'crm',
      actions: [
        { name: 'find', toolId: 'crm_find' },
        { name: 'update', toolId: 'crm_update' }
      ]
    }
  ];

  it('leaves an app without migrated tools as it is', () => {
    const app = { id: 'x', tools: ['ask_user'] };
    assert.equal(migrateApp(app, migrated), app);
  });

  it('merges single functions into one narrowed binding', () => {
    const next = migrateApp({ id: 'x', tools: ['crm_find', 'crm_update'] }, migrated);
    assert.deepEqual(next.integrations, { crm: { actions: ['find', 'update'] } });
    assert.equal(next.tools, undefined);
  });

  it('keeps an existing binding that binds every action', () => {
    const next = migrateApp({ id: 'x', tools: ['crm_find'], integrations: { crm: {} } }, migrated);
    assert.deepEqual(next.integrations, { crm: {} });
  });
});
