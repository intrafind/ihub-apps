import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import express from 'express';

/**
 * End to end: iHub's outbound A2A client against iHub's own inbound A2A
 * endpoint (routes/mcpServer.js), over real HTTP on 127.0.0.1 with the real
 * `safeFetch`. Both sides of the wire come from this branch, so the test
 * pins that they agree on the Agent Card, `message/send`, `message/stream`
 * (SSE) and `contextId` continuation. The inbound side's auth and app
 * invocation are stubbed as in tests/mcp/a2aRoutes.test.js.
 */

const apps = [
  { id: 'chat', name: { en: 'Chat' }, description: 'General chat' },
  { id: 'summary', name: 'Summarizer', description: 'Summarize', starterPrompts: [] }
];
let platform;
jest.unstable_mockModule('../../configCache.js', () => ({
  default: {
    getPlatform: () => platform,
    getApps: () => ({ data: apps }),
    getWorkflows: () => ({ data: [] }),
    getUI: () => ({ data: { title: 'iHub' } })
  },
  resolveEnvVarsInObject: value => value
}));

// Inbound auth stand-in: the personal API key "good" (sent by the client as
// X-API-Key, the header the card's apiKey scheme names) authenticates alice.
const seenAuth = [];
jest.unstable_mockModule('../../middleware/mcpAuth.js', () => ({
  default: (req, res, next) => {
    seenAuth.push(req.headers.authorization || null);
    if (req.headers.authorization === 'Bearer good') {
      req.user = {
        id: 'alice',
        scopes: ['mcp:apps:invoke'],
        permissions: { apps: new Set(['*']), workflows: new Set() }
      };
      return next();
    }
    return res.status(401).json({ error: 'invalid_token' });
  },
  MCP_METHOD_SCOPES: {}
}));
jest.unstable_mockModule('../../services/mcp/McpServerService.js', () => ({
  buildMcpServer: jest.fn()
}));
const invokeApp = jest.fn();
jest.unstable_mockModule('../../services/mcp/appInvoker.js', () => ({
  invokeApp,
  invokeAppNonStreaming: jest.fn()
}));
jest.unstable_mockModule('../../toolLoader.js', () => ({
  runTool: jest.fn(),
  loadConfiguredTools: jest.fn(async () => [])
}));
jest.unstable_mockModule('../../services/mcp/permissions.js', () => ({
  getVisibleToolIds: jest.fn(async () => new Set()),
  toolVisibleInSet: () => false
}));
jest.unstable_mockModule('../../utils/versionHelper.js', () => ({ getAppVersion: () => '9.9.9' }));
jest.unstable_mockModule('../../utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));
jest.unstable_mockModule('../../storage/bootstrap.js', () => ({
  getStorage: () => null,
  readFacet: () => null
}));
jest.unstable_mockModule('../../clusterBus.js', () => ({
  publish: jest.fn(() => false),
  subscribe: jest.fn(() => () => {}),
  request: jest.fn(async () => null),
  respond: jest.fn(() => () => {}),
  createPresenceMap: () => new Map(),
  hasRemote: () => false
}));
// The outbound client's credential store: the API key profile holds "good".
jest.unstable_mockModule('../../services/CredentialService.js', () => ({
  default: { resolveSecret: ref => (ref === 'ihub-key' ? 'good' : 'wrong') }
}));
const progress = [];
jest.unstable_mockModule('../../services/loop/RunStream.js', () => ({
  emitToolProgress: (chatId, frame) => progress.push({ chatId, ...frame })
}));

const { default: registerMcpServerRoutes } = await import('../../routes/mcpServer.js');
const { A2aTaskStore, setA2aTaskStoreForTests } =
  await import('../../services/mcp/a2aTaskStore.js');
const { default: manager } = await import('../../services/a2a/A2aClientManager.js');

let server;
let base;

beforeAll(async () => {
  const app = express();
  registerMcpServerRoutes(app);
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await manager.shutdown();
  await new Promise(resolve => server.close(resolve));
});

function agent(extra = {}) {
  return {
    id: 'ihub',
    name: 'Other iHub',
    cardUrl: `${base}/a2a/.well-known/agent-card.json`,
    auth: { type: 'apiKey', valueRef: 'ihub-key' },
    ...extra
  };
}

async function useAgent(extra) {
  await manager.shutdown();
  // Loopback is a private address: allow it for this test only.
  await manager.initialize({
    agents: [agent(extra)],
    security: { blockPrivateIps: false, allowedHosts: [] }
  });
}

beforeEach(() => {
  platform = {
    defaultLanguage: 'en',
    mcpServer: {
      enabled: true,
      publicUrl: base,
      transports: { streamableHttp: { enabled: true }, sse: { enabled: false } },
      expose: { tools: false, apps: true, workflows: false },
      a2a: { enabled: true }
    }
  };
  setA2aTaskStoreForTests(new A2aTaskStore({ documents: null, relayCancel: false }));
  invokeApp.mockReset();
  invokeApp.mockImplementation(async ({ messages, onTextDelta }) => {
    const answer = `Answer to "${messages.at(-1).content}" (${messages.length} messages)`;
    if (onTextDelta) {
      onTextDelta(answer.slice(0, 7));
      onTextDelta(answer.slice(7));
    }
    return { text: answer, result: {} };
  });
  seenAuth.length = 0;
  progress.length = 0;
});

describe('outbound client ↔ inbound iHub agent', () => {
  it("lists the inbound agent's skills (authenticated card) as tools", async () => {
    await useAgent();
    const tools = await manager.listAllTools();
    expect(tools.map(t => t.id)).toEqual(['a2a__ihub__app_chat', 'a2a__ihub__app_summary']);
    expect(tools[0]._a2a).toMatchObject({
      agentId: 'ihub',
      skillId: 'app__chat',
      skillName: 'Chat'
    });
    // The key went out as X-API-Key (the card's apiKey scheme) and was accepted.
    expect(seenAuth).toContain('Bearer good');
    expect(manager.status()[0]).toMatchObject({ connected: true, streaming: true });
  });

  it('runs a skill over message/send and continues the conversation with contextId', async () => {
    await useAgent({ streaming: 'never' });
    const user = { id: 'bob' };
    const first = await manager.callTool('a2a__ihub__app_summary', {
      message: 'first question',
      chatId: 'chat-1',
      user
    });
    expect(first).toBe('Answer to "first question" (1 messages)');
    expect(invokeApp.mock.calls[0][0].appId).toBe('summary');

    const second = await manager.callTool('a2a__ihub__app_summary', {
      message: 'follow-up',
      chatId: 'chat-1',
      user
    });
    // The inbound agent received the earlier exchange as history.
    expect(second).toBe('Answer to "follow-up" (3 messages)');

    const other = await manager.callTool('a2a__ihub__app_summary', {
      message: 'fresh',
      chatId: 'chat-2',
      user
    });
    expect(other).toBe('Answer to "fresh" (1 messages)');
  });

  it('streams a skill over message/stream and reports progress to the chat', async () => {
    await useAgent();
    const answer = await manager.callTool('a2a__ihub__app_chat', {
      message: 'stream me',
      chatId: 'chat-s',
      user: { id: 'carol' }
    });
    expect(answer).toBe('Answer to "stream me" (1 messages)');
    expect(invokeApp.mock.calls[0][0].onTextDelta).toEqual(expect.any(Function));
    expect(progress.some(p => p.chatId === 'chat-s' && p.data.state === 'working')).toBe(true);
  });

  it('surfaces a failed remote task as A2A_TASK_FAILED', async () => {
    await useAgent({ streaming: 'never' });
    invokeApp.mockImplementation(async () => {
      throw new Error('model unavailable');
    });
    await expect(
      manager.callTool('a2a__ihub__app_chat', { message: 'x', chatId: 'c', user: { id: 'u' } })
    ).rejects.toMatchObject({ code: 'A2A_TASK_FAILED', message: 'Task failed: model unavailable' });
  });

  it('reports rejected credentials as A2A_AUTH_FAILED', async () => {
    await useAgent({ auth: { type: 'apiKey', valueRef: 'other-key' } });
    await expect(manager.testConnection('ihub')).rejects.toMatchObject({
      code: 'A2A_AUTH_FAILED'
    });
  });
});
