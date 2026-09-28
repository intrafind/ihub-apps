import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Tool calls made for an external caller always run as the authenticated
 * caller: a `user` (or `chatId`, `appConfig`, …) in a REST body, a query
 * string or an A2A input is dropped, never used. Per-user OAuth MCP tools
 * pick their token by `params.user`, so a spoofed user would otherwise run
 * the tool with somebody else's token.
 */

const runTool = jest.fn(async () => 'ok');
const loadedTools = [
  { id: 'okta__get_my_profile', _mcp: { serverId: 'okta' } },
  { id: 'jira_searchTickets' },
  { id: 'a2a__desk__ask', _a2a: { agentId: 'desk' } }
];
let apps = [];
/** Group `tools` grants of the calling user; null for a user without permissions. */
let grantedTools = new Set(['okta']);
let adminAccess = false;

jest.unstable_mockModule('../../toolLoader.js', () => ({
  runTool,
  loadConfiguredTools: jest.fn(async () => []),
  loadTools: jest.fn(async () => loadedTools)
}));
jest.unstable_mockModule('../../services/mcp/appInvoker.js', () => ({
  invokeApp: jest.fn(),
  invokeAppNonStreaming: jest.fn()
}));
jest.unstable_mockModule('../../featureRegistry.js', () => ({
  requireFeature: () => (_req, _res, next) => next()
}));
jest.unstable_mockModule('../../middleware/authRequired.js', () => ({
  authRequired: (req, _res, next) => {
    req.user = {
      id: 'bob',
      groups: ['users'],
      permissions: grantedTools
        ? { tools: grantedTools, ...(adminAccess ? { adminAccess: true } : {}) }
        : {}
    };
    next();
  }
}));
jest.unstable_mockModule('../../configCache.js', () => ({
  default: {
    getPlatform: () => ({ defaultLanguage: 'en', mcpServer: { expose: { workflows: true } } }),
    getFeatures: () => ({}),
    getApps: () => ({ data: [] }),
    getAppsForUser: async () => ({ data: apps }),
    getWorkflows: () => ({ data: [{ id: 'hr-lookup', chatIntegration: { enabled: true } }] })
  }
}));

const { stripReservedToolContext, withTrustedToolContext, RESERVED_TOOL_CONTEXT_KEYS } =
  await import('../../utils/toolCallContext.js');
const { default: registerToolRoutes } = await import('../../routes/toolRoutes.js');
const { dispatchA2A } = await import('../../services/mcp/a2aHandler.js');
const { A2aTaskStore } = await import('../../services/mcp/a2aTaskStore.js');

const app = express();
app.use(express.json());
registerToolRoutes(app);

const SPOOFED = {
  user: { id: 'alice@corp.com', groups: ['admins'] },
  chatId: 'someone-elses-chat',
  appConfig: { id: 'x' },
  passthrough: true,
  runId: 'r',
  _fileData: [{ name: 'f' }],
  _chatHistory: [{ role: 'user', content: 'hi' }]
};

beforeEach(() => {
  runTool.mockClear();
  apps = [];
  grantedTools = new Set(['okta']);
  adminAccess = false;
});

describe('withTrustedToolContext', () => {
  it('drops every reserved key from the caller input and sets the trusted ones last', () => {
    expect(stripReservedToolContext({ ...SPOOFED, q: 'x' })).toEqual({ q: 'x' });
    const trusted = { id: 'bob' };
    expect(withTrustedToolContext({ ...SPOOFED, q: 'x' }, { user: trusted, chatId: 'c' })).toEqual({
      q: 'x',
      user: trusted,
      chatId: 'c'
    });
    expect(RESERVED_TOOL_CONTEXT_KEYS).toEqual(expect.arrayContaining(Object.keys(SPOOFED)));
    expect(withTrustedToolContext(null, { user: trusted })).toEqual({ user: trusted });
    expect(withTrustedToolContext(['a'], {})).toEqual({});
  });
});

