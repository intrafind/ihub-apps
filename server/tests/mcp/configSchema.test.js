import { describe, it, expect } from '@jest/globals';
import {
  mcpServerConfigSchema,
  mcpServersFileSchema,
  mcpGatewayConfigSchema
} from '../../validators/mcpServerConfigSchema.js';

describe('mcpServerConfigSchema', () => {
  it('accepts a minimal streamableHttp server', () => {
    const result = mcpServerConfigSchema.safeParse({
      id: 'github-mcp',
      name: 'GitHub',
      transport: { type: 'streamableHttp', url: 'https://mcp.example.com/sse' }
    });
    expect(result.success).toBe(true);
    expect(result.data.allowedTools).toEqual(['*']);
    expect(result.data.timeoutMs).toBe(30000);
    expect(result.data.reconnect.maxRetries).toBe(5);
  });

  it('accepts a stdio server with command + args', () => {
    const result = mcpServerConfigSchema.safeParse({
      id: 'local-mcp',
      name: { en: 'Local' },
      transport: { type: 'stdio', command: '/usr/local/bin/srv', args: ['--port', '0'] }
    });
    expect(result.success).toBe(true);
    expect(result.data.transport.args).toEqual(['--port', '0']);
  });

  it('rejects an id with spaces or path-traversal characters', () => {
    expect(
      mcpServerConfigSchema.safeParse({
        id: 'bad id',
        name: 'x',
        transport: { type: 'streamableHttp', url: 'https://x.example' }
      }).success
    ).toBe(false);
    expect(
      mcpServerConfigSchema.safeParse({
        id: '../escape',
        name: 'x',
        transport: { type: 'streamableHttp', url: 'https://x.example' }
      }).success
    ).toBe(false);
  });

  it('rejects an unknown transport type', () => {
    const result = mcpServerConfigSchema.safeParse({
      id: 'x',
      name: 'x',
      transport: { type: 'gopher', url: 'https://x.example' }
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-URL streamableHttp url', () => {
    const result = mcpServerConfigSchema.safeParse({
      id: 'x',
      name: 'x',
      transport: { type: 'streamableHttp', url: 'not-a-url' }
    });
    expect(result.success).toBe(false);
  });
});

describe('mcpServerConfigSchema header auth', () => {
  const withAuth = auth => ({
    id: 'maps',
    name: 'Maps',
    transport: { type: 'streamableHttp', url: 'https://mcp.example.com/mcp' },
    auth
  });

  it('accepts an API key in a vendor header', () => {
    const result = mcpServerConfigSchema.safeParse(
      withAuth({ type: 'header', headerName: 'X-Goog-Api-Key', valueRef: 'maps-key' })
    );
    expect(result.success).toBe(true);
    expect(result.data.auth).toEqual({
      type: 'header',
      headerName: 'X-Goog-Api-Key',
      valueRef: 'maps-key'
    });
  });

  it('accepts a literal value prefix', () => {
    const result = mcpServerConfigSchema.safeParse(
      withAuth({
        type: 'header',
        headerName: 'Authorization',
        valuePrefix: 'Token token=',
        valueRef: 'pd-key'
      })
    );
    expect(result.success).toBe(true);
    expect(result.data.auth.valuePrefix).toBe('Token token=');
  });

  it('requires a credential reference', () => {
    expect(
      mcpServerConfigSchema.safeParse(withAuth({ type: 'header', headerName: 'X-Api-Key' })).success
    ).toBe(false);
  });

  it('rejects header names that are not HTTP tokens', () => {
    for (const headerName of ['X Api Key', 'X-Api-Key:', 'X-Api-Key\r\nHost: evil', '']) {
      expect(
        mcpServerConfigSchema.safeParse(withAuth({ type: 'header', headerName, valueRef: 'k' }))
          .success
      ).toBe(false);
    }
  });

  it('rejects headers the transport owns, in any case', () => {
    for (const headerName of ['Host', 'content-type', 'Mcp-Session-Id', 'MCP-PROTOCOL-VERSION']) {
      expect(
        mcpServerConfigSchema.safeParse(withAuth({ type: 'header', headerName, valueRef: 'k' }))
          .success
      ).toBe(false);
    }
  });

  it('rejects a value prefix with line breaks', () => {
    const result = mcpServerConfigSchema.safeParse(
      withAuth({
        type: 'header',
        headerName: 'X-Api-Key',
        valuePrefix: 'a\r\nHost: evil',
        valueRef: 'k'
      })
    );
    expect(result.success).toBe(false);
  });
});

describe('mcpServerConfigSchema static headers', () => {
  const withHeaders = headers => ({
    id: 'close',
    name: 'Close',
    transport: { type: 'streamableHttp', url: 'https://mcp.example.com/mcp', headers }
  });

  it('accepts non-secret headers on HTTP transports', () => {
    const result = mcpServerConfigSchema.safeParse(withHeaders({ 'Close-Scope': 'mcp.read' }));
    expect(result.success).toBe(true);
    expect(result.data.transport.headers).toEqual({ 'Close-Scope': 'mcp.read' });
  });

  it('keeps credentials out of static headers', () => {
    expect(
      mcpServerConfigSchema.safeParse(withHeaders({ authorization: 'Bearer leaked' })).success
    ).toBe(false);
  });

  it('rejects reserved names and values with line breaks', () => {
    expect(mcpServerConfigSchema.safeParse(withHeaders({ Host: 'evil' })).success).toBe(false);
    expect(
      mcpServerConfigSchema.safeParse(withHeaders({ 'X-Scope': 'a\r\nHost: evil' })).success
    ).toBe(false);
  });
});

describe('mcpServersFileSchema', () => {
  it('seeds defaults for security block', () => {
    const result = mcpServersFileSchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data.servers).toEqual([]);
    expect(result.data.security.blockPrivateIps).toBe(true);
    expect(result.data.security.allowedHosts).toEqual([]);
  });
});

describe('mcpGatewayConfigSchema', () => {
  it('defaults to disabled with stream + sse transports enabled and resources off', () => {
    const result = mcpGatewayConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data.enabled).toBe(false);
    expect(result.data.transports.streamableHttp.enabled).toBe(true);
    expect(result.data.transports.sse.enabled).toBe(true);
    expect(result.data.expose.resources).toBe(false);
  });
});
