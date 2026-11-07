// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * The retired legacy SSE transport (routes/mcpServer.js): GET /mcp/sse and
 * POST /mcp/messages answer 410 Gone with a JSON-RPC error that names
 * Streamable HTTP and a bridge. No authentication is needed for the answer.
 */

let platform;
jest.unstable_mockModule('../../configCache.js', () => ({
  default: {
    getPlatform: () => platform,
    getApps: () => ({ data: [] }),
    getWorkflows: () => ({ data: [] }),
    getUI: () => ({ data: {} })
  },
  resolveEnvVarsInObject: value => value
}));
jest.unstable_mockModule('../../middleware/mcpAuth.js', () => ({
  default: (req, res) => res.status(401).json({ error: 'invalid_token' }),
  MCP_METHOD_SCOPES: {}
}));
jest.unstable_mockModule('../../services/mcp/McpServerService.js', () => ({
  buildMcpServer: jest.fn()
}));
jest.unstable_mockModule('../../services/mcp/appInvoker.js', () => ({
  invokeApp: jest.fn(),
  invokeAppNonStreaming: jest.fn()
}));
jest.unstable_mockModule('../../services/tools/catalog.js', () => ({
  loadConfiguredTools: jest.fn(async () => []),
  loadLocalTools: jest.fn(async () => [])
}));
jest.unstable_mockModule('../../services/tools/runTool.js', () => ({ runTool: jest.fn() }));
jest.unstable_mockModule('../../services/mcp/permissions.js', () => ({
  getVisibleToolIds: jest.fn(async () => new Set()),
  toolVisibleInSet: () => false
}));
jest.unstable_mockModule('../../utils/versionHelper.js', () => ({ getAppVersion: () => '1.2.3' }));
jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));
jest.unstable_mockModule('../../storage/bootstrap.js', () => ({
  getStorage: () => null,
  readFacet: () => null,
  requireStorage: () => {
    throw new Error('storage is not bootstrapped in this test');
  }
}));
jest.unstable_mockModule('../../clusterBus.js', () => ({
  publish: jest.fn(() => false),
  subscribe: jest.fn(() => () => {}),
  request: jest.fn(async () => null),
  respond: jest.fn(() => () => {}),
  createPresenceMap: () => new Map(),
  hasRemote: () => false,
  isClusterBusActive: () => false,
  respondInPrimary: () => () => {},
  gather: async () => []
}));

const { default: registerMcpServerRoutes } = await import('../../routes/mcpServer.js');

const app = express();
registerMcpServerRoutes(app);

beforeEach(() => {
  platform = {
    mcpServer: { enabled: true, transports: { streamableHttp: { enabled: true } } }
  };
});

describe('retired legacy SSE transport', () => {
  it.each([
    ['get', '/mcp/sse'],
    ['post', '/mcp/messages?sessionId=abc']
  ])('%s %s answers 410 Gone naming Streamable HTTP and a bridge', async (method, path) => {
    const res = await request(app)[method](path);
    expect(res.status).toBe(410);
    expect(res.body.jsonrpc).toBe('2.0');
    expect(res.body.error.message).toMatch(/Streamable HTTP/);
    expect(res.body.error.message).toMatch(/mcp-remote/);
  });

  it('is not advertised in discovery', async () => {
    const res = await request(app).get('/mcp/.well-known');
    expect(res.status).toBe(200);
    expect(res.body.transports).not.toContain('sse');
    expect(res.body).not.toHaveProperty('mcp_sse_endpoint');
  });

  it('stays hidden (404) while the gateway is disabled', async () => {
    platform.mcpServer.enabled = false;
    const res = await request(app).get('/mcp/sse');
    expect(res.status).toBe(404);
  });
});
