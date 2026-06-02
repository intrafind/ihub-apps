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
