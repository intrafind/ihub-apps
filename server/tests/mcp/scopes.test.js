import { describe, it, expect } from '@jest/globals';
import {
  MCP_SCOPES,
  MCP_SCOPE_LIST,
  MCP_METHOD_SCOPES,
  hasScope,
  hasAnyScope
} from '../../services/mcp/scopes.js';

describe('mcp/scopes', () => {
  it('exposes the five canonical scopes', () => {
    expect(MCP_SCOPES.TOOLS_READ).toBe('mcp:tools:read');
    expect(MCP_SCOPES.TOOLS_CALL).toBe('mcp:tools:call');
    expect(MCP_SCOPES.APPS_INVOKE).toBe('mcp:apps:invoke');
    expect(MCP_SCOPES.WORKFLOWS_RUN).toBe('mcp:workflows:run');
    expect(MCP_SCOPES.RESOURCES_READ).toBe('mcp:resources:read');
    expect(MCP_SCOPE_LIST).toHaveLength(5);
  });

  it('maps MCP methods to scopes', () => {
    expect(MCP_METHOD_SCOPES['tools/list']).toBe(MCP_SCOPES.TOOLS_READ);
    expect(MCP_METHOD_SCOPES['tools/call']).toBe(MCP_SCOPES.TOOLS_CALL);
    expect(MCP_METHOD_SCOPES['resources/list']).toBe(MCP_SCOPES.RESOURCES_READ);
    expect(MCP_METHOD_SCOPES['resources/read']).toBe(MCP_SCOPES.RESOURCES_READ);
  });

  it('hasScope returns false for missing/empty scope arrays', () => {
    expect(hasScope(null, 'mcp:tools:read')).toBe(false);
    expect(hasScope([], 'mcp:tools:read')).toBe(false);
    expect(hasScope(['mcp:tools:read'], 'mcp:tools:read')).toBe(true);
  });

  it('hasAnyScope returns true on partial overlap', () => {
    expect(hasAnyScope(['mcp:tools:call'], ['mcp:tools:read', 'mcp:tools:call'])).toBe(true);
    expect(hasAnyScope(['mcp:apps:invoke'], ['mcp:tools:read'])).toBe(false);
    expect(hasAnyScope([], MCP_SCOPE_LIST)).toBe(false);
  });
});
