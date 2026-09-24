import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * MCP Apps host routes: the sandbox page and its CSP header, and the
 * authorization every view request passes — the caller can open the app, the
 * app offers the tool, the tool renders a view, and a view may only reach
 * app-callable tools of that same MCP server.
 */

let apps = [];
const findTool = jest.fn();

jest.unstable_mockModule('../../configCache.js', () => ({
  default: {
    getPlatform: () => ({ anonymousAuth: { enabled: false }, auth: {} }),
    getAppsForUser: jest.fn(async () => ({ data: apps }))
  }
}));
jest.unstable_mockModule('../../middleware/authRequired.js', () => ({
  authRequired: (req, _res, next) => {
    if (req.headers['x-test-user']) {
      req.user = { id: req.headers['x-test-user'], groups: ['users'], permissions: {} };
    }
    next();
  }
}));
jest.unstable_mockModule('../../services/mcp/McpClientManager.js', () => ({
  default: { findTool }
}));
jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

const { default: registerMcpAppRoutes, resolveMcpApp } =
  await import('../../routes/mcpAppRoutes.js');

const app = express();
app.use(express.json());
registerMcpAppRoutes(app);

const RESOURCE = {
  uri: 'ui://excalidraw/mcp-app.html',
  html: '<!doctype html><p>view</p>',
  csp: {
    connectDomains: [],
    resourceDomains: ['https://esm.sh'],
    frameDomains: [],
    baseUriDomains: []
  },
  permissions: { clipboardWrite: {} },
  prefersBorder: true
};

function fakeConnection() {
  const appTools = new Map([
    [
      'create_view',
      { name: 'create_view', ui: { resourceUri: RESOURCE.uri, visibility: ['model', 'app'] } }
    ],
    ['save_checkpoint', { name: 'save_checkpoint', ui: { resourceUri: null, visibility: ['app'] } }]
  ]);
  return {
    config: { id: 'excalidraw' },
    getUiResource: jest.fn(async () => RESOURCE),
    getAppTool: jest.fn(async name => appTools.get(name) || null),
    callToolRaw: jest.fn(async () => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { saved: true },
      leaked: 'internal'
    })),
    readResource: jest.fn(async uri => ({ contents: [{ uri, text: 'data' }] }))
  };
}

const VIEW_TOOL = {
  id: 'excalidraw__create_view',
  description: 'Draw',
  parameters: { type: 'object', properties: { elements: { type: 'string' } } },
  _mcp: { serverId: 'excalidraw', originalName: 'create_view', ui: { resourceUri: RESOURCE.uri } }
};

let conn;
beforeEach(() => {
  apps = [{ id: 'whiteboard', tools: ['excalidraw__create_view'] }];
  conn = fakeConnection();
  findTool.mockReset();
  findTool.mockImplementation(async id => (id === VIEW_TOOL.id ? { conn, tool: VIEW_TOOL } : null));
});

const asUser = req => req.set('x-test-user', 'u1');
const ref = { appId: 'whiteboard', toolId: 'excalidraw__create_view' };

describe('GET /api/mcp-apps/sandbox', () => {
  it('serves the proxy page with a CSP header built from the sanitized domains', async () => {
    const csp = JSON.stringify({
      resourceDomains: ['https://esm.sh', "x; script-src 'unsafe-hashes'"],
      connectDomains: ['https://api.example']
    });
    const res = await request(app).get('/api/mcp-apps/sandbox').query({ csp });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['x-frame-options']).toBeUndefined();
    const header = res.headers['content-security-policy'];
    expect(header).toContain('connect-src https://api.example;');
    expect(header).toContain('https://esm.sh');
    expect(header).not.toContain('unsafe-hashes');
    expect(header).toContain("frame-ancestors 'self'");
    expect(res.text).toContain('ui/notifications/sandbox-proxy-ready');
    expect(res.text).toContain("window.origin !== 'null'");
  });

  it('falls back to the restrictive policy for a malformed parameter', async () => {
    const res = await request(app).get('/api/mcp-apps/sandbox').query({ csp: '{not json' });
    expect(res.headers['content-security-policy']).toContain("connect-src 'none'");
  });
});

