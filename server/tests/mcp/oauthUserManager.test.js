import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import tokenStorage from '../../services/TokenStorageService.js';
import mcpClientManager, {
  USER_CONNECTION_IDLE_MS,
  userConnectionKey
} from '../../services/mcp/McpClientManager.js';
import { McpOAuthClientStore } from '../../services/mcp/mcpOAuthClientStore.js';
import {
  McpToolCatalogStore,
  MCP_TOOL_CATALOG_NAMESPACE
} from '../../services/mcp/mcpToolCatalogStore.js';
import {
  readUserTokens,
  writeUserTokens as writeRawUserTokens,
  tokenBindingFor
} from '../../services/mcp/mcpUserTokens.js';
import { chatToolSeam, authRequiredOf } from '../../services/chat/chatSeams.js';
import { parseSseV2EventData } from '../../services/loop/contracts/sseV2.js';
import { SSE_V2_EVENTS } from '../../../shared/runEvents.js';

/**
 * Per-user OAuth servers in McpClientManager: one pooled connection per
 * (server, user), the shared tool catalog answered without connecting, the
 * structured auth-required result instead of a call when the caller has no
 * token — never another user's connection — and the chat's projection of that
 * result onto `tool/completed`.
 */

const OKTA = {
  id: 'okta',
  name: 'Okta MCP',
  transport: { type: 'streamableHttp', url: 'https://okta-mcp.example.com/mcp' },
  auth: { type: 'oauthUser' }
};

const RAW_TOOLS = [
  {
    name: 'get-current-user',
    description: 'The signed-in Okta user',
    inputSchema: { type: 'object', properties: {} }
  }
];

/** Store tokens as a completed sign-in for OKTA would (bound to its config). */
const writeUserTokens = (userId, serverId, tokens) =>
  writeRawUserTokens(userId, serverId, tokens, tokenBindingFor(OKTA));

/** An in-memory DocumentStore, enough for the catalog and registration stores. */
function memoryDocuments() {
  const data = new Map();
  return {
    data,
    get: jest.fn(async (ns, key) => {
      const value = data.get(`${ns}/${key}`);
      return value === undefined ? null : { key, data: structuredClone(value) };
    }),
    put: jest.fn(async (ns, key, value) => {
      data.set(`${ns}/${key}`, structuredClone(value));
    }),
    delete: jest.fn(async (ns, key) => data.delete(`${ns}/${key}`)),
    list: jest.fn(async () => ({ items: [] }))
  };
}

const saved = {};
let tmpDir;
let documents;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-mcp-oauth-pool-'));
  saved.key = tokenStorage.encryptionKey;
  saved.base = tokenStorage.storageBasePath;
  tokenStorage.encryptionKey = 'd'.repeat(64);
  tokenStorage.storageBasePath = tmpDir;
});

afterAll(async () => {
  await mcpClientManager.shutdown();
  tokenStorage.encryptionKey = saved.key;
  tokenStorage.storageBasePath = saved.base;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  fs.rmSync(path.join(tmpDir, 'mcp'), { recursive: true, force: true });
  documents = memoryDocuments();
  mcpClientManager.catalogStore = new McpToolCatalogStore({ documents });
  mcpClientManager.clientStore = new McpOAuthClientStore({ documents: null });
  await mcpClientManager.shutdown();
  await mcpClientManager.initialize({ servers: [OKTA] });
});

/** Give a user's pooled connection a fake SDK client, so nothing goes on the wire. */
async function fakeUserClient(userId, callTool) {
  const entry = await mcpClientManager._userConnection(
    mcpClientManager.getConnection('okta').config,
    userId
  );
  entry.conn.connected = true;
  entry.conn.client = {
    callTool: jest.fn(callTool),
    listTools: jest.fn(async () => ({ tools: RAW_TOOLS })),
    close: jest.fn(async () => {})
  };
  return entry;
}

describe('tool catalog of a per-user server', () => {
  it('offers no tools before anybody connected, and never connects for them', async () => {
    expect(await mcpClientManager.listAllTools()).toEqual([]);
    const shared = mcpClientManager.getConnection('okta');
    expect(shared.catalogOnly).toBe(true);
    expect(shared.client).toBeNull();
    await expect(shared.connect()).rejects.toMatchObject({ code: 'MCP_AUTH_REQUIRED' });
  });

  it('answers from the catalog a user connection listed, persisted for other workers', async () => {
    await writeUserTokens('alice', 'okta', { access_token: 'a', token_type: 'bearer' });
    const entry = await fakeUserClient('alice', async () => ({ content: [] }));
    await entry.conn.listTools();
    // onToolsListed persists asynchronously.
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(documents.put).toHaveBeenCalledWith(
      MCP_TOOL_CATALOG_NAMESPACE,
      'okta',
      expect.objectContaining({ tools: RAW_TOOLS, endpoint: OKTA.transport.url }),
      expect.anything()
    );
    const tools = await mcpClientManager.listAllTools();
    expect(tools.map(t => t.id)).toEqual(['okta__get-current-user']);
    expect(mcpClientManager.ownsTool('okta__get-current-user')).toBe(true);
    expect((await mcpClientManager.findTool('okta__get-current-user')).tool._mcp).toMatchObject({
      serverId: 'okta',
      originalName: 'get-current-user'
    });

    // A fresh manager state (another worker, a restart) reads the stored catalog.
    await mcpClientManager.shutdown();
    mcpClientManager.catalogStore = new McpToolCatalogStore({ documents });
    await mcpClientManager.initialize({ servers: [OKTA] });
    const reloaded = await mcpClientManager.listToolsByServer();
    expect(reloaded).toEqual([
      expect.objectContaining({
        id: 'okta',
        authType: 'oauthUser',
        tools: [expect.objectContaining({ originalName: 'get-current-user' })]
      })
    ]);
    expect(mcpClientManager.getConnection('okta').client).toBeNull();
  });

  it('ignores a catalog listed from another endpoint', async () => {
    await mcpClientManager.catalogStore.put('okta', RAW_TOOLS, {
      endpoint: 'https://old.example.com/mcp'
    });
    expect(await mcpClientManager.listAllTools()).toEqual([]);
  });
});

