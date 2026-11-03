/**
 * Unit tests for client/src/features/chat/utils/groupToolsByMcpServer.js —
 * `collapseMcpTools`: one entry per MCP server or remote agent in the app
 * creation wizard's tool picker. (The chat's picker gets its rows from the
 * server, #2923.)
 */
import { collapseMcpTools } from '../../../client/src/features/chat/utils/groupToolsByMcpServer';

const localize = name => (typeof name === 'object' ? name?.en : name) || '';

describe('collapseMcpTools', () => {
  test('offers one entry per MCP server, keyed by the server id', () => {
    const tools = [
      { id: 'braveSearch', name: 'Brave', description: 'Search' },
      {
        id: 'drawio__create_diagram',
        name: 'drawio__create_diagram',
        description: 'x'.repeat(50000),
        _mcp: { serverId: 'drawio', serverName: { en: 'draw.io' } }
      },
      { id: 'drawio__search_shapes', _mcp: { serverId: 'drawio', serverName: { en: 'draw.io' } } }
    ];
    expect(collapseMcpTools(tools, localize)).toEqual([
      tools[0],
      { id: 'drawio', name: 'draw.io', description: '', mcpServer: true }
    ]);
  });

  test('offers one entry per remote A2A agent, keyed by the agent id', () => {
    const tools = [
      { id: 'a2a__langdock__ask', _a2a: { agentId: 'langdock', agentName: 'Langdock' } },
      { id: 'a2a__langdock__sum', _a2a: { agentId: 'langdock', agentName: 'Langdock' } }
    ];
    expect(collapseMcpTools(tools, localize)).toEqual([
      { id: 'langdock', name: 'Langdock', description: '', a2aAgent: true }
    ]);
  });
});

describe('collapseMcpTools with a clashing agent id', () => {
  test('offers an agent marked idConflict as one entry keyed a2a__<agentId>', () => {
    const tools = [
      { id: 'x__tool', _mcp: { serverId: 'x', serverName: 'Server X' } },
      { id: 'a2a__x__ask', _a2a: { agentId: 'x', agentName: 'Agent X', idConflict: true } },
      { id: 'a2a__x__sum', _a2a: { agentId: 'x', agentName: 'Agent X', idConflict: true } }
    ];
    const entries = collapseMcpTools(tools, localize);
    expect(entries.map(e => e.id)).toEqual(['x', 'a2a__x']);
    expect(entries[1]).toMatchObject({ name: 'Agent X', a2aAgent: true });
    // No two picker entries share an id (they would share a React key and a checkbox).
    expect(new Set(entries.map(e => e.id)).size).toBe(entries.length);
  });
});
