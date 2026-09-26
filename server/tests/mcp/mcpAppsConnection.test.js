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

/** A Langdock-style tool: the file parameter is an object marked `format: "file"`. */
const INSPECT_FILE = {
  name: 'inspect_file',
  description: 'Accept a file and return basic file metadata',
  inputSchema: {
    type: 'object',
    properties: {
      doc: {
        type: 'object',
        description: 'File to inspect',
        format: 'file',
        properties: {
          fileName: { type: 'string' },
          mimeType: { type: 'string' },
          base64: { type: 'string' },
          size: { type: 'number' }
        }
      },
      verbose: { type: 'boolean' }
    },
    required: ['doc']
  }
};

const ATTACHMENTS = [
  {
    type: 'document',
    fileName: 'report.pdf',
    fileSize: 4,
    fileType: 'application/pdf',
    content: 'the report',
    base64: 'data:application/pdf;base64,JVBERg=='
  }
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
      _attachments: [{ fileName: 'report.pdf', base64: 'JVBERg==' }],
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

describe('McpServerConnection.listTools with file inputs', () => {
  it('offers the model a string in place of the file, keeps the server schema on the marker', async () => {
    const conn = connectionWith({}, { tools: [INSPECT_FILE, TOOLS[2]] });
    const [tool, plain] = await conn.listTools();

    expect(tool.id).toBe('excalidraw__inspect_file');
    expect(tool.parameters).toEqual({
      type: 'object',
      properties: {
        doc: { type: 'string', description: expect.stringContaining('File to inspect') },
        verbose: { type: 'boolean' }
      },
      required: ['doc']
    });
    expect(tool.parameters.properties.doc.description).toMatch(/attachment:<n>/);
    expect(tool.description).toBe(
      'Accept a file and return basic file metadata. Attach the file to your message and pass ' +
        'its file name as `doc`.'
    );
    expect(tool._mcp.inputSchema).toBe(INSPECT_FILE.inputSchema);
    expect(tool._mcp.fileInputs).toEqual([{ name: 'doc', array: false, required: true }]);

    // A tool without file inputs is built exactly as before.
    expect(plain.parameters).toBe(TOOLS[2].inputSchema);
    expect(plain._mcp).toEqual({
      serverId: 'excalidraw',
      originalName: 'read_me',
      serverName: 'Excalidraw'
    });
  });
});

describe('McpClientManager.callTool with file inputs', () => {
  async function managerWith(serverOverrides = {}) {
    await mcpClientManager.shutdown();
    await mcpClientManager.initialize({
      servers: [
        {
          id: 'files',
          name: 'Files',
          transport: { type: 'streamableHttp', url: 'https://files.example.com/mcp' },
          ...serverOverrides
        }
      ]
    });
    const conn = mcpClientManager.getConnection('files');
    conn.connected = true;
    conn.client = {
      listTools: jest.fn(async () => ({ tools: [INSPECT_FILE] })),
      callTool: jest.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
      readResource: jest.fn()
    };
    return conn;
  }

  const params = {
    doc: 'report.pdf',
    verbose: true,
    _attachments: ATTACHMENTS,
    user: { id: 'u1', email: 'a@b.c' },
    chatId: 'c1',
    appConfig: { id: 'app' },
    language: 'de'
  };

  it('sends FileData for the reference and never the attachments or the chat context', async () => {
    const conn = await managerWith();
    await mcpClientManager.callTool('files__inspect_file', params);

    expect(conn.client.callTool).toHaveBeenCalledTimes(1);
    const [request] = conn.client.callTool.mock.calls[0];
    expect(request.name).toBe('inspect_file');
    expect(request.arguments).toEqual({
      doc: { fileName: 'report.pdf', mimeType: 'application/pdf', base64: 'JVBERg==', size: 4 },
      verbose: true
    });
    expect(JSON.stringify(request.arguments)).not.toMatch(/_attachments|"user"|chatId|appConfig/);
  });

  it('applies the server limit and reports a missing attachment without calling the server', async () => {
    const conn = await managerWith({ fileInputs: { maxFileSizeMB: 1 } });
    const big = { ...ATTACHMENTS[0], base64: Buffer.alloc(1024 * 1024 + 1).toString('base64') };
    await expect(
      mcpClientManager.callTool('files__inspect_file', { ...params, _attachments: [big] })
    ).rejects.toMatchObject({ code: 'MCP_FILE_TOO_LARGE', serverId: 'files' });

    // A headless caller (gateway, A2A) hands over no attachments.
    await expect(
      mcpClientManager.callTool('files__inspect_file', { doc: 'report.pdf', user: { id: 'u1' } })
    ).rejects.toMatchObject({ code: 'MCP_FILE_NOT_FOUND' });
    expect(conn.client.callTool).not.toHaveBeenCalled();

    await mcpClientManager.shutdown();
    await mcpClientManager.initialize({ servers: [] });
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
