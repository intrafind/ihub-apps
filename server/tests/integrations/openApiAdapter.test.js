// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';

/**
 * The openapi adapter against a local server that speaks like CKAN: an
 * envelope `{ help, success, result | error }`, JSON-list array parameters,
 * a token header. Covers enforced defaults, the chat's scope, envelope
 * unwrapping, source URLs, header injection and the test report.
 *
 * Runs under node:test (not Jest): the runner's OpenAPI parser is an ESM-only
 * dependency Jest's module loader cannot require.
 */

const { default: configCache } = await import('../../configCache.js');
const adapter = await import('../../services/integrations/protocols/openapi/OpenApiAdapter.js');
const { validateIntegrationDefinition } =
  await import('../../validators/integrationDefinitionSchema.js');
const { invalidateSpecCache } = await import('../../services/tools/OpenApiToolRunner.js');

function setCredentials(credentials) {
  configCache.setCacheEntry('config/credentials.json', { credentials });
}

let server;
let port;
let requests;

const document = {
  openapi: '3.0.3',
  info: { title: 'Fake CKAN', version: '1' },
  paths: {
    '/package_search': {
      get: {
        operationId: 'package_search',
        summary: 'Search datasets',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' } },
          { name: 'fq', in: 'query', schema: { type: 'string' } },
          { name: 'rows', in: 'query', schema: { type: 'integer', default: 10 } },
          { name: 'include_private', in: 'query', schema: { type: 'boolean' } },
          { name: 'facet.field', in: 'query', schema: { type: 'array', items: { type: 'string' } } }
        ],
        responses: { 200: { description: 'ok' } }
      }
    },
    '/package_show': {
      get: {
        operationId: 'package_show',
        parameters: [{ name: 'id', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'ok' } }
      }
    },
    '/organization_list': {
      get: {
        operationId: 'organization_list',
        parameters: [
          { name: 'all_fields', in: 'query', schema: { type: 'boolean' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 25 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } }
        ],
        responses: { 200: { description: 'ok' } }
      }
    },
    '/datastore_search_sql': {
      get: {
        operationId: 'datastore_search_sql',
        parameters: [{ name: 'sql', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'ok' } }
      }
    }
  }
};

const rawDefinition = {
  id: 'test.ckan/portal',
  version: '1.0.0',
  name: { en: 'Fake portal' },
  protocol: {
    type: 'openapi',
    document: 'doc.json',
    baseUrl: '{baseUrl}{apiPath}',
    responseEnvelope: {
      success: 'success',
      result: 'result',
      error: 'error.message',
      errorType: 'error.__type'
    },
    arrayParameterStyle: 'json-list'
  },
  auth: {
    modes: ['none', 'service-account'],
    serviceAccount: { kind: 'header', header: '{tokenHeader}', field: 'apiToken' }
  },
  install: [
    { key: 'baseUrl', type: 'url', title: { en: 'URL' }, required: true },
    { key: 'apiPath', type: 'string', title: { en: 'Path' }, default: '/api/3/action' },
    { key: 'tokenHeader', type: 'string', title: { en: 'Header' }, default: 'Authorization' },
    { key: 'apiToken', type: 'secret', title: { en: 'Token' } },
    { key: 'defaultFilter', type: 'string', title: { en: 'fq' } },
    { key: 'includePrivate', type: 'boolean', title: { en: 'private' }, default: false },
    { key: 'maxRows', type: 'number', title: { en: 'rows' }, default: 10 },
    { key: 'datastoreSql', type: 'boolean', title: { en: 'sql' }, default: false }
  ],
  scopes: {
    action: 'list_organizations',
    label: { en: 'Publisher' },
    map: { id: 'name', name: 'title' },
    paging: { offset: 'offset', limit: 'limit', size: 2 },
    applyAs: { 'search_datasets.fq': { value: 'organization:{id}', mode: 'append' } }
  },
  sources: {
    search_datasets: {
      kind: 'item',
      list: 'results',
      fields: { id: 'id', title: 'title', snippet: 'notes' },
      urlTemplate: '{baseUrl}/dataset/{name}',
      query: 'q'
    }
  },
  health: { action: 'search_datasets', args: { rows: 0 } },
  actions: [
    {
      name: 'search_datasets',
      operationId: 'package_search',
      sideEffect: 'read',
      defaults: {
        rows: { value: '{maxRows}', mode: 'cap' },
        fq: { value: '{defaultFilter}', mode: 'append' },
        include_private: { value: '{includePrivate}', mode: 'fixed' }
      },
      hideFields: ['result.results[].extras']
    },
    { name: 'get_dataset', operationId: 'package_show', sideEffect: 'read' },
    {
      name: 'list_organizations',
      operationId: 'organization_list',
      sideEffect: 'read',
      defaults: { all_fields: { value: true, mode: 'fixed' } }
    },
    {
      name: 'query_datastore_sql',
      operationId: 'datastore_search_sql',
      sideEffect: 'read',
      enabledByDefault: false,
      requires: { 'install.datastoreSql': true }
    }
  ]
};

