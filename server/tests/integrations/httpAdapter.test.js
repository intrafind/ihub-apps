// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The `http` protocol: request templates (escaping per position), the
 * JSONPath response mapping, and the outbound path (SSRF guard, certificate
 * whitelist, no redirects) on local servers.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Outbound calls in this suite go to local servers only.
for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY']) {
  delete process.env[name];
}

const { default: configCache } = await import('../../configCache.js');
const { buildHttpRequest, mapHttpResponse, undeclaredPlaceholders } =
  await import('../../services/integrations/protocols/http/httpTemplates.js');
const adapter = await import('../../services/integrations/protocols/http/HttpAdapter.js');
const { getProtocolAdapter } = await import('../../services/integrations/protocols/index.js');
const { validateIntegrationDefinition } =
  await import('../../validators/integrationDefinitionSchema.js');

let platform = { ssl: { ignoreInvalidCertificates: false, domainWhitelist: [] } };
const originalGetPlatform = configCache.getPlatform;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-http-adapter-'));

const fillBase = template => template;

function definitionFor(baseUrl, actions, extra = {}) {
  const result = validateIntegrationDefinition({
    id: 'custom/orders',
    version: '1.0.0',
    name: { en: 'Orders' },
    protocol: { type: 'http', baseUrl },
    auth: { modes: ['none'] },
    actions,
    ...extra
  });
  assert.equal(result.success, true, JSON.stringify(result.errors));
  return result.data;
}

const getOrder = {
  name: 'get_order',
  sideEffect: 'read',
  dataFlow: 'internal',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string' }, expand: { type: 'string' } },
    required: ['id']
  },
  request: { method: 'GET', url: '/orders/{id}', query: { expand: '{expand}' } },
  response: { result: '$.data.lines', fields: { sku: 'sku', qty: 'quantity.value' } }
};

const instance = { id: 'orders', definition: 'custom/orders', enabled: true, values: {} };

before(() => {
  configCache.getPlatform = () => platform;
});

