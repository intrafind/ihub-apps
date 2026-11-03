// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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
const hasServer = jest.fn(() => false);
const connectionForUser = jest.fn();
const withUserConnection = jest.fn();
const connectUrlFor = jest.fn(id => `/api/integrations/${id}/connect`);

let platform = { anonymousAuth: { enabled: false }, auth: {} };
jest.unstable_mockModule('../../configCache.js', () => ({
  default: {
    getPlatform: () => platform,
    getAppsForUser: jest.fn(async () => ({ data: apps })),
    getIntegrations: () => ({ data: { installed: [] } }),
    get: () => ({ data: { installed: [] } })
  }
}));

/** An in-memory interaction store with the service's answer-once semantics. */
const interactions = new Map();
const interactionError = (message, code) => Object.assign(new Error(message), { code });
jest.unstable_mockModule('../../services/loop/InteractionService.js', () => ({
  default: {
    raise: jest.fn(async params => {
      const interaction = { ...params, status: 'pending', createdAt: new Date().toISOString() };
      interactions.set(params.id, interaction);
      return interaction;
    }),
    get: jest.fn(async id => interactions.get(id) || null),
    answer: jest.fn(async (id, answer) => {
      const current = interactions.get(id);
      if (!current) throw interactionError('Interaction not found', 'NOT_FOUND');
      if (current.status === 'expired') throw interactionError('Interaction expired', 'EXPIRED');
      if (current.status !== 'pending') throw interactionError('not pending', 'NOT_PENDING');
      const answered = { ...current, status: 'answered', answer };
      interactions.set(id, answered);
      return answered;
    })
  }
}));
jest.unstable_mockModule('../../services/loop/runAccess.js', () => ({
  authorizeInteraction: jest.fn(async (interaction, user) => {
    return !interaction.source?.principalId || interaction.source.principalId === user?.id;
  })
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
  default: { findTool, hasServer, connectionForUser, withUserConnection, connectUrlFor }
}));
const logInfo = jest.fn();
jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: { info: logInfo, warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
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
  hasServer.mockReset();
  hasServer.mockImplementation(id => id === 'excalidraw');
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

  it('serves a view for an app that uses the whole MCP server by its id', async () => {
    // Prefix-agnostic: the app lists the server, not the tool id.
    apps = [{ id: 'whiteboard', tools: ['excalidraw'] }];
    findTool.mockImplementation(async id =>
      id === 'create_view' ? { conn, tool: { ...VIEW_TOOL, id: 'create_view' } } : null
    );
    const res = await asUser(
      request(app)
        .get('/api/mcp-apps/resource')
        .query({ appId: 'whiteboard', toolId: 'create_view' })
    );
    expect(res.status).toBe(200);
  });

  it('refuses a tool of another MCP server than the one the app uses', async () => {
    apps = [{ id: 'whiteboard', tools: ['drawio'] }];
    hasServer.mockImplementation(id => id === 'drawio' || id === 'excalidraw');
    const res = await asUser(request(app).get('/api/mcp-apps/resource').query(ref));
    expect(res.status).toBe(403);
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

describe('per-user OAuth servers', () => {
  const oauthConn = () => ({ ...conn, config: { id: 'excalidraw', auth: { type: 'oauthUser' } } });
  const authRequired = () =>
    Object.assign(new Error('Sign-in required'), {
      code: 'INTEGRATION_AUTH_REQUIRED',
      serverId: 'excalidraw'
    });

  beforeEach(() => {
    connectionForUser.mockReset();
    withUserConnection.mockReset();
    const shared = oauthConn();
    findTool.mockImplementation(async id =>
      id === VIEW_TOOL.id ? { conn: shared, tool: VIEW_TOOL } : null
    );
  });

  it('answers "connect first" with 409, never 401 (which signs the user out of iHub)', async () => {
    connectionForUser.mockRejectedValue(authRequired());
    const res = await asUser(request(app).get('/api/mcp-apps/resource').query(ref));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'auth_required',
      code: 'INTEGRATION_AUTH_REQUIRED',
      integration: 'excalidraw',
      connectUrl: '/api/integrations/excalidraw/connect'
    });
  });

  it("runs the view's requests on the caller's own connection, and maps a later sign-in loss to 409", async () => {
    connectionForUser.mockResolvedValue(conn);
    withUserConnection.mockImplementation(async (_id, _user, operation) => operation(conn));
    const ok = await asUser(
      request(app)
        .post('/api/mcp-apps/tools/call')
        .send({ ...ref, name: 'save_checkpoint', arguments: {} })
    );
    expect(ok.status).toBe(200);
    expect(withUserConnection).toHaveBeenCalledWith(
      'excalidraw',
      expect.objectContaining({ id: 'u1' }),
      expect.any(Function)
    );

    withUserConnection.mockRejectedValue(authRequired());
    const lost = await asUser(
      request(app)
        .post('/api/mcp-apps/resources/read')
        .send({ ...ref, uri: 'ui://excalidraw/data' })
    );
    expect(lost.status).toBe(409);
    expect(lost.body.code).toBe('INTEGRATION_AUTH_REQUIRED');
  });

  it('answers a refresh that failed for a transient reason with 503', async () => {
    connectionForUser.mockResolvedValue(conn);
    withUserConnection.mockRejectedValue(
      Object.assign(new Error('AS down'), { code: 'MCP_AUTH_REFRESH_FAILED' })
    );
    const res = await asUser(request(app).get('/api/mcp-apps/resource').query(ref));
    expect(res.status).toBe(503);
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

describe('views embedded in the result of a tool without a declared view', () => {
  const PLAIN_TOOL = {
    id: 'excalidraw__show',
    description: 'Show',
    parameters: { type: 'object', properties: {} },
    _mcp: { serverId: 'excalidraw', originalName: 'show' }
  };
  const plainRef = { appId: 'whiteboard', toolId: PLAIN_TOOL.id };

  beforeEach(() => {
    apps = [{ id: 'whiteboard', tools: ['excalidraw'] }];
    findTool.mockImplementation(async id =>
      id === PLAIN_TOOL.id ? { conn, tool: PLAIN_TOOL } : null
    );
  });

  it('lets the view call app-callable tools of the same server', async () => {
    const res = await asUser(
      request(app)
        .post('/api/mcp-apps/tools/call')
        .send({ ...plainRef, name: 'save_checkpoint' })
    );
    expect(res.status).toBe(200);
    expect(conn.callToolRaw).toHaveBeenCalledWith('save_checkpoint', {});
  });

  it('has no resources/read copy to serve', async () => {
    const res = await asUser(request(app).get('/api/mcp-apps/resource').query(plainRef));
    expect(res.status).toBe(404);
    expect(conn.getUiResource).not.toHaveBeenCalled();
  });

  it('is refused for a server with MCP Apps disabled', async () => {
    conn.config = { id: 'excalidraw', apps: { enabled: false } };
    const res = await asUser(
      request(app)
        .post('/api/mcp-apps/tools/call')
        .send({ ...plainRef, name: 'save_checkpoint' })
    );
    expect(res.status).toBe(404);
    expect(conn.callToolRaw).not.toHaveBeenCalled();
  });
});

describe('POST /api/mcp-apps/handshake', () => {
  it('logs a legacy handshake for admins, naming the server and tool', async () => {
    logInfo.mockClear();
    const res = await asUser(
      request(app)
        .post('/api/mcp-apps/handshake')
        .send({ ...ref, handshake: 'legacy' })
    );
    expect(res.status).toBe(204);
    const entry = logInfo.mock.calls.find(([, meta]) => meta?.handshake === 'legacy');
    expect(entry).toBeDefined();
    expect(entry[1]).toMatchObject({
      component: 'McpApps',
      handshake: 'legacy',
      appId: 'whiteboard',
      viaToolId: 'excalidraw__create_view',
      serverId: 'excalidraw',
      tool: 'create_view',
      userId: 'u1'
    });
  });

  it('refuses a caller without access to the app', async () => {
    apps = [];
    const res = await asUser(
      request(app)
        .post('/api/mcp-apps/handshake')
        .send({ ...ref, handshake: 'legacy' })
    );
    expect(res.status).toBe(403);
  });

  it('accepts only known handshake kinds', async () => {
    const res = await asUser(
      request(app)
        .post('/api/mcp-apps/handshake')
        .send({ ...ref, handshake: 'spec' })
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

describe('a view calling a tool that needs approval (#2945)', () => {
  const gated = { ...ref, name: 'save_checkpoint', arguments: { id: 'cp1', token: 's3cret' } };

  beforeEach(() => {
    interactions.clear();
    platform = {
      anonymousAuth: { enabled: false },
      auth: {},
      toolApproval: { defaults: { external: 'always' } }
    };
  });

  const askApproval = () =>
    asUser(
      request(app)
        .post('/api/mcp-apps/tools/call')
        .send({ ...gated, chatId: 'chat-1', toolApprovalCapable: true })
    );
  const decide = (interactionId, decision, user = 'u1') =>
    request(app)
      .post('/api/mcp-apps/tools/call/approval')
      .set('x-test-user', user)
      .send({ ...ref, interactionId, decision });

  it('raises an approval for the hosting chat instead of running the call', async () => {
    const res = await askApproval();
    expect(res.status).toBe(202);
    expect(res.body.awaitingApproval).toBe(true);
    const { interaction } = res.body;
    expect(interaction.kind).toBe('approval');
    expect(interaction.source.chatId).toBe('chat-1');
    expect(interaction.source.viewCall).toEqual({
      appId: 'whiteboard',
      viewToolId: 'excalidraw__create_view',
      serverId: 'excalidraw',
      name: 'save_checkpoint'
    });
    expect(interaction.prompt.displayData.args).toEqual({ id: 'cp1', token: 's3cret' });
    expect(conn.callToolRaw).not.toHaveBeenCalled();
  });

  it('a host that cannot show the card is refused (APPROVAL_REQUIRED_NO_USER)', async () => {
    for (const body of [{ ...gated }, { ...gated, chatId: 'chat-1' }]) {
      const res = await asUser(request(app).post('/api/mcp-apps/tools/call').send(body));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('APPROVAL_REQUIRED_NO_USER');
    }
    expect(conn.callToolRaw).not.toHaveBeenCalled();
  });

  it('approve runs the stored call with the approved arguments and returns its result to the view', async () => {
    const { interaction } = (await askApproval()).body;
    const res = await decide(interaction.id, 'approve');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { saved: true }
    });
    expect(conn.callToolRaw).toHaveBeenCalledTimes(1);
    expect(conn.callToolRaw).toHaveBeenCalledWith('save_checkpoint', {
      id: 'cp1',
      token: 's3cret'
    });
    // A second answer cannot run it again.
    const again = await decide(interaction.id, 'approve');
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('APPROVAL_ALREADY_ANSWERED');
    expect(conn.callToolRaw).toHaveBeenCalledTimes(1);
  });

  it('reject and expiry come back to the view as structured tool errors; nothing runs', async () => {
    const rejected = (await askApproval()).body.interaction;
    const r1 = await decide(rejected.id, 'reject');
    expect(r1.status).toBe(200);
    expect(r1.body.isError).toBe(true);
    expect(r1.body.structuredContent.error).toBe('USER_REJECTED');

    const lapsed = (await askApproval()).body.interaction;
    interactions.set(lapsed.id, { ...interactions.get(lapsed.id), status: 'expired' });
    const r2 = await decide(lapsed.id, 'approve');
    expect(r2.status).toBe(200);
    expect(r2.body.structuredContent.error).toBe('APPROVAL_EXPIRED');
    expect(conn.callToolRaw).not.toHaveBeenCalled();
  });

  it("the app's approval override gates a view's call like a model's call", async () => {
    platform = { anonymousAuth: { enabled: false }, auth: {} };
    const call = () =>
      asUser(
        request(app)
          .post('/api/mcp-apps/tools/call')
          .send({ ...gated, chatId: 'chat-1', toolApprovalCapable: true })
      );
    // Per tool, by the app-facing id (prefix + the server's tool name).
    apps = [
      {
        id: 'whiteboard',
        tools: ['excalidraw__create_view'],
        toolApproval: { tools: { excalidraw__save_checkpoint: 'always' } }
      }
    ];
    const perTool = await call();
    expect(perTool.status).toBe(202);
    expect(perTool.body.interaction.prompt.displayData.approvalSource).toBe('app');
    // The app's default for all its tools.
    apps = [
      { id: 'whiteboard', tools: ['excalidraw__create_view'], toolApproval: { default: 'always' } }
    ];
    expect((await call()).status).toBe(202);
    // Without an override, nothing asks.
    apps = [{ id: 'whiteboard', tools: ['excalidraw__create_view'] }];
    expect((await call()).status).toBe(200);
    expect(conn.callToolRaw).toHaveBeenCalledTimes(1);
  });

  it('only the view that asked, and only its user, may answer', async () => {
    const { interaction } = (await askApproval()).body;
    const otherUser = await decide(interaction.id, 'approve', 'u2');
    expect(otherUser.status).toBe(403);
    const otherView = await asUser(
      request(app).post('/api/mcp-apps/tools/call/approval').send({
        appId: 'whiteboard',
        toolId: 'excalidraw__other',
        interactionId: interaction.id,
        decision: 'approve'
      })
    );
    expect([403, 404]).toContain(otherView.status);
    expect(conn.callToolRaw).not.toHaveBeenCalled();
  });
});
