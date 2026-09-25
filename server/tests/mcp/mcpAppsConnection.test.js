import { describe, it, expect, jest } from '@jest/globals';
import { McpServerConnection, toPlainHeaders } from '../../services/mcp/McpServerConnection.js';
import mcpClientManager, { toMcpArguments } from '../../services/mcp/McpClientManager.js';
import { mcpServerConfigSchema } from '../../validators/mcpServerConfigSchema.js';

/**
 * MCP Apps on the client connection: which tools the model is offered, which
 * a view may call, the raw result a view is drawn from, and the UI resource.
 * The SDK client is replaced by a fake so no server is needed.
 */

const TOOLS = [
  {
    name: 'create_view',
    description: 'Draw',
    inputSchema: { type: 'object', properties: { elements: { type: 'string' } } },
    _meta: { ui: { resourceUri: 'ui://excalidraw/mcp-app.html' } }
  },
  {
    name: 'save_checkpoint',
    inputSchema: { type: 'object' },
    _meta: { ui: { visibility: ['app'] } }
  },
  { name: 'read_me', inputSchema: { type: 'object' } },
  { name: 'model_only', inputSchema: { type: 'object' }, _meta: { ui: { visibility: ['model'] } } }
];

function connectionWith(overrides = {}, { tools = TOOLS, client = {} } = {}) {
  const config = mcpServerConfigSchema.parse({
    id: 'excalidraw',
    name: 'Excalidraw',
    transport: { type: 'streamableHttp', url: 'https://mcp.excalidraw.com/mcp' },
    ...overrides
  });
  const conn = new McpServerConnection(config, { blockPrivateIps: true, allowedHosts: [] });
  conn.connected = true;
  conn.client = {
    listTools: jest.fn(async () => ({ tools })),
    callTool: jest.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
    readResource: jest.fn(async ({ uri }) => ({
      contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: '<html></html>' }]
    })),
    ...client
  };
  return conn;
}

describe('McpServerConnection.listTools with MCP Apps', () => {
  it('hides app-only tools from the model and marks tools that render a view', async () => {
    const conn = connectionWith();
    const tools = await conn.listTools();
    expect(tools.map(t => t.id)).toEqual([
      'excalidraw__create_view',
      'excalidraw__read_me',
      'excalidraw__model_only'
    ]);
    expect(tools[0]._mcp.ui).toEqual({ resourceUri: 'ui://excalidraw/mcp-app.html' });
    expect(tools[1]._mcp.ui).toBeUndefined();
  });

  it('uses the `<id>__` default for a blank tool prefix and honours a typed one', async () => {
    // The admin form used to save a blank prefix as "", which exposed the tools
    // with no prefix at all and let two servers' tools collide.
    const blank = await connectionWith({ toolPrefix: '' }).listTools();
    expect(blank[0].id).toBe('excalidraw__create_view');
    const typed = await connectionWith({ toolPrefix: 'ex_' }).listTools();
    expect(typed[0].id).toBe('ex_create_view');
  });

  it('lets a view call app-visible tools but not model-only ones', async () => {
    const conn = connectionWith();
    expect(await conn.getAppTool('save_checkpoint')).toMatchObject({ name: 'save_checkpoint' });
    expect(await conn.getAppTool('create_view')).toMatchObject({ name: 'create_view' });
    expect(await conn.getAppTool('read_me')).toMatchObject({ name: 'read_me' });
    expect(await conn.getAppTool('model_only')).toBeNull();
    expect(await conn.getAppTool('unknown')).toBeNull();
  });

  it('applies the allowlist to what the model sees and to app-visible model tools, but keeps app-only helpers', async () => {
    const conn = connectionWith({ allowedTools: ['create_view'] });
    expect((await conn.listTools()).map(t => t.id)).toEqual(['excalidraw__create_view']);
    expect(await conn.getAppTool('save_checkpoint')).not.toBeNull();
    expect(await conn.getAppTool('read_me')).toBeNull();
  });

  it('with apps disabled: no views, nothing callable by apps, app-only tools still hidden', async () => {
    const conn = connectionWith({ apps: { enabled: false } });
    const tools = await conn.listTools();
    expect(tools.map(t => t.id)).not.toContain('excalidraw__save_checkpoint');
    expect(tools.every(t => !t._mcp.ui)).toBe(true);
    expect(await conn.getAppTool('save_checkpoint')).toBeNull();
  });

  it('follows tools/list pagination', async () => {
    const listTools = jest
      .fn()
      .mockResolvedValueOnce({ tools: [TOOLS[0]], nextCursor: 'p2' })
      .mockResolvedValueOnce({ tools: [TOOLS[2]] });
    const conn = connectionWith({}, { client: { listTools } });
    expect((await conn.listTools()).map(t => t.id)).toEqual([
      'excalidraw__create_view',
      'excalidraw__read_me'
    ]);
    expect(listTools).toHaveBeenLastCalledWith({ cursor: 'p2' });
  });
});