after(() => {
  configCache.getPlatform = originalGetPlatform;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('http protocol: definition and registration', () => {
  it('is an adapter', () => {
    assert.equal(getProtocolAdapter('http'), adapter);
    assert.deepEqual(adapter.supportedAuthModes, ['none', 'service-account']);
  });

  it('needs a request per action and a base URL for relative paths', () => {
    const noRequest = validateIntegrationDefinition({
      id: 'custom/x',
      version: '1.0.0',
      name: { en: 'X' },
      protocol: { type: 'http', baseUrl: 'https://x.example' },
      auth: { modes: ['none'] },
      actions: [{ name: 'a' }]
    });
    assert.equal(noRequest.success, false);
    const relative = validateIntegrationDefinition({
      id: 'custom/x',
      version: '1.0.0',
      name: { en: 'X' },
      protocol: { type: 'http' },
      auth: { modes: ['none'] },
      actions: [{ name: 'a', request: { url: '/a' } }]
    });
    assert.equal(relative.success, false);
  });

  it('refuses a body on GET', () => {
    const result = validateIntegrationDefinition({
      id: 'custom/x',
      version: '1.0.0',
      name: { en: 'X' },
      protocol: { type: 'http', baseUrl: 'https://x.example' },
      auth: { modes: ['none'] },
      actions: [{ name: 'a', request: { method: 'GET', url: '/a', body: '{}' } }]
    });
    assert.equal(result.success, false);
  });

  it('proposes the side effect from the method', () => {
    assert.equal(adapter.sideEffectOfMethod('GET'), 'read');
    assert.equal(adapter.sideEffectOfMethod('post'), 'write');
    assert.equal(adapter.sideEffectOfMethod('DELETE'), 'destructive');
  });
});

describe('http protocol: template escaping', () => {
  const protocol = { baseUrl: 'https://erp.example.com/api/' };

  it('percent-encodes path values, so an argument cannot change the path or host', () => {
    const built = buildHttpRequest({
      protocol,
      request: { url: '/orders/{id}' },
      args: { id: 'A/1?x=@evil.example#' },
      values: {},
      fillBase
    });
    assert.equal(built.url, 'https://erp.example.com/api/orders/A%2F1%3Fx%3D%40evil.example%23');
  });

  it('refuses a dot segment as a path value', () => {
    for (const id of ['..', '.']) {
      assert.throws(
        () =>
          buildHttpRequest({
            protocol,
            request: { url: '/orders/{id}' },
            args: { id },
            values: {},
            fillBase
          }),
        error => error.code === 'HTTP_TEMPLATE_URL'
      );
    }
  });

  it('leaves out a query parameter whose placeholder has no value', () => {
    const built = buildHttpRequest({
      protocol,
      request: { url: '/orders', query: { q: '{q}', limit: '{limit}', fixed: 'yes' } },
      args: { q: 'a&b=c' },
      values: {},
      fillBase
    });
    const url = new URL(built.url);
    assert.equal(url.searchParams.get('q'), 'a&b=c');
    assert.equal(url.searchParams.has('limit'), false);
    assert.equal(url.searchParams.get('fixed'), 'yes');
  });

  it('JSON-encodes values in a JSON body', () => {
    const built = buildHttpRequest({
      protocol,
      request: {
        method: 'POST',
        url: '/search',
        body: '{"query": {query}, "limit": {limit}, "tags": {tags}, "missing": {missing}}',
        contentType: 'application/json'
      },
      args: { query: 'say "hi"\n}, "admin": true, "x": {', limit: 5, tags: ['a', 'b'] },
      values: {},
      fillBase
    });
    assert.deepEqual(JSON.parse(built.body), {
      query: 'say "hi"\n}, "admin": true, "x": {',
      limit: 5,
      tags: ['a', 'b'],
      missing: null
    });
    assert.equal(built.headers['Content-Type'], 'application/json');
  });

  it('refuses a JSON body template that is not JSON', () => {
    assert.throws(
      () =>
        buildHttpRequest({
          protocol,
          request: {
            method: 'POST',
            url: '/x',
            body: '{"a": {a}',
            contentType: 'application/json'
          },
          args: { a: 1 },
          values: {},
          fillBase
        }),
      error => error.code === 'HTTP_TEMPLATE_BODY'
    );
  });

  it('form-encodes values in a form body', () => {
    const built = buildHttpRequest({
      protocol,
      request: {
        method: 'POST',
        url: '/x',
        body: 'name={name}&role=reader',
        contentType: 'application/x-www-form-urlencoded'
      },
      args: { name: 'a&role=admin' },
      values: {},
      fillBase
    });
    assert.equal(built.body, 'name=a%26role%3Dadmin&role=reader');
  });

  it('refuses a header value with a line break', () => {
    assert.throws(
      () =>
        buildHttpRequest({
          protocol,
          request: { url: '/x', headers: { 'X-Trace': '{trace}' } },
          args: { trace: 'a\r\nX-Admin: 1' },
          values: {},
          fillBase
        }),
      error => error.code === 'HTTP_TEMPLATE_HEADER'
    );
  });

  it('fills placeholders from install values when no argument has the name', () => {
    const built = buildHttpRequest({
      protocol,
      request: { url: '/tenants/{tenant}/orders' },
      args: {},
      values: { tenant: 'acme' },
      fillBase
    });
    assert.equal(built.url, 'https://erp.example.com/api/tenants/acme/orders');
  });

  it('names the placeholders no parameter or install field provides', () => {
    assert.deepEqual(
      undeclaredPlaceholders(
        { url: '/orders/{id}', query: { q: '{q}' }, body: '{"a": {tenant}}' },
        { type: 'object', properties: { id: {} } },
        ['tenant']
      ),
      ['q']
    );
  });
});

describe('http protocol: JSONPath response mapping', () => {
  const data = {
    data: {
      lines: [
        { sku: 'A', quantity: { value: 2 }, internal: 'x' },
        { sku: 'B', quantity: { value: 1 } }
      ]
    }
  };

  it('picks the result and projects every element onto the fields', () => {
    assert.deepEqual(mapHttpResponse(data, getOrder.response), [
      { sku: 'A', qty: 2 },
      { sku: 'B', qty: 1 }
    ]);
  });

  it('picks without fields, and returns the body without a mapping', () => {
    assert.deepEqual(mapHttpResponse(data, { result: 'data.lines[].sku' }), ['A', 'B']);
    assert.equal(mapHttpResponse(data, undefined), data);
    assert.equal(mapHttpResponse(data, { result: '$.nope' }), null);
  });
});

describe('http protocol: calls through the SSRF guard', () => {
  let server;
  let base;
  const requests = [];

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url, headers: req.headers, body });
        if (req.url.startsWith('/redirect')) {
          res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' });
          res.end();
          return;
        }
        if (req.url.startsWith('/fail')) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'no such order' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: { lines: [{ sku: 'A', quantity: { value: 2 }, secret: 'x' }] }
          })
        );
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  it('blocks a private address unless it is allowed', async () => {
    const definition = definitionFor(base, [getOrder]);
    await assert.rejects(
      adapter.run({
        definition,
        instance,
        action: definition.actions[0],
        args: { id: '7' },
        security: { blockPrivateIps: true, allowedHosts: [] }
      }),
      error => error.code === 'SSRF_BLOCKED'
    );
    assert.equal(requests.length, 0, 'nothing was sent');
  });

  it('calls an allowed test endpoint and maps the response', async () => {
    requests.length = 0;
    const definition = definitionFor(base, [getOrder], {
      auth: { modes: ['service-account'], serviceAccount: { kind: 'bearer', field: 'secret' } },
      install: [{ key: 'secret', type: 'secret', title: { en: 'Secret' }, required: true }]
    });
    const result = await adapter.run({
      definition,
      instance: { ...instance, auth: { mode: 'service-account', credentialRef: 'erp' } },
      action: definition.actions[0],
      args: { id: 'A/7', expand: 'lines' },
      security: { blockPrivateIps: true, allowedHosts: ['127.0.0.1'] },
      resolveSecret: ref => (ref === 'erp' ? 'token-1' : null)
    });
    assert.deepEqual(result, [{ sku: 'A', qty: 2 }]);
    assert.equal(requests[0].url, '/orders/A%2F7?expand=lines');
    assert.equal(requests[0].headers.authorization, 'Bearer token-1');
  });

  it('sends a JSON body template', async () => {
    requests.length = 0;
    const definition = definitionFor(base, [
      {
        name: 'create',
        sideEffect: 'write',
        parameters: { type: 'object', properties: { note: { type: 'string' } } },
        request: { method: 'POST', url: '/orders', body: '{"note": {note}}' }
      }
    ]);
    await adapter.run({
      definition,
      instance,
      action: definition.actions[0],
      args: { note: 'a "quoted" note' },
      security: { blockPrivateIps: false, allowedHosts: [] }
    });
    assert.equal(requests[0].method, 'POST');
    assert.deepEqual(JSON.parse(requests[0].body), { note: 'a "quoted" note' });
    assert.equal(requests[0].headers['content-type'], 'application/json');
  });

  it('does not follow a redirect', async () => {
    requests.length = 0;
    const definition = definitionFor(base, [
      { name: 'r', sideEffect: 'read', request: { url: '/redirect' } }
    ]);
    const result = await adapter.run({
      definition,
      instance,
      action: definition.actions[0],
      args: {},
      security: { blockPrivateIps: false, allowedHosts: [] }
    });
    assert.equal(result.error, true);
    assert.equal(result.status, 302);
    assert.equal(requests.length, 1, 'only the first request was sent');
  });

  it('reports an HTTP error with the API message', async () => {
    const definition = definitionFor(base, [
      { name: 'f', sideEffect: 'read', request: { url: '/fail' } }
    ]);
    const result = await adapter.run({
      definition,
      instance,
      action: definition.actions[0],
      args: {},
      security: { blockPrivateIps: false, allowedHosts: [] }
    });
    assert.deepEqual(result, { error: true, status: 404, message: 'no such order' });
  });

  it('tests an installation with its first read action without required arguments', async () => {
    const definition = definitionFor(base, [
      getOrder,
      { name: 'list', sideEffect: 'read', request: { url: '/orders' } }
    ]);
    const report = await adapter.test({
      definition,
      instance,
      security: { blockPrivateIps: true, allowedHosts: ['127.0.0.1'] }
    });
    assert.equal(report.success, true, JSON.stringify(report.steps));
    assert.equal(report.steps.find(step => step.id === 'probe').label, 'Action list');
  });

  it('lists the actions with their schema, side effect and installation overrides', async () => {
    const definition = definitionFor(base, [getOrder]);
    const actions = await adapter.discoverActions({
      definition,
      instance: {
        ...instance,
        actions: { overrides: { get_order: { description: { en: 'Admin text' } } } }
      }
    });
    assert.equal(actions[0].toolId, 'orders__get_order');
    assert.equal(actions[0].description, 'Admin text');
    assert.equal(actions[0].dataFlow, 'internal');
    assert.deepEqual(actions[0].parameters.required, ['id']);
  });
});

