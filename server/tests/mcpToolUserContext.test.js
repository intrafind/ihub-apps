import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/**
 * The MCP gateway exposes native iHub tools (iFinder, Entra, Jira, ...) as MCP
 * tools. Those integrations run *as the calling user* — iFinderService throws
 * "iFinder access requires authenticated user" (and requires a chatId for
 * tracking) if the call arrives without them.
 *
 * MCP `tools/call` arguments only carry the tool's declared parameters, so the
 * gateway must inject the authenticated caller's `user` and a tracking `chatId`
 * into the params it hands to `runTool`. This test drives the real
 * `buildMcpServer` over an in-memory transport and asserts that injection.
 */

const runTool = jest.fn(async () => ({ ok: true }));
const loadConfiguredTools = jest.fn();

// Provide every named export toolLoader.js has — ESM link-checks all of them
// even though only a couple are used on the tools-only code path.
jest.unstable_mockModule('../toolLoader.js', () => ({
  loadConfiguredTools,
  runTool,
  loadTools: jest.fn(async () => []),
  discoverMcpTools: jest.fn(async () => []),
  resolveNativeWebSearchProvider: jest.fn(() => null),
  resolveAppNativeWebSearch: jest.fn(() => null),
  getToolsForApp: jest.fn(async () => []),
  localizeTools: jest.fn(tools => tools)
}));

jest.unstable_mockModule('../services/mcp/permissions.js', () => ({
  getVisibleToolIds: async () => new Set(['iFinder']),
  // Real base-id logic: `iFinder_search` matches the visible base id `iFinder`.
  toolVisibleInSet: (toolId, set) =>
    set instanceof Set && (set.has('*') || set.has(toolId) || set.has(toolId.split('_')[0])),
  getVisibleSourceIds: async () => new Set()
}));

const { buildMcpServer } = await import('../services/mcp/McpServerService.js');
const { MCP_SCOPES } = await import('../services/mcp/scopes.js');

const iFinderSearchTool = {
  id: 'iFinder_search',
  description: 'Search for documents in iFinder',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      maxResults: { type: 'integer', description: 'Max results', default: 10 }
    },
    required: ['query']
  }
};

async function connectGateway(user) {
  loadConfiguredTools.mockResolvedValue([iFinderSearchTool]);
  const platform = {
    defaultLanguage: 'en',
    mcpServer: { expose: { tools: true, apps: false, workflows: false, resources: false } }
  };
  const server = await buildMcpServer({ user, platform });
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('MCP gateway native tool calls carry user context', () => {
  beforeEach(() => {
    runTool.mockClear();
    loadConfiguredTools.mockReset();
  });

  const user = {
    id: 'alice',
    scopes: [MCP_SCOPES.TOOLS_READ, MCP_SCOPES.TOOLS_CALL]
  };

  it('lists the iFinder function tool with its real parameter schema', async () => {
    const client = await connectGateway(user);
    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'iFinder_search');
    expect(tool).toBeDefined();
    // The schema fix: query is advertised and required (not an empty schema).
    expect(Object.keys(tool.inputSchema.properties)).toEqual(
      expect.arrayContaining(['query', 'maxResults'])
    );
    expect(tool.inputSchema.required).toEqual(['query']);
  });

  it('injects the authenticated user and a tracking chatId into runTool', async () => {
    const client = await connectGateway(user);
    await client.callTool({ name: 'iFinder_search', arguments: { query: 'quarterly report' } });

    expect(runTool).toHaveBeenCalledTimes(1);
    const [calledToolId, calledParams] = runTool.mock.calls[0];
    expect(calledToolId).toBe('iFinder_search');
    expect(calledParams.query).toBe('quarterly report');
    // The two fields iFinderService.validateCommon() requires:
    expect(calledParams.user).toBe(user);
    expect(calledParams.chatId).toMatch(/^mcp-/);
  });

  it('does not let a caller spoof the user via tool arguments', async () => {
    const client = await connectGateway(user);
    // `user` is not part of the tool schema, so the SDK strips it before the
    // handler runs; the gateway also sets it last regardless.
    await client.callTool({
      name: 'iFinder_search',
      arguments: { query: 'x', user: { id: 'attacker', scopes: ['*'] } }
    });

    const [, calledParams] = runTool.mock.calls[0];
    expect(calledParams.user).toBe(user);
    expect(calledParams.user.id).toBe('alice');
  });
});
