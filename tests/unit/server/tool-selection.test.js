/**
 * Unit tests for server/utils/toolSelection.js — how an app's `tools` (and a
 * chat's `enabledTools`) select tool definitions.
 */
import { isToolSelected } from '../../../server/utils/toolSelection.js';

describe('isToolSelected', () => {
  const drawioTool = { id: 'create_diagram', _mcp: { serverId: 'drawio' } };

  test('selects a tool by its exact id', () => {
    expect(isToolSelected({ id: 'braveSearch' }, ['braveSearch'])).toBe(true);
  });

  test('selects a function-style tool by its base id', () => {
    expect(isToolSelected({ id: 'jira_searchTickets' }, ['jira'])).toBe(true);
  });

  test('selects every tool of an MCP server the list names by server id', () => {
    // The server's tools carry no `drawio__` prefix here, so only the server id
    // on the `_mcp` marker can match — the shipped draw.io app lists `["drawio"]`.
    expect(isToolSelected(drawioTool, ['drawio'])).toBe(true);
    expect(isToolSelected(drawioTool, new Set(['drawio']))).toBe(true);
  });

  test('does not select a tool of another server or an unlisted tool', () => {
    expect(isToolSelected(drawioTool, ['excalidraw'])).toBe(false);
    expect(isToolSelected({ id: 'secretTool' }, ['other'])).toBe(false);
    expect(isToolSelected({ id: 'drawio' }, [])).toBe(false);
  });

  test('handles missing input', () => {
    expect(isToolSelected(null, ['x'])).toBe(false);
    expect(isToolSelected({ id: 'x' }, undefined)).toBe(false);
  });
});
