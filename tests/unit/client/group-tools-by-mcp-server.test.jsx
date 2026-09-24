/**
 * Unit tests for client/src/features/chat/utils/groupToolsByMcpServer.js —
 * collapses an app's selected MCP tool ids into one entry per server for the
 * end-user tools menu.
 */
import { groupToolsByMcpServer } from '../../../client/src/features/chat/utils/groupToolsByMcpServer';

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
});
