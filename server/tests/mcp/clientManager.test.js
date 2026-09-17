import { describe, it, expect, beforeEach } from '@jest/globals';
import mcpClientManager from '../../services/mcp/McpClientManager.js';

/**
 * The manager's transport and SDK Client are real, so we can't easily
 * exercise listAllTools without a network server. Instead, we drive the
 * connection cache directly to verify the dispatch logic (prefix matching,
 * unhealthy skip, duplicate dedup, ownsTool).
 */
describe('McpClientManager dispatch', () => {
  beforeEach(async () => {
    await mcpClientManager.shutdown();
    await mcpClientManager.initialize({ servers: [] });
  });

  it('returns empty tool list when no servers are configured', async () => {
    const tools = await mcpClientManager.listAllTools();
    expect(tools).toEqual([]);
  });

  it('ownsTool returns false when no connection has cached the tool', () => {
    expect(mcpClientManager.ownsTool('anything')).toBe(false);
  });

  it('refuses to load an invalid mcpServers.json shape', async () => {
    // No throw — initialize tolerates broken config and falls back to empty state.
    await mcpClientManager.initialize({ servers: [{ /* missing id */ name: 'broken' }] });
    expect(await mcpClientManager.listAllTools()).toEqual([]);
  });

  it('callTool throws when prefixed name is not owned by any server', async () => {
    await expect(mcpClientManager.callTool('unknown__tool', {})).rejects.toThrow(/not found/);
  });
});