describe('tool calls on a per-user server', () => {
  beforeEach(async () => {
    await mcpClientManager.saveCatalog(mcpClientManager.getConnection('okta').config, RAW_TOOLS);
  });

  it('returns auth_required (not an error) for callers without a user or a token', async () => {
    const expected = {
      error: 'MCP_AUTH_REQUIRED',
      authRequired: {
        serverId: 'okta',
        serverName: 'Okta MCP',
        connectUrl: '/api/mcp/oauth/authorize?serverId=okta'
      }
    };
    // Headless: no user (gateway, A2A, a workflow without a user).
    expect(await mcpClientManager.callTool('okta__get-current-user', {})).toMatchObject(expected);
    expect(
      await mcpClientManager.callTool('okta__get-current-user', { user: { id: 'anonymous' } })
    ).toMatchObject(expected);
    const result = await mcpClientManager.callTool('okta__get-current-user', {
      user: { id: 'bob' }
    });
    expect(result).toMatchObject(expected);
    expect(result.message).toContain('/api/mcp/oauth/authorize?serverId=okta');
  });

  it("calls on the caller's own connection and never falls back to another user's", async () => {
    await writeUserTokens('alice', 'okta', { access_token: 'a', token_type: 'bearer' });
    const alice = await fakeUserClient('alice', async () => ({
      content: [{ type: 'text', text: 'you are alice' }]
    }));

    expect(
      await mcpClientManager.callTool('okta__get-current-user', {
        user: { id: 'alice' },
        chatId: 'chat-1'
      })
    ).toBe('you are alice');
    expect(alice.conn.client.callTool).toHaveBeenCalledTimes(1);
    // iHub's context keys never reach the server.
    expect(alice.conn.client.callTool.mock.calls[0][0]).toEqual({
      name: 'get-current-user',
      arguments: {}
    });

    const bob = await mcpClientManager.callTool('okta__get-current-user', { user: { id: 'bob' } });
    expect(bob).toMatchObject({ error: 'MCP_AUTH_REQUIRED' });
    expect(alice.conn.client.callTool).toHaveBeenCalledTimes(1);
    expect(mcpClientManager.userConnections.has(userConnectionKey('okta', 'bob'))).toBe(false);
  });

  it('keeps one connection per user and closes idle ones', async () => {
    const config = mcpClientManager.getConnection('okta').config;
    const a1 = await mcpClientManager._userConnection(config, 'alice');
    const a2 = await mcpClientManager._userConnection(config, 'alice');
    const b = await mcpClientManager._userConnection(config, 'bob');
    expect(a1).toBe(a2);
    expect(a1.conn).not.toBe(b.conn);
    expect(a1.provider.userId).toBe('alice');
    expect(b.provider.userId).toBe('bob');

    expect(await mcpClientManager.sweepIdleUserConnections(Date.now())).toBe(0);
    expect(
      await mcpClientManager.sweepIdleUserConnections(Date.now() + USER_CONNECTION_IDLE_MS + 1)
    ).toBe(2);
    expect(mcpClientManager.userConnections.size).toBe(0);
  });

  it('turns a rejected token into auth_required and clears it', async () => {
    await writeUserTokens('alice', 'okta', { access_token: 'dead', token_type: 'bearer' });
    const alice = await fakeUserClient('alice', async () => {
      throw new UnauthorizedError('token rejected');
    });
    await alice.provider.tokens();
    const result = await mcpClientManager.callTool('okta__get-current-user', {
      user: { id: 'alice' }
    });
    expect(result).toMatchObject({ error: 'MCP_AUTH_REQUIRED' });
    expect(await readUserTokens('alice', 'okta')).toBeNull();
    expect(mcpClientManager.userConnections.has(userConnectionKey('okta', 'alice'))).toBe(false);
  });

  it('closes every user connection when the server is reconfigured', async () => {
    const config = mcpClientManager.getConnection('okta').config;
    await mcpClientManager._userConnection(config, 'alice');
    await mcpClientManager.initialize({
      servers: [{ ...OKTA, auth: { type: 'oauthUser', scopes: ['openid'] } }]
    });
    expect(mcpClientManager.userConnections.size).toBe(0);

    // Switching the auth type rebuilds the shared connection.
    await mcpClientManager.initialize({ servers: [{ ...OKTA, auth: { type: 'none' } }] });
    expect(mcpClientManager.getConnection('okta').catalogOnly).toBe(false);
  });

  it("gives MCP App views the caller's connection or asks them to connect", async () => {
    await writeUserTokens('alice', 'okta', { access_token: 'a', token_type: 'bearer' });
    const alice = await fakeUserClient('alice', async () => ({ content: [] }));
    expect(await mcpClientManager.connectionForUser('okta', { id: 'alice' })).toBe(alice.conn);
    await expect(mcpClientManager.connectionForUser('okta', { id: 'bob' })).rejects.toMatchObject({
      code: 'MCP_AUTH_REQUIRED',
      serverId: 'okta'
    });
  });
});

