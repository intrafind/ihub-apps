// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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

// Provide every named export the tool modules have — ESM link-checks all of them
// even though only a couple are used on the tools-only code path.
jest.unstable_mockModule('../services/tools/appTools.js', () => ({
  getToolsForApp: jest.fn(async () => [])
}));
jest.unstable_mockModule('../services/tools/catalog.js', () => ({
  loadTools: jest.fn(async () => []),
  discoverMcpTools: jest.fn(async () => []),
  localizeTools: jest.fn(tools => tools)
}));
jest.unstable_mockModule('../services/tools/runTool.js', () => ({
  runTool
}));
jest.unstable_mockModule('../services/tools/webSearchResolver.js', () => ({
  resolveNativeWebSearchProvider: jest.fn(() => null),
  resolveAppNativeWebSearch: jest.fn(() => null),
  READ_URL_TOOL_ID: 'read_url'
}));

// The tool is an action of the installed `iFinder` integration, granted to the caller.
const discoverIntegrationTools = jest.fn(async () => []);
jest.unstable_mockModule('../services/integrations/integrationTools.js', () => ({
  discoverIntegrationTools,
  filterIntegrationToolsForUser: tools => tools,
  getIntegrationToolsForApp: () => [],
  userMayUse: () => true
}));
// The Jira installation's approval policy gates its `comment` action (#2945).
const installation = id => ({
  id,
  enabled: true,
  ...(id === 'jira' ? { approval: { default: 'never', actions: { comment: 'always' } } } : {})
});
jest.unstable_mockModule('../services/integrations/installedRefs.js', () => ({
  installedIntegrationById: installation,
  installedIntegrationRefs: () => []
}));
// The tool runner's grant re-check reads the installation through the service.
jest.unstable_mockModule('../services/integrations/InstalledIntegrationService.js', () => ({
  default: { get: installation, list: () => [] }
}));

const { buildMcpServer } = await import('../services/mcp/McpServerService.js');
const { MCP_SCOPES } = await import('../services/mcp/scopes.js');

const iFinderSearchTool = {
  id: 'iFinder_search',
  _integration: { instanceId: 'iFinder', action: 'search', definition: 'com.intrafind/ifinder' },
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

// An action whose approval policy (its installation's, above) needs a person:
// nobody at the gateway can give it.
const jiraCommentTool = {
  id: 'jira_comment',
  _integration: { instanceId: 'jira', action: 'comment', definition: 'com.atlassian/jira' },
  description: 'Comment on a Jira issue',
  parameters: {
    type: 'object',
    properties: { issue: { type: 'string' }, text: { type: 'string' } },
    required: ['issue', 'text']
  }
};

async function connectGateway(user, { tools = [iFinderSearchTool], toolApproval } = {}) {
  discoverIntegrationTools.mockResolvedValue(tools);
  const platform = {
    defaultLanguage: 'en',
    mcpServer: { expose: { tools: true, apps: false, workflows: false, resources: false } },
    ...(toolApproval ? { toolApproval } : {})
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
    discoverIntegrationTools.mockReset();
  });

  // As `mcpAuth` builds it: with resolved permissions (a caller without them runs nothing).
  const user = {
    id: 'alice',
    scopes: [MCP_SCOPES.TOOLS_READ, MCP_SCOPES.TOOLS_CALL],
    permissions: { apps: new Set(), integrations: new Set(['*']) }
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

  it('runs nothing for a caller without resolved permissions', async () => {
    const bare = { id: 'alice', scopes: user.scopes };
    const client = await connectGateway(bare);
    const result = await client.callTool({ name: 'iFinder_search', arguments: { query: 'x' } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('access_denied: tool not permitted for this caller');
    expect(runTool).not.toHaveBeenCalled();
  });
});

describe('MCP gateway tools/call of a tool that needs approval', () => {
  beforeEach(() => {
    runTool.mockClear();
    discoverIntegrationTools.mockReset();
  });

  // As `mcpAuth` builds it: with resolved permissions (a caller without them runs nothing).
  const user = {
    id: 'alice',
    scopes: [MCP_SCOPES.TOOLS_READ, MCP_SCOPES.TOOLS_CALL],
    permissions: { apps: new Set(), integrations: new Set(['*']) }
  };
  const refused = result => {
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^APPROVAL_REQUIRED_NO_USER: /);
  };

  it('refuses a gated action and never runs it', async () => {
    const client = await connectGateway(user, { tools: [jiraCommentTool, iFinderSearchTool] });
    refused(
      await client.callTool({ name: 'jira_comment', arguments: { issue: 'A-1', text: 'hi' } })
    );
    expect(runTool).not.toHaveBeenCalled();
    // The control: an ungated action of the same gateway runs.
    await client.callTool({ name: 'iFinder_search', arguments: { query: 'x' } });
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool.mock.calls[0][0]).toBe('iFinder_search');
  });

  it('refuses every action when the platform default gates all of them', async () => {
    const client = await connectGateway(user, {
      toolApproval: { defaults: { default: 'always' } }
    });
    refused(await client.callTool({ name: 'iFinder_search', arguments: { query: 'x' } }));
    expect(runTool).not.toHaveBeenCalled();
  });
});
