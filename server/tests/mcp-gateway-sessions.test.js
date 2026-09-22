import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Session-handling contract of the Streamable HTTP gateway (routes/mcpServer.js).
 *
 * The MCP spec is specific about how a server answers a request it cannot map
 * to a live session, and clients depend on those exact statuses to recover:
 *   - unknown / expired session id  -> 404, client opens a new session
 *   - non-initialize POST, no id    -> 400, client must initialize first
 *   - GET without a session         -> 405, server offers no push stream
 *
 * Before this was fixed the gateway silently built a fresh, uninitialized
 * transport for all three cases, so the SDK answered 400 "Server not
 * initialized" every time. Clients treat that as a fatal protocol error, which
 * is why an MCP client could authenticate successfully and still never connect.
 */

const buildMcpServer = jest.fn();

jest.unstable_mockModule('../services/mcp/McpServerService.js', () => ({
  buildMcpServer
}));

let currentUserId = 'user-1';

jest.unstable_mockModule('../middleware/mcpAuth.js', () => ({
  default: (req, res, next) => {
    req.user = { id: currentUserId, scopes: ['mcp:tools:read'] };
    next();
  },
  MCP_METHOD_SCOPES: {}
}));

const platform = {
  mcpServer: {
    enabled: true,
    transports: { streamableHttp: { enabled: true }, sse: { enabled: false } }
  }
};

jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: () => platform }
}));

// Stand in for the SDK transport so the tests can inspect the options the
// gateway constructs it with, and drive the session lifecycle deterministically.
const transports = [];
// The id the fake transport hands out when it accepts an initialize request.
let nextSessionId = 'session-1';

class FakeStreamableHTTPServerTransport {
  constructor(options) {
    this.options = options;
    this.sessionId = undefined;
    this.handleRequest = jest.fn(async (req, res, body) => {
      // Mirror the real SDK: on initialize, assign the id and fire the
      // onsessioninitialized callback *while still handling the request*.
      if (body?.method === 'initialize' && options.sessionIdGenerator) {
        this.sessionId = nextSessionId;
        await options.onsessioninitialized?.(this.sessionId);
      }
      res.status(200).json({ handled: true, session: this.sessionId ?? null });
    });
    transports.push(this);
  }
}

jest.unstable_mockModule('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: FakeStreamableHTTPServerTransport
}));

const { default: registerMcpServerRoutes } = await import('../routes/mcpServer.js');

function makeApp() {
  const app = express();
  registerMcpServerRoutes(app);
  return app;
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 't', version: '1' }
  }
};

describe('MCP gateway session handling', () => {
  beforeEach(() => {
    buildMcpServer.mockReset();
    transports.length = 0;
    platform.mcpServer.transports.streamableHttp.stateless = false;
  });

  it('answers 404 Session not found for an unknown session id', async () => {
    const res = await request(makeApp())
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('mcp-session-id', '11111111-1111-1111-1111-111111111111')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(-32001);
    expect(res.body.error.message).toMatch(/Session not found/);
    // No McpServer should be built for a request that cannot be served.
    expect(buildMcpServer).not.toHaveBeenCalled();
  });

  it('answers 400 with the session-header hint for a non-initialize POST', async () => {
    const res = await request(makeApp())
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Mcp-Session-Id header is required/);
    expect(buildMcpServer).not.toHaveBeenCalled();
  });

  it('answers 405 for GET without a session instead of a confusing 400', async () => {
    const res = await request(makeApp()).get('/mcp').set('Accept', 'text/event-stream');

    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('POST, DELETE');
    expect(buildMcpServer).not.toHaveBeenCalled();
  });

  it('answers 405 for GET in stateless mode', async () => {
    platform.mcpServer.transports.streamableHttp.stateless = true;
    const close = jest.fn();
    buildMcpServer.mockResolvedValue({ connect: jest.fn(), close });

    const res = await request(makeApp()).get('/mcp').set('Accept', 'text/event-stream');

    expect(res.status).toBe(405);
    // The per-request server must be released, not leaked.
    expect(close).toHaveBeenCalled();
  });

  it('serves any POST in stateless mode, with no session id and no session state', async () => {
    platform.mcpServer.transports.streamableHttp.stateless = true;
    const close = jest.fn();
    buildMcpServer.mockResolvedValue({ connect: jest.fn(), close });

    // A session id from some other replica must not make the request fail.
    const res = await request(makeApp())
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('mcp-session-id', '33333333-3333-3333-3333-333333333333')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

    expect(res.status).toBe(200);
    expect(transports).toHaveLength(1);
    // Stateless: the SDK transport must not generate session ids.
    expect(transports[0].options.sessionIdGenerator).toBeUndefined();
    expect(close).toHaveBeenCalled();
  });

  it('registers the session from onsessioninitialized, before the client can use it', async () => {
    // The SDK fires onsessioninitialized while the initialize request is still
    // being handled. Registering after handleRequest() resolves instead leaves a
    // window in which the client already holds its session id but the gateway
    // does not know it yet — and the client's very next request 404s.
    buildMcpServer.mockResolvedValue({ connect: jest.fn(), close: jest.fn() });
    nextSessionId = '44444444-4444-4444-4444-444444444444';
    const app = makeApp();

    const init = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send(INITIALIZE);
    expect(init.status).toBe(200);

    expect(transports).toHaveLength(1);
    expect(typeof transports[0].options.onsessioninitialized).toBe('function');
    expect(typeof transports[0].options.sessionIdGenerator).toBe('function');

    // The session the callback registered is routable — no 404.
    const followUp = await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('mcp-session-id', nextSessionId)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

    expect(followUp.status).toBe(200);
    // Reused the existing transport rather than building a second server.
    expect(transports).toHaveLength(1);
    expect(buildMcpServer).toHaveBeenCalledTimes(1);
  });

  it('releases the McpServer when wiring the transport to it fails', async () => {
    // buildMcpServer succeeded, so something holds real resources; failing to
    // connect must not leave it dangling behind the 500.
    const close = jest.fn();
    buildMcpServer.mockResolvedValue({
      connect: jest.fn().mockRejectedValue(new Error('adapter init failed')),
      close
    });

    const res = await request(makeApp())
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send(INITIALIZE);

    expect(res.status).toBe(500);
    expect(close).toHaveBeenCalled();
  });

  it('refuses to terminate a session owned by another user', async () => {
    buildMcpServer.mockResolvedValue({ connect: jest.fn(), close: jest.fn() });
    nextSessionId = '55555555-5555-5555-5555-555555555555';
    const app = makeApp();

    await request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send(INITIALIZE);

    // mcpAuth is stubbed to authenticate whoever currentUserId names, so switch
    // identity to simulate a session that belongs to somebody else.
    currentUserId = 'someone-else';
    try {
      const res = await request(app).delete('/mcp').set('mcp-session-id', nextSessionId);
      expect(res.status).toBe(403);
    } finally {
      currentUserId = 'user-1';
    }
  });

  it('treats terminating an unknown session as a no-op', async () => {
    const res = await request(makeApp())
      .delete('/mcp')
      .set('mcp-session-id', '66666666-6666-6666-6666-666666666666');
    expect(res.status).toBe(204);
  });
});
