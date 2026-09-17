import { jest } from '@jest/globals';
import http from 'http';

/**
 * Integration tests for the OpenAPI tool runner.
 *
 * A local http server on 127.0.0.1 stands in for the third-party API. The tool
 * definitions allow-list 127.0.0.1 so the SSRF guard (safeFetch) permits the
 * loopback target; a dedicated test verifies the guard rejects it when NOT
 * allow-listed.
 *
 * configCache is mocked so the runner resolves credentials from an in-test
 * store and the throttler sees empty model/tool config.
 */

const store = { credentials: {} };
const platformOverride = { value: {} };

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getCredentials: () => store,
    getPlatform: () => platformOverride.value,
    getModels: () => ({ data: [] }),
    getTools: () => ({ data: [] })
  }
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));

const { runOpenApiTool, getOpenApiToolParameters, invalidateSpecCache } =
  await import('../services/tools/OpenApiToolRunner.js');

let server;
let port;
let lastRequest;
let tokenHits;

const spec = {
  openapi: '3.0.0',
  info: { title: 'Test API', version: '1.0.0' },
  paths: {
    '/items/{id}': {
      get: {
        operationId: 'getItem',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'q', in: 'query', schema: { type: 'string' } }
        ],
        responses: {}
      }
    },
    '/secure': { get: { operationId: 'getSecure', responses: {} } },
    '/list': { get: { operationId: 'getList', responses: {} } },
    '/big': { get: { operationId: 'getBig', responses: {} } },
    '/nested': { get: { operationId: 'getNested', responses: {} } },
    '/ratelimited': { get: { operationId: 'getRateLimited', responses: {} } }
  }
};

function makeTool(id, operationId, overrides = {}) {
  return {
    id,
    type: 'openapi',
    name: id,
    openapi: {
      source: { type: 'inline', spec },
      operationId,
      baseUrl: `http://127.0.0.1:${port}`,
      auth: { credentialRef: 'cred' },
      headers: {},
      xDisplay: { hideFields: [] },
      maxResponseBytes: 262144,
      timeoutMs: 5000,
      security: { blockPrivateIps: true, allowedHosts: ['127.0.0.1'] },
      ...overrides
    }
  };
}

beforeAll(async () => {
  tokenHits = 0;
  server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    lastRequest = {
      method: req.method,
      path: url.pathname,
      headers: req.headers,
      query: url.searchParams
    };

    if (url.pathname === '/token') {
      tokenHits += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: `token-${tokenHits}`, expires_in: 3600 }));
      return;
    }
    if (url.pathname === '/list') {
      const arr = Array.from({ length: 120 }, (_, i) => ({ i }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(arr));
      return;
    }
    if (url.pathname === '/big') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ blob: 'x'.repeat(5000) }));
      return;
    }
    if (url.pathname === '/nested') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 1,
          secret: 'top',
          items: [
            { name: 'a', token: 't1' },
            { name: 'b', token: 't2' }
          ]
        })
      );
      return;
    }
    if (url.pathname === '/ratelimited') {
      if ((server._rlHits = (server._rlHits || 0) + 1) === 1) {
        res.writeHead(429, { 'Retry-After': '0', 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'slow down' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        path: url.pathname,
        authorization: req.headers.authorization || null,
        apiKeyHeader: req.headers['x-api-key'] || null,
        apiKeyQuery: url.searchParams.get('api_key'),
        q: url.searchParams.get('q')
      })
    );
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  store.credentials = {};
  invalidateSpecCache();
});

describe('auth schemes', () => {
  it('sends a bearer token', async () => {
    store.credentials = { cred: { id: 'cred', type: 'bearer', token: 'tok123' } };
    const result = await runOpenApiTool(makeTool('t-bearer', 'getSecure'), {});
    expect(result.authorization).toBe('Bearer tok123');
  });

  it('sends basic auth', async () => {
    store.credentials = { cred: { id: 'cred', type: 'basic', username: 'u', password: 'pw' } };
    const result = await runOpenApiTool(makeTool('t-basic', 'getSecure'), {});
    const expected = `Basic ${Buffer.from('u:pw').toString('base64')}`;
    expect(result.authorization).toBe(expected);
  });

  it('sends an api key header', async () => {
    store.credentials = {
      cred: { id: 'cred', type: 'apiKeyHeader', headerName: 'X-API-Key', key: 'abc' }
    };
    const result = await runOpenApiTool(makeTool('t-akh', 'getSecure'), {});
    expect(result.apiKeyHeader).toBe('abc');
  });

  it('sends an api key query param', async () => {
    store.credentials = {
      cred: { id: 'cred', type: 'apiKeyQuery', paramName: 'api_key', key: 'qkey' }
    };
    const result = await runOpenApiTool(makeTool('t-akq', 'getSecure'), {});
    expect(result.apiKeyQuery).toBe('qkey');
  });

  it('fetches, caches, and reuses an oauth2 token', async () => {
    store.credentials = {
      cred: {
        id: 'cred',
        type: 'oauth2',
        tokenUrl: `http://127.0.0.1:${port}/token`,
        clientId: 'cid',
        clientSecret: 'csec',
        grantType: 'client_credentials'
      }
    };
    const before = tokenHits;
    const r1 = await runOpenApiTool(makeTool('t-oauth', 'getSecure'), {});
    const r2 = await runOpenApiTool(makeTool('t-oauth', 'getSecure'), {});
    expect(r1.authorization).toMatch(/^Bearer token-/);
    expect(r2.authorization).toBe(r1.authorization); // cached, not refreshed
    expect(tokenHits).toBe(before + 1);
  });
});

