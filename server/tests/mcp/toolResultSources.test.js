import { describe, it, expect, jest } from '@jest/globals';
import { McpServerConnection } from '../../services/mcp/McpServerConnection.js';
import { mcpServerConfigSchema } from '../../validators/mcpServerConfigSchema.js';
import { runToolCallScope } from '../../services/sources/toolCallScope.js';

/**
 * Sources an MCP server reports in `structuredContent.sources`. The model reads
 * only the content blocks, so the connection reports them beside the result,
 * into the tool call the loop runs (services/sources/toolCallScope.js). The SDK
 * client is replaced by a fake so no server is needed.
 */

function connectionReturning(result) {
  const config = mcpServerConfigSchema.parse({
    id: 'docs',
    name: 'Docs',
    transport: { type: 'streamableHttp', url: 'https://mcp.docs.example/mcp' }
  });
  const conn = new McpServerConnection(config, { blockPrivateIps: true, allowedHosts: [] });
  conn.connected = true;
  conn.client = { callTool: jest.fn(async () => result) };
  return conn;
}

const SOURCES = [{ title: 'Install guide', url: 'https://docs.example/guide' }];

describe('McpServerConnection: sources in structuredContent', () => {
  it('reports them beside the text the model reads', async () => {
    const conn = connectionReturning({
      content: [{ type: 'text', text: 'Found the install guide.' }],
      structuredContent: { sources: SOURCES }
    });
    const reported = [];
    const text = await runToolCallScope(reported, () => conn.callTool('find', {}));
    expect(text).toBe('Found the install guide.');
    expect(reported).toEqual(SOURCES);
  });

  it('reports nothing for a failed call, and nothing outside a tool call', async () => {
    const failed = connectionReturning({
      isError: true,
      content: [{ type: 'text', text: 'boom' }],
      structuredContent: { sources: SOURCES }
    });
    const reported = [];
    await expect(runToolCallScope(reported, () => failed.callTool('find', {}))).rejects.toThrow(
      'boom'
    );
    expect(reported).toEqual([]);

    const ok = connectionReturning({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { sources: SOURCES }
    });
    await expect(ok.callTool('find', {})).resolves.toBe('ok');
  });
});
