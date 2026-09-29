import { describe, it, expect, jest, beforeEach } from '@jest/globals';

/**
 * toolLoader's A2A guards:
 *
 * - an agent whose id is also a local tool's (base) id or an MCP server's id
 *   is not selected by that id — the reference keeps its old meaning and the
 *   remote agent is never granted by accident (#2546 review);
 * - runTool hands the chat turn's abort signal to the A2A client, so a user
 *   stop reaches the remote agent.
 */

const a2aCallTool = jest.fn(async () => 'agent answer');

const localTools = [{ id: 'jira_searchTickets', name: 'Jira search', script: 'jira.js' }];
const mcpTools = [{ id: 'atlassian__search', _mcp: { serverId: 'atlassian' } }];
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
    // `offline` is configured but down, so it lists no tools — its id still counts.
    getMcpServers: () => ({ data: { servers: [{ id: 'atlassian' }, { id: 'offline' }] } })
  }
}));
jest.unstable_mockModule('../../services/mcp/McpClientManager.js', () => ({
  default: { callTool: jest.fn(), listAllTools: async () => mcpTools }
}));
jest.unstable_mockModule('../../services/a2a/A2aClientManager.js', () => ({
  default: { callTool: a2aCallTool, listAllTools: async () => a2aTools }
}));

const { loadTools, getToolsForApp, runTool } = await import('../../toolLoader.js');

beforeEach(() => a2aCallTool.mockClear());

describe('A2A agent ids that clash with a tool or MCP server id', () => {
  it('marks the clashing agents and leaves the others alone', async () => {
    const byId = new Map((await loadTools('en')).map(t => [t.id, t]));
    expect(byId.get('a2a__jira__ask')._a2a.idConflict).toBe(true);
    expect(byId.get('a2a__atlassian__ask')._a2a.idConflict).toBe(true);
    expect(byId.get('a2a__offline__ask')._a2a.idConflict).toBe(true);
    expect(byId.get('a2a__langdock__ask')._a2a.idConflict).toBeUndefined();
    // The manager's cached tool objects are not mutated.
    expect(a2aTools[0]._a2a.idConflict).toBeUndefined();
  });

  it('keeps an app reference meaning the local tool or MCP server only', async () => {
    const ids = async tools => (await getToolsForApp({ id: 'app', tools }, 'en')).map(t => t.id);
    expect(await ids(['jira'])).toEqual(['jira_searchTickets']);
    expect(await ids(['atlassian'])).toEqual(['atlassian__search']);
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
