// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

/**
 * toolLoader's A2A guards:
 *
 * - an agent whose id is also a local tool's (base) id or an installed
 *   integration's id (an MCP server) is not selected by that id — the
 *   reference keeps its old meaning and the remote agent is never granted by
 *   accident (#2546 review);
 * - runTool hands the chat turn's abort signal to the A2A client, so a user
 *   stop reaches the remote agent.
 */

const a2aCallTool = jest.fn(async () => 'agent answer');

const localTools = [{ id: 'jira_searchTickets', name: 'Jira search', script: 'jira.js' }];
// The MCP server is an installed integration: its tools carry both markers.
const mcpTools = [
  {
    id: 'atlassian__search',
    _mcp: { serverId: 'atlassian' },
    _integration: { instanceId: 'atlassian', action: 'search', definition: 'mcp/x' }
  }
];
// The remote agents are installations too.
const AGENT_DEF = 'com.intrafind/a2a-agent';
const installed = [
  { id: 'atlassian', definition: 'mcp/x', enabled: true },
  // `offline` is installed but down, so it lists no tools — its id still counts.
  { id: 'offline', definition: 'mcp/x', enabled: true },
  { id: 'jira', definition: AGENT_DEF, enabled: true },
  { id: 'langdock', definition: AGENT_DEF, enabled: true }
];
const definitionOf = instance =>
  instance.definition === AGENT_DEF
    ? { id: AGENT_DEF, name: { en: 'Agent' }, protocol: { type: 'a2a' }, actions: [] }
    : { id: 'mcp/x', name: { en: 'X' }, protocol: { type: 'mcp' }, actions: [] };
const a2aTools = [
  { id: 'a2a__jira__ask', _a2a: { agentId: 'jira', skillId: 'ask' } },
  { id: 'a2a__langdock__ask', _a2a: { agentId: 'langdock', skillId: 'ask' } }
];

jest.unstable_mockModule('../../configCache.js', () => ({
  default: {
    getTools: () => ({ data: localTools }),
    getPlatform: () => ({ defaultLanguage: 'en' }),
    getWorkflows: () => ({ data: [] }),
    getFeatures: () => ({}),
    getIntegrations: () => ({ data: { installed } })
  }
}));
jest.unstable_mockModule('../../services/mcp/McpClientManager.js', () => ({
  default: { callTool: jest.fn(), listAllTools: async () => mcpTools }
}));
jest.unstable_mockModule('../../services/integrations/InstalledIntegrationService.js', () => ({
  default: {
    list: () => installed,
    get: id => installed.find(i => i.id === id) || null,
    resolve: async idOrInstance => {
      const instance =
        typeof idOrInstance === 'string'
          ? installed.find(i => i.id === idOrInstance)
          : idOrInstance;
      return instance
        ? { instance, definition: definitionOf(instance), values: {}, label: instance.id }
        : null;
    },
    resolveAllEnabled: async () =>
      installed.map(instance => ({
        instance,
        definition: definitionOf(instance),
        values: {},
        label: instance.id
      })),
    security: () => ({ blockPrivateIps: true, allowedHosts: [] })
  }
}));
const withMarker = (tool, instance) => ({
  ...tool,
  _integration: {
    instanceId: instance.id,
    action: tool._a2a?.skillId || 'x',
    definition: AGENT_DEF
  }
});
jest.unstable_mockModule('../../services/integrations/protocols/index.js', () => ({
  getProtocolAdapter: type => ({
    dynamicActions: true,
    discoverTools: async ({ instance }) =>
      type === 'a2a'
        ? a2aTools.filter(t => t._a2a.agentId === instance.id).map(t => withMarker(t, instance))
        : mcpTools.filter(t => t._mcp.serverId === instance.id),
    run: async ({ context }) =>
      a2aCallTool(context.tool.id, context.params, { signal: context.options?.signal })
  }),
  supportedProtocols: () => ['mcp', 'a2a']
}));
jest.unstable_mockModule('../../services/a2a/A2aClientManager.js', () => ({
  default: { callTool: a2aCallTool, listAllTools: async () => a2aTools }
}));

const { loadTools, getToolsForApp, runTool } = await import('../../toolLoader.js');

beforeEach(() => a2aCallTool.mockClear());

describe('A2A agent ids that clash with a tool or installed integration id', () => {
  it('marks the clashing agents and leaves the others alone', async () => {
    const byId = new Map((await loadTools('en')).map(t => [t.id, t]));
    // `jira` is also a local tool's base id; the other agents' ids are their own.
    expect(byId.get('a2a__jira__ask')._a2a.idConflict).toBe(true);
    expect(byId.get('a2a__langdock__ask')._a2a.idConflict).toBeUndefined();
    // The manager's cached tool objects are not mutated.
    expect(a2aTools[0]._a2a.idConflict).toBeUndefined();
  });

  it('keeps an app reference meaning the local tool or installed integration only', async () => {
    const ids = async (tools, integrations) =>
      (await getToolsForApp({ id: 'app', tools, integrations }, 'en')).map(t => t.id);
    expect(await ids(['jira'])).toEqual(['jira_searchTickets']);
    // An installed integration's tools come through the binding, not a tool reference.
    expect(await ids(['atlassian'])).toEqual([]);
    expect(await ids([], { atlassian: {} })).toEqual(['atlassian__search']);
    // A remote agent is bound like any installation; its references in
    // `tools` select nothing any more.
    expect(await ids(['langdock'])).toEqual([]);
    expect(await ids(['a2a__jira__ask'])).toEqual([]);
    expect(await ids([], { langdock: {} })).toEqual(['a2a__langdock__ask']);
    expect(await ids([], { jira: {} })).toEqual(['a2a__jira__ask']);
  });
});

describe('runTool for an A2A tool', () => {
  it('passes the chat turn’s abort signal to the A2A client', async () => {
    const controller = new AbortController();
    const answer = await runTool(
      'a2a__langdock__ask',
      { message: 'hi', chatId: 'c', user: { id: 'u' } },
      { signal: controller.signal }
    );
    expect(answer).toBe('agent answer');
    expect(a2aCallTool.mock.calls[0][2]).toEqual({ signal: controller.signal });
  });
});
