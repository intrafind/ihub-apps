/**
 * Unit tests for client/src/features/chat/utils/groupToolsByMcpServer.js —
 * collapses an app's selected MCP tool ids into one entry per server for the
 * end-user tools menu.
 */
import {
  groupToolsByMcpServer,
  collapseMcpTools
} from '../../../client/src/features/chat/utils/groupToolsByMcpServer';

const localize = name => (typeof name === 'object' ? name?.en : name) || '';

describe('groupToolsByMcpServer', () => {
  const excalidrawTools = [
    {
      id: 'excalidraw__read_me',
      _mcp: { serverId: 'excalidraw', serverName: { en: 'Excalidraw' } }
    },
    {
      id: 'excalidraw__create_view',
      _mcp: { serverId: 'excalidraw', serverName: { en: 'Excalidraw' } }
    },
    { id: 'braveSearch' }
  ];

  test('collapses every tool of one server into a single named group', () => {
    const { grouped, individual } = groupToolsByMcpServer(
      ['excalidraw__read_me', 'excalidraw__create_view', 'braveSearch'],
      excalidrawTools,
      localize
    );

    expect(grouped).toHaveLength(1);
    // Named after the server, not a raw tool id, and keeping both underlying
    // ids so the toggle enables or disables them together.
    expect(grouped[0].name).toBe('Excalidraw');
    expect(grouped[0].matchedTools).toEqual(['excalidraw__read_me', 'excalidraw__create_view']);
    // Script-backed tools have no `_mcp` metadata and stay individual.
    expect(individual).toEqual(['braveSearch']);
  });

  test('an empty app.tools produces no groups and no individual tools', () => {
    expect(groupToolsByMcpServer([], [], localize)).toEqual({ grouped: [], individual: [] });
  });

  test('a server with none of its tools selected is not shown', () => {
    // `app.tools` only contains what was selected, so there is nothing to group.
    const available = [
      { id: 'drawio__create_diagram', _mcp: { serverId: 'drawio', serverName: { en: 'draw.io' } } }
    ];
    const { grouped } = groupToolsByMcpServer(['braveSearch'], available, localize);
    expect(grouped).toHaveLength(0);
  });

  test('falls back to the server id when no display name is available', () => {
    // Server metadata may still be loading when the menu first renders.
    const available = [{ id: 'drawio__create_diagram', _mcp: { serverId: 'drawio' } }];
    const { grouped } = groupToolsByMcpServer(['drawio__create_diagram'], available, localize);
    expect(grouped[0].name).toBe('drawio');
  });

  test('an app that references the server by id gets one group, not a raw id', () => {
    // The shipped draw.io app lists `tools: ["drawio"]` — the server, not a tool.
    // It must render as the server's toggle, with no stray "drawio" entry and no
    // per-tool toggles next to it.
    const available = [
      { id: 'create_diagram', _mcp: { serverId: 'drawio', serverName: { en: 'draw.io' } } },
      { id: 'search_shapes', _mcp: { serverId: 'drawio', serverName: { en: 'draw.io' } } }
    ];
    const { grouped, individual } = groupToolsByMcpServer(['drawio'], available, localize);
    expect(grouped).toEqual([{ id: 'mcp-drawio', name: 'draw.io', matchedTools: ['drawio'] }]);
    expect(individual).toEqual([]);
  });

  test('a server reference and older per-tool references share one toggle', () => {
    const available = [
      { id: 'drawio__create_diagram', _mcp: { serverId: 'drawio', serverName: 'draw.io' } }
    ];
    const { grouped, individual } = groupToolsByMcpServer(
      ['drawio', 'drawio__create_diagram'],
      available,
      localize
    );
    expect(grouped).toHaveLength(1);
    expect(grouped[0].matchedTools).toEqual(['drawio', 'drawio__create_diagram']);
    expect(individual).toEqual([]);
  });

  test('never shows a reference that resolves to no loaded tool', () => {
    // An old bare name after the tool prefix fix, or a server that is down: a
    // toggle would do nothing, and it must not appear as a stray tool entry.
    const available = [
      { id: 'drawio__create_diagram', _mcp: { serverId: 'drawio', serverName: 'draw.io' } },
      { id: 'iFinder_search' }
    ];
    const { grouped, individual } = groupToolsByMcpServer(
      ['drawio', 'create_diagram', 'excalidraw', 'iFinder'],
      available,
      localize
    );
    expect(grouped.map(g => g.name)).toEqual(['draw.io']);
    // A function-style base id still resolves and stays.
    expect(individual).toEqual(['iFinder']);
  });

  test('keeps every reference while no tools are loaded', () => {
    const { individual } = groupToolsByMcpServer(['drawio', 'braveSearch'], [], localize);
    expect(individual).toEqual(['drawio', 'braveSearch']);
  });

  describe('remote A2A agents', () => {
    const a2aTools = [
      {
        id: 'a2a__langdock__ask_langdock_agent',
        _a2a: { agentId: 'langdock', agentName: { en: 'Langdock agent' }, skillId: 'Ask' }
      },
      {
        id: 'a2a__langdock__summarize',
        _a2a: { agentId: 'langdock', agentName: { en: 'Langdock agent' }, skillId: 'sum' }
      },
      { id: 'drawio__create_diagram', _mcp: { serverId: 'drawio', serverName: 'draw.io' } }
    ];

    test('an app that references the agent by id gets one toggle for all its skills', () => {
      const { grouped, individual } = groupToolsByMcpServer(
        ['langdock', 'drawio'],
        a2aTools,
        localize
      );
      expect(grouped).toEqual([
        { id: 'a2a-langdock', name: 'Langdock agent', matchedTools: ['langdock'] },
        { id: 'mcp-drawio', name: 'draw.io', matchedTools: ['drawio'] }
      ]);
      expect(individual).toEqual([]);
    });

    test('single skill tools fold into the agent toggle', () => {
      const { grouped } = groupToolsByMcpServer(
        ['a2a__langdock__summarize', 'langdock'],
        a2aTools,
        localize
      );
      expect(grouped).toHaveLength(1);
      expect(grouped[0].matchedTools).toEqual(['a2a__langdock__summarize', 'langdock']);
    });

    test('an agent and an MCP server with the same id stay separate', () => {
      const tools = [
        { id: 'a2a__x__ask', _a2a: { agentId: 'x', agentName: 'Agent X' } },
        { id: 'x__tool', _mcp: { serverId: 'x', serverName: 'Server X' } }
      ];
      const { grouped } = groupToolsByMcpServer(['a2a__x__ask', 'x__tool'], tools, localize);
      expect(grouped.map(g => g.id)).toEqual(['a2a-x', 'mcp-x']);
    });

    test('a bare id shared by an agent and an MCP server is the MCP server', () => {
      const tools = [
        { id: 'a2a__x__ask', _a2a: { agentId: 'x', agentName: 'Agent X', idConflict: true } },
        { id: 'x__tool', _mcp: { serverId: 'x', serverName: 'Server X' } }
      ];
      // Whatever order the tools load in, the reference means the server.
      for (const list of [tools, [...tools].reverse()]) {
        expect(groupToolsByMcpServer(['x'], list, localize).grouped).toEqual([
          { id: 'mcp-x', name: 'Server X', matchedTools: ['x'] }
        ]);
      }
    });

    test('an agent whose id clashes with a local tool is not enabled by that id', () => {
      const tools = [
        {
          id: 'a2a__jira__ask',
          _a2a: { agentId: 'jira', agentName: 'Jira agent', idConflict: true }
        },
        { id: 'jira_searchTickets' }
      ];
      const { grouped, individual } = groupToolsByMcpServer(['jira'], tools, localize);
      expect(grouped).toEqual([]);
      expect(individual).toEqual(['jira']);
      // By its tool id the agent still gets its own toggle.
      expect(groupToolsByMcpServer(['a2a__jira__ask'], tools, localize).grouped).toEqual([
        { id: 'a2a-jira', name: 'Jira agent', matchedTools: ['a2a__jira__ask'] }
      ]);
    });

    test('a2a__<agentId> enables a clashing agent as a whole', () => {
      const tools = [
        {
          id: 'a2a__jira__ask',
          _a2a: { agentId: 'jira', agentName: 'Jira agent', idConflict: true }
        },
        {
          id: 'a2a__jira__sum',
          _a2a: { agentId: 'jira', agentName: 'Jira agent', idConflict: true }
        },
        { id: 'jira_searchTickets' }
      ];
      const { grouped, individual } = groupToolsByMcpServer(['jira', 'a2a__jira'], tools, localize);
      expect(grouped).toEqual([
        { id: 'a2a-jira', name: 'Jira agent', matchedTools: ['a2a__jira'] }
      ]);
      expect(individual).toEqual(['jira']);
      // Also for an agent without a clash.
      expect(groupToolsByMcpServer(['a2a__langdock'], a2aTools, localize).grouped).toHaveLength(1);
    });

    test('the literal reference "a2a" is not a base id for every agent', () => {
      const { grouped, individual } = groupToolsByMcpServer(['a2a'], a2aTools, localize);
      expect(grouped).toEqual([]);
      expect(individual).toEqual([]);
    });
  });
});

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