describe('GET /api/mcp-apps/resource', () => {
  it('requires a user', async () => {
    const res = await request(app).get('/api/mcp-apps/resource').query(ref);
    expect(res.status).toBe(401);
  });

  it('refuses an app the user cannot open', async () => {
    apps = [];
    const res = await asUser(request(app).get('/api/mcp-apps/resource').query(ref));
    expect(res.status).toBe(403);
  });

  it('refuses a tool the app does not offer', async () => {
    apps = [{ id: 'whiteboard', tools: ['other'] }];
    const res = await asUser(request(app).get('/api/mcp-apps/resource').query(ref));
    expect(res.status).toBe(403);
    expect(findTool).not.toHaveBeenCalled();
  });

  it('404s a tool that renders no view', async () => {
    apps = [{ id: 'whiteboard', tools: ['excalidraw'] }];
    const res = await asUser(
      request(app)
        .get('/api/mcp-apps/resource')
        .query({ ...ref, toolId: 'excalidraw__read_me' })
    );
    expect(res.status).toBe(404);
  });

  it("returns the view's HTML, CSP, permissions and tool definition", async () => {
    const res = await asUser(request(app).get('/api/mcp-apps/resource').query(ref));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      uri: RESOURCE.uri,
      html: RESOURCE.html,
      csp: RESOURCE.csp,
      allow: 'clipboard-write',
      prefersBorder: true,
      serverId: 'excalidraw',
      tool: { name: 'create_view', inputSchema: VIEW_TOOL.parameters }
    });
    // The server resolves the URI from the tool; the client never names it.
    expect(conn.getUiResource).toHaveBeenCalledWith(RESOURCE.uri);
  });

  it('accepts a base tool id in the app (all tools of the server)', async () => {
    apps = [{ id: 'whiteboard', tools: ['excalidraw'] }];
    const res = await asUser(request(app).get('/api/mcp-apps/resource').query(ref));
    expect(res.status).toBe(200);
  });
});

describe('resolveMcpApp', () => {
  it('rejects ids that are not strings (a repeated query parameter arrives as an array)', async () => {
    const req = { user: { id: 'u1', permissions: {} } };
    await expect(resolveMcpApp(req, 'whiteboard', ['a', 'b'])).rejects.toMatchObject({
      status: 400
    });
    await expect(
      resolveMcpApp(req, ['whiteboard'], 'excalidraw__create_view')
    ).rejects.toMatchObject({ status: 400 });
    expect(findTool).not.toHaveBeenCalled();
  });

  it('rejects a repeated toolId query parameter at the route', async () => {
    const res = await asUser(
      request(app).get(
        '/api/mcp-apps/resource?appId=whiteboard&toolId=excalidraw__create_view&toolId=x'
      )
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/mcp-apps/tools/call', () => {
  it('calls an app-only tool of the same server and returns only standard result fields', async () => {
    const res = await asUser(
      request(app)
        .post('/api/mcp-apps/tools/call')
        .send({ ...ref, name: 'save_checkpoint', arguments: { id: 'cp1' } })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { saved: true }
    });
    expect(conn.callToolRaw).toHaveBeenCalledWith('save_checkpoint', { id: 'cp1' });
  });

  it('refuses a tool that is not callable from views', async () => {
    const res = await asUser(
      request(app)
        .post('/api/mcp-apps/tools/call')
        .send({ ...ref, name: 'model_only' })
    );
    expect(res.status).toBe(403);
    expect(conn.callToolRaw).not.toHaveBeenCalled();
  });

  it('refuses a caller without access to the app', async () => {
    apps = [];
    const res = await asUser(
      request(app)
        .post('/api/mcp-apps/tools/call')
        .send({ ...ref, name: 'save_checkpoint' })
    );
    expect(res.status).toBe(403);
  });

  it('rejects a malformed body', async () => {
    const res = await asUser(
      request(app)
        .post('/api/mcp-apps/tools/call')
        .send({ ...ref })
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/mcp-apps/resources/read', () => {
  it("reads from the view's own server", async () => {
    const res = await asUser(
      request(app)
        .post('/api/mcp-apps/resources/read')
        .send({ ...ref, uri: 'ui://excalidraw/fonts.json' })
    );
    expect(res.status).toBe(200);
    expect(res.body.contents[0].uri).toBe('ui://excalidraw/fonts.json');
    expect(conn.readResource).toHaveBeenCalledWith('ui://excalidraw/fonts.json');
  });
});