describe('http protocol: certificate whitelist', () => {
  let httpsServer;
  let port;
  const certDir = path.join(tmpRoot, 'cert');

  before(async () => {
    fs.mkdirSync(certDir, { recursive: true });
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-keyout',
        path.join(certDir, 'key.pem'),
        '-out',
        path.join(certDir, 'cert.pem')
      ],
      { stdio: 'ignore' }
    );
    httpsServer = https.createServer(
      {
        key: fs.readFileSync(path.join(certDir, 'key.pem')),
        cert: fs.readFileSync(path.join(certDir, 'cert.pem'))
      },
      (req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      }
    );
    // The wildcard (dual stack where the host has IPv6): `localhost` may
    // resolve to ::1 first (CI runners), and 127.0.0.1 must answer too.
    await new Promise(resolve => httpsServer.listen(0, resolve));
    port = httpsServer.address().port;
    platform = { ssl: { ignoreInvalidCertificates: true, domainWhitelist: ['localhost'] } };
  });

  after(() => {
    httpsServer.close();
    platform = { ssl: { ignoreInvalidCertificates: false, domainWhitelist: [] } };
  });

  function callOn(host) {
    const definition = definitionFor(`https://${host}:${port}`, [
      { name: 'ping', sideEffect: 'read', request: { url: '/ping' } }
    ]);
    return adapter.run({
      definition,
      instance,
      action: definition.actions[0],
      args: {},
      security: { blockPrivateIps: true, allowedHosts: ['localhost', '127.0.0.1'] }
    });
  }

  it('reaches a whitelisted host with a self-signed certificate', async () => {
    assert.deepEqual(await callOn('localhost'), { ok: true });
  });

  it('rejects the same certificate on a host that is not whitelisted', async () => {
    // Refused for the certificate, not for an unreachable server.
    await assert.rejects(callOn('127.0.0.1'), error =>
      /CERT|SELF_SIGNED/.test(error.cause?.code || error.code || '')
    );
  });
});