describe('POST /api/tools/:toolId', () => {
  it("runs as the authenticated user, never as the body's user", async () => {
    const res = await request(app)
      .post('/api/tools/okta__get_my_profile')
      .set('x-chat-id', 'chat-bob')
      .send({ ...SPOOFED, query: 'me' });
    expect(res.status).toBe(200);
    expect(runTool).toHaveBeenCalledTimes(1);
    const [toolId, params] = runTool.mock.calls[0];
    expect(toolId).toBe('okta__get_my_profile');
    expect(params).toEqual({
      query: 'me',
      chatId: 'chat-bob',
      user: { id: 'bob', groups: ['users'], permissions: { tools: new Set(['okta']) } }
    });
  });

  it('ignores a user in the query string of a GET', async () => {
    await request(app)
      .get('/api/tools/okta__get_my_profile')
      .query({ 'user[id]': 'alice', q: 'x' });
    const [, params] = runTool.mock.calls[0];
    expect(params.user.id).toBe('bob');
    expect(params.q).toBe('x');
  });
});

describe('POST /api/tools/:toolId permissions', () => {
  const call = toolId => request(app).post(`/api/tools/${toolId}`).send({});

  it('refuses a tool neither the groups nor an app of the caller grant', async () => {
    const res = await call('jira_searchTickets');
    expect(res.status).toBe(403);
    expect(runTool).not.toHaveBeenCalled();
  });

  it('refuses a caller without tool permissions, and unknown tools alike', async () => {
    grantedTools = null;
    expect((await call('okta__get_my_profile')).status).toBe(403);
    grantedTools = new Set(['okta']);
    expect((await call('nope')).status).toBe(403);
    expect((await call('workflow_hr-lookup')).status).toBe(403);
    expect(runTool).not.toHaveBeenCalled();
  });

  it('runs a tool an app the caller can open lists', async () => {
    apps = [{ id: 'support', tools: ['jira'] }];
    expect((await call('jira_searchTickets')).status).toBe(200);
    expect(runTool).toHaveBeenCalledWith('jira_searchTickets', expect.any(Object));
  });

  it('reads grants like app references: A2A agent reference, and * for all', async () => {
    grantedTools = new Set(['a2a__desk']);
    expect((await call('a2a__desk__ask')).status).toBe(200);
    grantedTools = new Set(['*']);
    expect((await call('workflow_hr-lookup')).status).toBe(200);
  });

  it('lets an admin run any tool', async () => {
    grantedTools = new Set();
    adminAccess = true;
    expect((await call('jira_searchTickets')).status).toBe(200);
  });
});

describe('A2A message/send', () => {
  const caller = {
    id: 'a2a-client',
    scopes: ['mcp:workflows:run'],
    permissions: { workflows: new Set(['*']) }
  };

  it('runs a workflow skill as the authenticated caller, never as a user in the message data', async () => {
    const r = await dispatchA2A(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: {
          message: {
            kind: 'message',
            role: 'user',
            messageId: 'm1',
            metadata: { skillId: 'workflow__hr-lookup' },
            parts: [
              { kind: 'text', text: 'list my direct reports' },
              { kind: 'data', data: SPOOFED }
            ]
          }
        }
      },
      {
        user: caller,
        platform: { defaultLanguage: 'en', mcpServer: { expose: { workflows: true } } },
        store: new A2aTaskStore({ documents: null, relayCancel: false })
      }
    );
    expect(r.result.status.state).toBe('completed');
    const [toolId, params] = runTool.mock.calls[0];
    expect(toolId).toBe('workflow_hr-lookup');
    expect(params.user).toBe(caller);
    expect(params.input).toBe('list my direct reports');
    expect(params.chatId).toBe(`a2a-${r.result.id}`);
    for (const key of Object.keys(SPOOFED).filter(k => k !== 'user' && k !== 'chatId')) {
      expect(params).not.toHaveProperty(key);
    }
  });
});
