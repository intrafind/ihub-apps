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

jest.unstable_mockModule('../../toolLoader.js', () => ({
  runTool,
  loadConfiguredTools: jest.fn(async () => []),
  loadTools: jest.fn(async () => [])
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
    req.user = { id: 'bob', groups: ['users'], permissions: {} };
    next();
  }
}));
jest.unstable_mockModule('../../configCache.js', () => ({
  default: {
    getPlatform: () => ({ defaultLanguage: 'en', mcpServer: { expose: { workflows: true } } }),
    getFeatures: () => ({}),
    getApps: () => ({ data: [] }),
    getWorkflows: () => ({ data: [] })
  }
}));

const { stripReservedToolContext, withTrustedToolContext, RESERVED_TOOL_CONTEXT_KEYS } =
  await import('../../utils/toolCallContext.js');
const { default: registerToolRoutes } = await import('../../routes/toolRoutes.js');
const { dispatchA2A } = await import('../../services/mcp/a2aHandler.js');

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
  _attachments: [{ name: 'a' }],
  _chatHistory: [{ role: 'user', content: 'hi' }]
};

beforeEach(() => {
  runTool.mockClear();
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
      user: { id: 'bob', groups: ['users'], permissions: {} }
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

describe('A2A tasks/send', () => {
  const caller = {
    id: 'a2a-client',
    scopes: ['mcp:workflows:run'],
    permissions: { workflows: new Set(['*']) }
  };

  it('runs a workflow skill as the authenticated caller, never as input.user', async () => {
    const r = await dispatchA2A(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: {
          taskId: 't1',
          skillId: 'workflow__hr-lookup',
          input: { input: 'list my direct reports', ...SPOOFED }
        }
      },
      { user: caller, platform: { defaultLanguage: 'en' } }
    );
    expect(r.result.status).toBe('completed');
    const [toolId, params] = runTool.mock.calls[0];
    expect(toolId).toBe('workflow_hr-lookup');
    expect(params).toEqual({ input: 'list my direct reports', user: caller, chatId: 'a2a-t1' });
  });
});
