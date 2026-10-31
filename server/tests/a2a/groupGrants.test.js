// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, jest } from '@jest/globals';

/**
 * Group `tools` grants in groups.json read like an app's tool references in
 * the tool listing (`configCache.getToolsForUser`, GET /api/tools): the agent
 * id grants all its skills, as docs/a2a-agents.md says — the same way the MCP
 * gateway reads grants (`getVisibleToolIds`).
 */

// Agent skills carry the installation marker the A2A adapter adds; `jira`
// is also a local tool's id, which the loader marks on the agent's skills.
const tools = [
  {
    id: 'a2a__langdock__ask',
    _a2a: { agentId: 'langdock' },
    _integration: { instanceId: 'langdock' }
  },
  {
    id: 'a2a__langdock__summarize',
    _a2a: { agentId: 'langdock' },
    _integration: { instanceId: 'langdock' }
  },
  {
    id: 'a2a__jira__ask',
    _a2a: { agentId: 'jira', idConflict: true },
    _integration: { instanceId: 'jira' }
  },
  { id: 'drawio__create_diagram', _mcp: { serverId: 'drawio' } },
  { id: 'iFinder_search' },
  { id: 'braveSearch' }
];

jest.unstable_mockModule('../../toolLoader.js', () => ({
  loadTools: async () => tools
}));

const { default: configCache } = await import('../../configCache.js');

// The listing drops an integration tool whose installation is missing,
// disabled or closed to the user's groups; both agents are installed and open.
configCache.setCacheEntry('config/integrations.json', {
  installed: [
    { id: 'langdock', definition: 'com.intrafind/a2a-agent', enabled: true },
    { id: 'jira', definition: 'com.intrafind/a2a-agent', enabled: true }
  ],
  security: { blockPrivateIps: true, allowedHosts: [] }
});

const listFor = async grants => {
  const user = { id: 'u', groups: ['g'], permissions: { tools: new Set(grants) } };
  const { data } = await configCache.getToolsForUser(user, {}, 'en');
  return data.map(tool => tool.id).sort();
};

describe('group tool grants in the tool listing', () => {
  it('grants every skill of an agent by the agent id', async () => {
    expect(await listFor(['langdock'])).toEqual(['a2a__langdock__ask', 'a2a__langdock__summarize']);
  });

  it('grants one skill by its tool id (any case, as before)', async () => {
    expect(await listFor(['A2A__LANGDOCK__ASK'])).toEqual(['a2a__langdock__ask']);
  });

  it('reads MCP server ids and base ids like the MCP gateway does', async () => {
    expect(await listFor(['drawio', 'iFinder'])).toEqual([
      'drawio__create_diagram',
      'iFinder_search'
    ]);
  });

  it('never grants an agent through an id it shares with a tool', async () => {
    expect(await listFor(['jira'])).toEqual([]);
    // The agent reference still works.
    expect(await listFor(['a2a__jira'])).toEqual(['a2a__jira__ask']);
  });

  it('grants nothing without a grant, everything with "*"', async () => {
    expect(await listFor([])).toEqual([]);
    expect(await listFor(['*'])).toHaveLength(tools.length);
  });
});
