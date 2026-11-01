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
const installed = [
  { id: 'atlassian', definition: 'mcp/x', enabled: true },
  // `offline` is installed but down, so it lists no tools — its id still counts.
  { id: 'offline', definition: 'mcp/x', enabled: true }
];
const a2aTools = [
  { id: 'a2a__jira__ask', _a2a: { agentId: 'jira', skillId: 'ask' } },
  { id: 'a2a__atlassian__ask', _a2a: { agentId: 'atlassian', skillId: 'ask' } },
  { id: 'a2a__offline__ask', _a2a: { agentId: 'offline', skillId: 'ask' } },
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
    resolveAllEnabled: async () =>
      installed.map(instance => ({
        instance,
        definition: { id: 'mcp/x', name: { en: 'X' }, protocol: { type: 'mcp' }, actions: [] },
        values: {},
        label: instance.id
      })),
    security: () => ({ blockPrivateIps: true, allowedHosts: [] })
  }
}));
jest.unstable_mockModule('../../services/integrations/protocols/index.js', () => ({
  getProtocolAdapter: () => ({
    dynamicActions: true,
    discoverTools: async ({ instance }) => mcpTools.filter(t => t._mcp.serverId === instance.id)
  }),
  supportedProtocols: () => ['mcp']
}));
jest.unstable_mockModule('../../services/a2a/A2aClientManager.js', () => ({
  default: { callTool: a2aCallTool, listAllTools: async () => a2aTools }
}));

const { loadTools, getToolsForApp, runTool } = await import('../../toolLoader.js');

beforeEach(() => a2aCallTool.mockClear());

describe('A2A agent ids that clash with a tool or installed integration id', () => {
  it('marks the clashing agents and leaves the others alone', async () => {
    const byId = new Map((await loadTools('en')).map(t => [t.id, t]));
    expect(byId.get('a2a__jira__ask')._a2a.idConflict).toBe(true);
    expect(byId.get('a2a__atlassian__ask')._a2a.idConflict).toBe(true);
    expect(byId.get('a2a__offline__ask')._a2a.idConflict).toBe(true);
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
    expect(await ids(['langdock'])).toEqual(['a2a__langdock__ask']);
    // The clashing agent is still reachable by its exact tool id.
    expect(await ids(['a2a__jira__ask'])).toEqual(['a2a__jira__ask']);
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