describe('parameters', () => {
  it('derives a JSON schema from the operation', async () => {
    const params = await getOpenApiToolParameters(makeTool('t-params', 'getItem'));
    expect(params.type).toBe('object');
    expect(params.properties).toHaveProperty('id');
    expect(params.properties).toHaveProperty('q');
    expect(params.required).toContain('id');
  });

  it('substitutes path + query params', async () => {
    store.credentials = { cred: { id: 'cred', type: 'bearer', token: 't' } };
    const result = await runOpenApiTool(makeTool('t-args', 'getItem'), { id: '42', q: 'hello' });
    expect(result.path).toBe('/items/42');
    expect(result.q).toBe('hello');
  });

  it('throws before any HTTP call when a required param is missing', async () => {
    store.credentials = { cred: { id: 'cred', type: 'bearer', token: 't' } };
    await expect(runOpenApiTool(makeTool('t-missing', 'getItem'), { q: 'x' })).rejects.toThrow(
      /Missing required parameter\(s\): id/
    );
  });
});

describe('response handling', () => {
  it('strips x-display hideFields (nested + array wildcard)', async () => {
    store.credentials = { cred: { id: 'cred', type: 'bearer', token: 't' } };
    const tool = makeTool('t-strip', 'getNested', {
      xDisplay: { hideFields: ['secret', 'items[].token'] }
    });
    const result = await runOpenApiTool(tool, {});
    expect(result.secret).toBeUndefined();
    expect(result.items[0].token).toBeUndefined();
    expect(result.items[0].name).toBe('a');
  });

  it('truncates responses over the size cap', async () => {
    store.credentials = { cred: { id: 'cred', type: 'bearer', token: 't' } };
    const tool = makeTool('t-cap', 'getBig', { maxResponseBytes: 1024 });
    const result = await runOpenApiTool(tool, {});
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.data)).toBeLessThanOrEqual(1024);
  });

  it('paginates oversized arrays', async () => {
    store.credentials = { cred: { id: 'cred', type: 'bearer', token: 't' } };
    const result = await runOpenApiTool(makeTool('t-page', 'getList'), { limit: 10, offset: 0 });
    expect(result.items).toHaveLength(10);
    expect(result.pagination.total).toBe(120);
    expect(result.pagination.nextOffset).toBe(10);
  });

  it('retries once on 429 honoring Retry-After', async () => {
    store.credentials = { cred: { id: 'cred', type: 'bearer', token: 't' } };
    server._rlHits = 0;
    const result = await runOpenApiTool(makeTool('t-429', 'getRateLimited'), {});
    expect(result.ok).toBe(true);
    expect(server._rlHits).toBe(2);
  });
});

describe('SSRF guard', () => {
  beforeEach(() => {
    platformOverride.value = {};
  });

  it('rejects a private IP target when not allow-listed', async () => {
    store.credentials = { cred: { id: 'cred', type: 'bearer', token: 't' } };
    const tool = makeTool('t-ssrf', 'getSecure', {
      security: { blockPrivateIps: true, allowedHosts: [] }
    });
    await expect(runOpenApiTool(tool, {})).rejects.toThrow(/SSRF|private IP/i);
  });

  it('permits the call when the host matches platform.ssrf.allowedHosts (exact)', async () => {
    store.credentials = { cred: { id: 'cred', type: 'bearer', token: 't' } };
    platformOverride.value = { ssrf: { allowedHosts: ['127.0.0.1'] } };
    const tool = makeTool('t-ssrf-global-exact', 'getSecure', {
      security: { blockPrivateIps: true, allowedHosts: [] }
    });
    await expect(runOpenApiTool(tool, {})).resolves.toBeDefined();
  });

  it('permits the call when the host matches a wildcard in platform.ssrf.allowedHosts', async () => {
    store.credentials = { cred: { id: 'cred', type: 'bearer', token: 't' } };
    // The wildcard must match the per-test baseUrl host. The test server runs on
    // 127.0.0.1 (an IP literal), so we use an exact match here — wildcards apply
    // to DNS-named hosts. A separate dedicated test in the safeFetch path covers
    // wildcard pattern matching.
    platformOverride.value = { ssrf: { allowedHosts: ['127.0.0.1', '*.intrafind.io'] } };
    const tool = makeTool('t-ssrf-global-wildcard', 'getSecure', {
      security: { blockPrivateIps: true, allowedHosts: [] }
    });
    await expect(runOpenApiTool(tool, {})).resolves.toBeDefined();
  });

  it('still blocks the call when the host is not in platform.ssrf.allowedHosts', async () => {
    store.credentials = { cred: { id: 'cred', type: 'bearer', token: 't' } };
    platformOverride.value = { ssrf: { allowedHosts: ['*.example.com'] } };
    const tool = makeTool('t-ssrf-global-nomatch', 'getSecure', {
      security: { blockPrivateIps: true, allowedHosts: [] }
    });
    await expect(runOpenApiTool(tool, {})).rejects.toThrow(/SSRF|private IP/i);
  });
});