const definition = validateIntegrationDefinition(rawDefinition).data;
const security = { blockPrivateIps: true, allowedHosts: ['127.0.0.1'] };

function instanceWith(values = {}, auth = { mode: 'none' }, extra = {}) {
  return {
    id: 'portal',
    definition: definition.id,
    enabled: true,
    values: { baseUrl: `http://127.0.0.1:${port}`, ...values },
    auth,
    actions: { enabled: ['*'], disabled: [], overrides: {} },
    allowedGroups: [],
    ...extra
  };
}

const envelope = result => JSON.stringify({ help: 'https://x/help', success: true, result });

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    requests.push({ path: url.pathname, query: url.searchParams, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/3/action/package_search') {
      res.end(
        envelope({
          count: 2,
          results: [
            { id: 'd1', name: 'parking', title: 'Parking', notes: 'cars', extras: [{ key: 'x' }] },
            { id: 'd2', name: 'kitas', title: 'Kitas', notes: 'kids', extras: [] }
          ],
          search_facets: {}
        })
      );
      return;
    }
    if (url.pathname === '/api/3/action/package_show') {
      if (url.searchParams.get('id') === 'bad-id') {
        // CKAN's validation error: no `message`, one key per field.
        res.statusCode = 409;
        res.end(
          JSON.stringify({
            help: 'h',
            success: false,
            error: { __type: 'Validation Error', id: ['Missing value'] }
          })
        );
        return;
      }
      res.statusCode = 404;
      res.end(
        JSON.stringify({
          help: 'h',
          success: false,
          error: { __type: 'Not Found Error', message: 'Not found' }
        })
      );
      return;
    }
    if (url.pathname === '/api/3/action/organization_list') {
      // Like CKAN: a full-field listing is capped, here at the page size the
      // definition declares (2), whatever `limit` asks for.
      const all = [
        { name: 'city', title: 'City Council' },
        { name: 'nhs', title: 'Health' },
        { name: 'rail', title: 'Railways' }
      ];
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Math.min(Number(url.searchParams.get('limit') || 25), 2);
      res.end(envelope(all.slice(offset, offset + limit)));
      return;
    }
    if (url.pathname === '/custom/package_search') {
      res.end(envelope({ count: 0, results: [] }));
      return;
    }
    res.statusCode = 500;
    res.end(JSON.stringify({ success: false, error: { message: 'boom' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  requests = [];
  setCredentials({});
  invalidateSpecCache();
});

const searchAction = definition.actions.find(a => a.name === 'search_datasets');

describe('discoverActions', () => {
  it('shapes the model-facing schema from the enforced defaults', async () => {
    const actions = await adapter.discoverActions({
      definition,
      instance: instanceWith({ maxRows: 5 }),
      document,
      security
    });
    const search = actions.find(a => a.name === 'search_datasets');
    assert.equal(search.toolId, 'portal__search_datasets');
    assert.equal(search.parameters.properties.include_private, undefined); // fixed
    assert.equal(search.parameters.properties.rows.maximum, 5); // capped
    assert.equal(search.description, 'Search datasets'); // from the operation summary
    assert.equal(search.sideEffect, 'read');
    assert.deepEqual(search.sources, {
      provider: 'portal',
      kind: 'item',
      list: 'results',
      fields: { id: 'id', title: 'title', snippet: 'notes', url: 'portalUrl' },
      query: 'q'
    });
  });

  it('hides actions whose requirements fail or that the installation disables', async () => {
    const names = (
      await adapter.discoverActions({ definition, instance: instanceWith(), document, security })
    ).map(a => a.name);
    assert.ok(!names.includes('query_datastore_sql'));
    const withSql = await adapter.discoverActions({
      definition,
      instance: instanceWith({ datastoreSql: true }, undefined, {
        actions: { enabled: ['*', 'query_datastore_sql'], disabled: ['get_dataset'], overrides: {} }
      }),
      document,
      security
    });
    const sqlNames = withSql.map(a => a.name);
    assert.ok(sqlNames.includes('query_datastore_sql'));
    assert.ok(!sqlNames.includes('get_dataset'));
    const all = await adapter.discoverActions({
      definition,
      instance: instanceWith(),
      document,
      security,
      includeUnavailable: true
    });
    assert.equal(all.find(a => a.name === 'query_datastore_sql').available, false);
  });
});

describe('run', () => {
  it('applies cap, append and fixed defaults, the scope, and serializes arrays as a JSON list', async () => {
    const result = await adapter.run({
      definition,
      instance: instanceWith({
        maxRows: 3,
        defaultFilter: 'res_format:CSV',
        includePrivate: false
      }),
      document,
      security,
      action: searchAction,
      args: {
        q: 'parking',
        rows: 50,
        fq: 'tags:climate',
        include_private: true,
        'facet.field': ['res_format', 'tags']
      },
      context: { scope: { id: 'city', name: 'City Council' } }
    });
    const { query } = requests[0];
    assert.equal(query.get('rows'), '3');
    assert.equal(query.get('fq'), 'organization:city res_format:CSV tags:climate');
    assert.equal(query.get('include_private'), 'false');
    assert.equal(query.get('facet.field'), '["res_format","tags"]');
    assert.equal(query.get('q'), 'parking');
    // envelope unwrapped, hideFields applied, source URLs added
    assert.equal(result.count, 2);
    assert.equal(result.help, undefined);
    assert.equal(result.results[0].extras, undefined);
    assert.equal(result.results[0].portalUrl, `http://127.0.0.1:${port}/dataset/parking`);
  });

  it('turns an API error envelope into a structured error', async () => {
    const result = await adapter.run({
      definition,
      instance: instanceWith(),
      document,
      security,
      action: definition.actions.find(a => a.name === 'get_dataset'),
      args: { id: 'nope' }
    });
    assert.deepEqual(result, {
      error: true,
      status: 404,
      type: 'Not Found Error',
      message: 'Not found'
    });
  });

  it('passes the error object on when the envelope has no message, so the model sees the field', async () => {
    const result = await adapter.run({
      definition,
      instance: instanceWith(),
      document,
      security,
      action: definition.actions.find(a => a.name === 'get_dataset'),
      args: { id: 'bad-id' }
    });
    assert.equal(result.error, true);
    assert.equal(result.status, 409);
    assert.equal(result.type, 'Validation Error');
    assert.deepEqual(result.details, { __type: 'Validation Error', id: ['Missing value'] });
  });

  it('drops a trailing slash of a URL install value before filling templates', async () => {
    const result = await adapter.run({
      definition,
      instance: instanceWith({ baseUrl: `http://127.0.0.1:${port}/` }),
      document,
      security,
      action: searchAction,
      args: { q: 'parking' }
    });
    assert.equal(requests[0].path, '/api/3/action/package_search');
    assert.equal(result.results[0].portalUrl, `http://127.0.0.1:${port}/dataset/parking`);
  });

  it('honours the apiPath install value and injects the shared secret header', async () => {
    setCredentials({
      'integration-portal-apiToken': { id: 'x', type: 'secret', value: 'tok-123' }
    });
    await adapter.run({
      definition,
      instance: instanceWith(
        { apiPath: '/custom', tokenHeader: 'X-CKAN-API-Key' },
        { mode: 'service-account', credentialRef: 'integration-portal-apiToken' }
      ),
      document,
      security,
      action: searchAction,
      args: { q: 'x' }
    });
    assert.equal(requests[0].path, '/custom/package_search');
    assert.equal(requests[0].headers['x-ckan-api-key'], 'tok-123');
  });

  it('refuses a base URL that is not http(s)', async () => {
    await assert.rejects(
      adapter.run({
        definition,
        instance: instanceWith({ baseUrl: 'ftp://x' }),
        document,
        security,
        action: searchAction,
        args: {}
      }),
      /not an http\(s\) URL/
    );
  });
});

describe('listScopes and test', () => {
  it('maps the scope action result to id and name', async () => {
    const scopes = await adapter.listScopes({
      definition,
      instance: instanceWith(),
      document,
      security
    });
    assert.deepEqual(scopes, [
      { id: 'city', name: 'City Council', isDefault: undefined },
      { id: 'nhs', name: 'Health', isDefault: undefined },
      { id: 'rail', name: 'Railways', isDefault: undefined }
    ]);
    assert.equal(requests[0].query.get('all_fields'), 'true');
  });

  it('pages through the scope action until a short page', async () => {
    await adapter.listScopes({ definition, instance: instanceWith(), document, security });
    assert.deepEqual(
      requests.map(r => [r.query.get('offset'), r.query.get('limit')]),
      [
        ['0', '2'],
        ['2', '2']
      ]
    );
  });

  it('asks once, with the operation defaults, when the definition declares no paging', async () => {
    const unpaged = validateIntegrationDefinition({
      ...rawDefinition,
      scopes: { ...rawDefinition.scopes, paging: undefined }
    }).data;
    const scopes = await adapter.listScopes({
      definition: unpaged,
      instance: instanceWith(),
      document,
      security
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].query.get('limit'), '25');
    assert.equal(scopes.length, 2);
  });

  it('reports a successful probe with the action count', async () => {
    const report = await adapter.test({ definition, instance: instanceWith(), document, security });
    assert.equal(report.success, true);
    assert.deepEqual(
      report.steps.map(s => `${s.id}:${s.status}`),
      ['settings:ok', 'probe:ok', 'actions:ok']
    );
    assert.equal(report.actionCount, 3);
    assert.equal(requests[0].query.get('rows'), '0');
  });

  it('fails the probe when the portal is unreachable at the configured path', async () => {
    const report = await adapter.test({
      definition,
      instance: instanceWith({ apiPath: '/nowhere' }),
      document,
      security
    });
    assert.equal(report.success, false);
    assert.equal(report.steps.find(s => s.id === 'probe').status, 'fail');
  });
});
