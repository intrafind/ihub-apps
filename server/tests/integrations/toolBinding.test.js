// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Installed integrations as tools (#3061): `loadTools` lists them,
 * `app.integrations` binds them, `runTool` dispatches them with the chat's
 * scope, and each installation with scopes is a scope provider.
 */

const { default: configCache } = await import('../../configCache.js');
const { default: registry } =
  await import('../../services/integrations/definitions/IntegrationRegistry.js');
const { loadTools, getToolsForApp, runTool } = await import('../../toolLoader.js');
const { isToolSelected } = await import('../../utils/toolSelection.js');
const { syncIntegrationScopeProviders } =
  await import('../../services/integrations/integrationTools.js');
const { getScopeProvider, resolveChatScopes } =
  await import('../../services/integrations/scopes/index.js');

let server;
let port;
let root;
const requests = [];

const document = {
  openapi: '3.0.0',
  info: { title: 't', version: '1' },
  paths: {
    '/package_search': {
      get: {
        operationId: 'package_search',
        summary: 'Search datasets',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' } },
          { name: 'fq', in: 'query', schema: { type: 'string' } },
          { name: 'rows', in: 'query', schema: { type: 'integer' } }
        ],
        responses: {}
      }
    },
    '/organization_list': {
      get: { operationId: 'organization_list', parameters: [], responses: {} }
    }
  }
};

const definition = {
  id: 'test.portal',
  version: '1.0.0',
  name: { en: 'Test Portal', de: 'Testportal' },
  protocol: {
    type: 'openapi',
    document: 'api.json',
    baseUrl: '{baseUrl}',
    responseEnvelope: { success: 'success', result: 'result', error: 'error.message' }
  },
  auth: { modes: ['none'] },
  install: [
    { key: 'baseUrl', type: 'url', title: { en: 'URL' }, required: true },
    { key: 'maxRows', type: 'number', title: { en: 'Rows' }, default: 10 }
  ],
  scopes: {
    action: 'list_organizations',
    label: { en: 'Publisher' },
    map: { id: 'name', name: 'title' },
    applyAs: { 'search_datasets.fq': { value: 'organization:{id}', mode: 'append' } }
  },
  sources: {
    search_datasets: {
      list: 'results',
      fields: { title: 'title' },
      urlTemplate: '{baseUrl}/dataset/{name}'
    }
  },
  actions: [
    {
      name: 'search_datasets',
      operationId: 'package_search',
      title: { en: 'Search datasets' },
      sideEffect: 'read',
      defaults: { rows: { value: '{maxRows}', mode: 'cap' } }
    },
    {
      name: 'list_organizations',
      operationId: 'organization_list',
      sideEffect: 'read',
      enabledByDefault: false
    }
  ]
};

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    requests.push({ path: url.pathname, query: url.searchParams });
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/package_search') {
      res.end(
        JSON.stringify({
          success: true,
          result: { count: 1, results: [{ name: 'a', title: 'A' }] }
        })
      );
    } else if (url.pathname === '/organization_list') {
      res.end(JSON.stringify({ success: true, result: [{ name: 'city', title: 'City' }] }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ success: false, error: { message: 'nope' } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;

  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihub-tool-binding-'));
  const dir = path.join(root, 'shipped', 'test.portal');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'integration.json'), JSON.stringify(definition));
  await fs.writeFile(path.join(dir, 'api.json'), JSON.stringify(document));
  registry.shippedDir = path.join(root, 'shipped');
  registry.contentsDirOverride = path.join(root, 'contents');
  await registry.reload();

  configCache.setCacheEntry('config/tools.json', []);
  configCache.setCacheEntry('config/a2aAgents.json', { agents: [] });
  configCache.setCacheEntry('config/peopleDirectories.json', { directories: [] });
  configCache.setCacheEntry('config/platform.json', {});
  configCache.setCacheEntry('config/integrations.json', {
    installed: [
      {
        id: 'portal',
        definition: 'test.portal',
        enabled: true,
        values: { baseUrl: `http://127.0.0.1:${port}`, maxRows: 3 },
        auth: { mode: 'none' },
        actions: { enabled: ['*', 'list_organizations'], disabled: [], overrides: {} },
        allowedGroups: []
      },
      {
        id: 'restricted',
        definition: 'test.portal',
        enabled: true,
        values: { baseUrl: `http://127.0.0.1:${port}` },
        auth: { mode: 'none' },
        allowedGroups: ['data-team']
      },
      {
        id: 'off',
        definition: 'test.portal',
        enabled: false,
        values: { baseUrl: `http://127.0.0.1:${port}` },
        auth: { mode: 'none' }
      }
    ],
    security: { blockPrivateIps: true, allowedHosts: ['127.0.0.1'] }
  });
  await syncIntegrationScopeProviders();
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  for (const timer of configCache.refreshTimers?.values?.() || []) clearTimeout(timer);
  configCache.cache?.clear?.();
});

