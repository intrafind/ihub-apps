import { describe, it, expect, jest } from '@jest/globals';

/**
 * Group `tools` grants in groups.json read like an app's tool references in
 * the tool listing (`configCache.getToolsForUser`, GET /api/tools): the agent
 * id grants all its skills, as docs/a2a-agents.md says — the same way the MCP
 * gateway reads grants (`getVisibleToolIds`).
 */

const tools = [
  { id: 'a2a__langdock__ask', _a2a: { agentId: 'langdock' } },
  { id: 'a2a__langdock__summarize', _a2a: { agentId: 'langdock' } },
  { id: 'a2a__jira__ask', _a2a: { agentId: 'jira', idConflict: true } },
  { id: 'drawio__create_diagram', _mcp: { serverId: 'drawio' } },
  { id: 'iFinder_search' },
  { id: 'braveSearch' }
];

jest.unstable_mockModule('../../toolLoader.js', () => ({
  loadTools: async () => tools
}));

const { default: configCache } = await import('../../configCache.js');

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
  });

  it('grants nothing without a grant, everything with "*"', async () => {
    expect(await listFor([])).toEqual([]);
    expect(await listFor(['*'])).toHaveLength(tools.length);
  });
});