describe('admin tests of a per-user server', () => {
  it('returns auth_required with a connect URL when the admin has not connected', async () => {
    const admin = { id: 'admin', groups: ['admins'] };
    expect(await mcpClientManager.testConnection('okta', admin)).toEqual({
      status: 'auth_required',
      connectUrl: '/api/mcp/oauth/authorize?serverId=okta',
      tools: [],
      catalog: []
    });
    expect(await mcpClientManager.testConfig(OKTA, admin)).toMatchObject({
      status: 'auth_required',
      connectUrl: '/api/mcp/oauth/authorize?serverId=okta'
    });
    expect(await mcpClientManager.testConfig(OKTA, null)).toMatchObject({
      status: 'auth_required'
    });
  });
});

describe('chat projection of auth_required', () => {
  const marker = {
    error: 'MCP_AUTH_REQUIRED',
    message: 'Connect Okta MCP to use this tool: /api/mcp/oauth/authorize?serverId=okta',
    authRequired: {
      serverId: 'okta',
      serverName: 'Okta MCP',
      connectUrl: '/api/mcp/oauth/authorize?serverId=okta'
    }
  };

  function run(
    seam,
    rawResult,
    callId,
    toolDef = { _mcp: { serverId: 'okta', originalName: 'get-current-user' } }
  ) {
    const frames = [];
    const ctx = {
      iteration: 1,
      meta: { stream: { emit: (type, data) => frames.push({ type, data }) } }
    };
    const info = {
      call: { id: callId },
      toolId: 'okta__get-current-user',
      name: 'okta__get-current-user',
      args: {},
      toolDef
    };
    return seam
      .postTool(ctx, info, { rawResult, message: { content: '' }, durationMs: 3 })
      .then(() => frames);
  }

  it('adds authRequired to tool/completed and collects one prompt per server', async () => {
    const prompts = [];
    const seam = chatToolSeam({
      chatId: 'chat-1',
      buildLogData: () => ({}),
      logInteraction: async () => {},
      mcpAuthPrompts: prompts
    });
    const [frame] = await run(seam, marker, 'c1');
    expect(frame.type).toBe(SSE_V2_EVENTS.TOOL_COMPLETED);
    expect(frame.data.authRequired).toEqual(marker.authRequired);
    // The SSE v2 contract accepts the new field.
    expect(parseSseV2EventData(SSE_V2_EVENTS.TOOL_COMPLETED, frame.data).authRequired).toEqual(
      marker.authRequired
    );
    await run(seam, marker, 'c2');
    expect(prompts).toEqual([marker.authRequired]);

    const [plain] = await run(seam, 'an ordinary result', 'c3');
    expect(plain.data.authRequired).toBeUndefined();
  });

  it('only accepts well-formed markers with a same-origin connect path', () => {
    expect(authRequiredOf(marker)).toEqual(marker.authRequired);
    expect(authRequiredOf({ authRequired: { serverId: 'x', connectUrl: 'https://evil' } })).toBe(
      null
    );
    expect(authRequiredOf('text')).toBeNull();
    expect(authRequiredOf(null)).toBeNull();
    for (const connectUrl of ['//evil.example/x', '/\\evil.example/x']) {
      expect(authRequiredOf({ authRequired: { serverId: 'x', connectUrl } })).toBeNull();
    }
  });

  it('takes the marker only from a tool of the server it names', async () => {
    const seam = chatToolSeam({
      chatId: 'chat-1',
      buildLogData: () => ({}),
      logInteraction: async () => {}
    });
    // An OpenAPI or script tool relaying a JSON body of the same shape.
    const [notMcp] = await run(seam, marker, 'c4', { type: 'openapi' });
    expect(notMcp.data.authRequired).toBeUndefined();
    // An MCP tool of another server.
    const [otherServer] = await run(seam, marker, 'c5', {
      _mcp: { serverId: 'jira', originalName: 'search' }
    });
    expect(otherServer.data.authRequired).toBeUndefined();
  });
});
