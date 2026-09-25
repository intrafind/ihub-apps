import { describe, it, expect } from '@jest/globals';
import { toolVisibleInSet } from '../../services/mcp/permissions.js';

describe('mcp/permissions toolVisibleInSet', () => {
  it('grants everything on wildcard', () => {
    expect(toolVisibleInSet('anyTool', new Set(['*']))).toBe(true);
  });

  it('grants an exact tool id match', () => {
    expect(toolVisibleInSet('braveSearch', new Set(['braveSearch']))).toBe(true);
  });

  it('grants a function-style tool via its base id', () => {
    expect(toolVisibleInSet('jira_searchTickets', new Set(['jira']))).toBe(true);
  });

  it('grants a tool of an MCP server the set references by server id', () => {
    // Holds whatever tool prefix the server uses, including none.
    expect(toolVisibleInSet('create_diagram', new Set(['drawio']), 'drawio')).toBe(true);
    expect(toolVisibleInSet('create_diagram', new Set(['drawio']), 'excalidraw')).toBe(false);
    expect(toolVisibleInSet('create_diagram', new Set(['drawio']))).toBe(false);
  });

  it('denies a tool not in the set (default-deny)', () => {
    expect(toolVisibleInSet('secretTool', new Set(['other']))).toBe(false);
  });

  it('denies when the visible set is not a Set', () => {
    expect(toolVisibleInSet('x', undefined)).toBe(false);
    expect(toolVisibleInSet('x', null)).toBe(false);
    expect(toolVisibleInSet('x', ['x'])).toBe(false);
  });
});