describe('integration tools', () => {
  it('lists the actions of enabled installations as tools', async () => {
    const tools = await loadTools('en');
    const ids = tools
      .filter(t => t._integration)
      .map(t => t.id)
      .sort();
    assert.deepEqual(ids, [
      'portal__list_organizations',
      'portal__search_datasets',
      'restricted__search_datasets'
    ]);
    const search = tools.find(t => t.id === 'portal__search_datasets');
    assert.equal(search.name, 'Test Portal: Search datasets');
    assert.equal(search.type, 'integration');
    assert.equal(search.sideEffect, 'read');
    assert.equal(search.readOnly, true);
    assert.equal(search.parameters.properties.rows.maximum, 3);
    assert.equal(search.sources.fields.url, 'portalUrl');
  });

  it('selects integration tools by their installation id only', async () => {
    const tools = await loadTools('en');
    const search = tools.find(t => t.id === 'portal__search_datasets');
    assert.equal(isToolSelected(search, ['portal']), true);
    assert.equal(isToolSelected(search, ['portal__search_datasets']), true);
    assert.equal(isToolSelected(search, ['restricted']), false);
  });

  it('binds installations through app.integrations, honouring actions and groups', async () => {
    const app = {
      id: 'open-data',
      tools: [],
      integrations: {
        portal: { actions: ['search_datasets'] },
        restricted: {},
        off: {},
        ifinder: { scopePicker: 'menu' }
      }
    };
    const anyone = await getToolsForApp(app, 'en', { user: { id: 'u', groups: ['users'] } });
    assert.deepEqual(
      anyone.filter(t => t._integration).map(t => t.id),
      ['portal__search_datasets']
    );
    const dataTeam = await getToolsForApp(app, 'en', { user: { id: 'u', groups: ['data-team'] } });
    assert.deepEqual(
      dataTeam
        .filter(t => t._integration)
        .map(t => t.id)
        .sort(),
      ['portal__search_datasets', 'restricted__search_datasets']
    );
    const narrowed = await getToolsForApp(app, 'en', {
      user: { id: 'u', groups: ['data-team'] },
      enabledTools: ['restricted']
    });
    assert.deepEqual(
      narrowed.filter(t => t._integration).map(t => t.id),
      ['restricted__search_datasets']
    );
    const unbound = await getToolsForApp({ id: 'plain', tools: [] }, 'en', { user: { id: 'u' } });
    assert.equal(
      unbound.some(t => t._integration),
      false
    );
  });

  it('dispatches runTool to the adapter with the picked scope and strips context keys', async () => {
    requests.length = 0;
    const result = await runTool('portal__search_datasets', {
      q: 'parking',
      rows: 50,
      language: 'de',
      chatId: 'c1',
      user: { id: 'u' },
      appConfig: { id: 'open-data' },
      integrationScopes: { portal: 'city' }
    });
    assert.equal(result.count, 1);
    assert.equal(result.results[0].portalUrl, `http://127.0.0.1:${port}/dataset/a`);
    const { query } = requests[0];
    assert.equal(query.get('q'), 'parking');
    assert.equal(query.get('rows'), '3');
    assert.equal(query.get('fq'), 'organization:city');
    assert.equal(query.has('language'), false);
    assert.equal(query.has('chatId'), false);
  });

  it('registers a scope provider per installation with scopes', async () => {
    const provider = getScopeProvider('portal');
    assert.ok(provider);
    assert.equal(getScopeProvider('off'), null);
    const app = { id: 'open-data', integrations: { portal: {} } };
    assert.equal(provider.appliesTo({ app }), true);
    assert.equal(provider.appliesTo({ app: { id: 'x', integrations: {} } }), false);
    const listing = await provider.listScopes({ app, user: { id: 'u' } });
    assert.deepEqual(listing.scopes, [{ id: 'city', name: 'City', isDefault: undefined }]);
    assert.equal(listing.defaultScope, 'city');
    assert.equal(listing.fixed, false);

    const resolved = await resolveChatScopes({
      requested: { portal: 'city' },
      user: { id: 'u' },
      app
    });
    assert.deepEqual(resolved, { ok: true, scopes: { portal: 'city' } });
    const refused = await resolveChatScopes({
      requested: { portal: 'mars' },
      user: { id: 'u' },
      app
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'INTEGRATION_SCOPE_NOT_ALLOWED');

    const pinnedApp = { id: 'open-data', integrations: { portal: { pinnedScope: 'city' } } };
    const pinned = await provider.listScopes({ app: pinnedApp, user: { id: 'u' } });
    assert.equal(pinned.fixed, true);
    assert.deepEqual(await provider.validateScope({ scopeId: 'other', app: pinnedApp }), {
      ok: true,
      scopeId: 'city',
      fixed: true
    });
  });
});