describe('McpServerConnection tool results for views', () => {
  it('hands the raw result to onRawResult and still throws on isError', async () => {
    const raw = { content: [{ type: 'text', text: 'bad input' }], isError: true };
    const conn = connectionWith({}, { client: { callTool: jest.fn(async () => raw) } });
    const onRawResult = jest.fn();
    await expect(conn.callTool('create_view', {}, { onRawResult })).rejects.toThrow('bad input');
    expect(onRawResult).toHaveBeenCalledWith(raw);
  });

  it('callToolRaw returns the full CallToolResult', async () => {
    const raw = { content: [], structuredContent: { id: 'cp1' } };
    const conn = connectionWith({}, { client: { callTool: jest.fn(async () => raw) } });
    expect(await conn.callToolRaw('save_checkpoint', { id: 'cp1' })).toBe(raw);
  });

  it('reads and caches the UI resource', async () => {
    const conn = connectionWith();
    const first = await conn.getUiResource('ui://excalidraw/mcp-app.html');
    const second = await conn.getUiResource('ui://excalidraw/mcp-app.html');
    expect(first.html).toBe('<html></html>');
    expect(second).toBe(first);
    expect(conn.client.readResource).toHaveBeenCalledTimes(1);
  });
});

describe('toPlainHeaders', () => {
  it('keeps the headers of a Headers instance (the SDK transports pass one)', () => {
    const headers = new Headers({ Accept: 'application/json, text/event-stream' });
    headers.set('content-type', 'application/json');
    expect(toPlainHeaders(headers)).toEqual({
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json'
    });
    expect(toPlainHeaders({ 'x-a': '1' })).toEqual({ 'x-a': '1' });
    expect(toPlainHeaders(undefined)).toEqual({});
  });
});

describe('toMcpArguments', () => {
  it("never forwards iHub's own context to an external server", () => {
    const params = {
      elements: '[]',
      chatId: 'c1',
      user: { id: 'u1', email: 'a@b.c' },
      appConfig: { id: 'app' },
      passthrough: true,
      _fileData: {},
      language: 'de'
    };
    expect(toMcpArguments(params, { properties: { elements: {} } })).toEqual({ elements: '[]' });
  });

  it('forwards language only when the tool declares it', () => {
    expect(toMcpArguments({ language: 'de' }, { properties: { language: {} } })).toEqual({
      language: 'de'
    });
  });
});

describe('McpClientManager', () => {
  it('reconnects a server when its MCP Apps toggle changes (capabilities are negotiated on connect)', async () => {
    const server = {
      id: 'excalidraw',
      name: 'Excalidraw',
      transport: { type: 'streamableHttp', url: 'https://mcp.excalidraw.com/mcp' }
    };
    await mcpClientManager.initialize({ servers: [server] });
    const before = mcpClientManager.getConnection('excalidraw');
    await mcpClientManager.initialize({ servers: [{ ...server, timeoutMs: 5000 }] });
    expect(mcpClientManager.getConnection('excalidraw')).toBe(before);
    await mcpClientManager.initialize({ servers: [{ ...server, apps: { enabled: false } }] });
    expect(mcpClientManager.getConnection('excalidraw')).not.toBe(before);
    await mcpClientManager.shutdown();
    await mcpClientManager.initialize({ servers: [] });
  });
});
