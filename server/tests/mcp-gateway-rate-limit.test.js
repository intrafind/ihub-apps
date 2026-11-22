// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The MCP gateway (`/mcp`, `/a2a`) and the MCP OAuth callback live outside
 * `/api/<namespace>`, so the app-level limiters of middleware/setup.js do not
 * reach them. Each route carries the public API limiter itself. It runs after
 * authentication, so it counts per signed-in caller: two users behind one
 * address do not share a bucket, and a refused (unauthenticated) request never
 * spends one.
 *
 * Run with `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const platform = {
  // Failed requests count too, so the answers of the stubbed handlers (405 for a GET without a
  // session) spend the budget like any other.
  rateLimit: { publicApi: { limit: 3, windowMs: 60000, skipFailedRequests: false } },
  mcpServer: {
    enabled: true,
    transports: { streamableHttp: { enabled: true } },
    a2a: { enabled: true }
  }
};

jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: () => platform },
  resolveEnvVarsInObject: value => value
}));

// Bearer `<user>` signs that user in; anything else is refused, as mcpAuth does.
jest.unstable_mockModule('../middleware/mcpAuth.js', () => ({
  default: (req, res, next) => {
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
    if (!match) return res.status(401).json({ error: 'invalid_token' });
    req.user = { id: match[1], scopes: ['mcp:tools:read'] };
    return next();
  },
  MCP_METHOD_SCOPES: {}
}));
jest.unstable_mockModule('../services/mcp/McpServerService.js', () => ({
  buildMcpServer: jest.fn()
}));
// The A2A handler pulls in the whole chat stack; the routes only need its names.
jest.unstable_mockModule('../services/mcp/a2aHandler.js', () => ({
  dispatchA2A: jest.fn(async () => ({ jsonrpc: '2.0', id: 1, result: {} })),
  buildAgentCard: jest.fn(() => ({})),
  A2aError: class A2aError extends Error {},
  A2A_ERRORS: {}
}));
jest.unstable_mockModule('../services/mcp/a2aTaskStore.js', () => ({
  getA2aTaskStore: () => ({ sweep: async () => {} })
}));
jest.unstable_mockModule('../clusterBus.js', () => ({
  isClusterBusActive: () => false,
  respondInPrimary: () => () => {},
  gather: async () => [],
  createPresenceMap: () => new Map(),
  hasRemote: () => false,
  lookupRemote: async () => false,
  publish: () => true,
  subscribe: () => () => {},
  respond: () => () => {},
  request: async () => null
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerMcpServerRoutes } = await import('../routes/mcpServer.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

function makeApp() {
  const app = express();
  registerMcpServerRoutes(app);
  app.use(errorHandler);
  return app;
}

const asUser = (call, user) => call.set('Authorization', `Bearer ${user}`);

describe('MCP gateway rate limit', () => {
  it('stops a caller on /mcp once the public API budget is spent', async () => {
    const app = makeApp();
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      // A GET without a session answers 405 (no push stream): the handler ran, the limiter let it.
      statuses.push((await asUser(request(app).get('/mcp'), 'ada')).status);
    }
    expect(statuses.slice(0, 3).every(status => status !== 429)).toBe(true);
    expect(statuses.slice(3)).toEqual([429, 429]);
  });

  it('counts per user, so a second user on the same address has a budget of their own', async () => {
    const app = makeApp();
    for (let i = 0; i < 4; i++) await asUser(request(app).get('/mcp'), 'ada');
    expect((await asUser(request(app).get('/mcp'), 'ada')).status).toBe(429);
    expect((await asUser(request(app).get('/mcp'), 'grace')).status).not.toBe(429);
  });

  it('shares one budget between GET, POST and DELETE on /mcp', async () => {
    const app = makeApp();
    await asUser(request(app).get('/mcp'), 'ada');
    await asUser(request(app).post('/mcp').send({}), 'ada');
    await asUser(request(app).delete('/mcp'), 'ada');
    expect((await asUser(request(app).get('/mcp'), 'ada')).status).toBe(429);
  });

  it('limits the A2A JSON-RPC endpoint too', async () => {
    const app = makeApp();
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await asUser(request(app).post('/a2a').send({}), 'ada')).status);
    }
    expect(statuses.slice(3)).toEqual([429, 429]);
  });

  it('does not spend a budget on requests that fail authentication', async () => {
    const app = makeApp();
    for (let i = 0; i < 6; i++) {
      expect((await request(app).get('/mcp')).status).toBe(401);
    }
    expect((await asUser(request(app).get('/mcp'), 'ada')).status).not.toBe(429);
  });

  it('answers a refused request as a problem document with the RATE_LIMITED code', async () => {
    const app = makeApp();
    for (let i = 0; i < 3; i++) await asUser(request(app).get('/mcp'), 'ada');
    const res = await asUser(request(app).get('/mcp'), 'ada');
    expect(res.status).toBe(429);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(res.headers['retry-after']).toBeDefined();
  });
});
