import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// What goes on the wire: the headers safeFetch receives, normalised the way
// fetch does it (case-insensitive names, duplicate names joined with ", ").
const sent = [];

jest.unstable_mockModule('../../services/mcp/safeFetch.js', () => ({
  assertSafeHost: jest.fn(async () => {}),
  safeFetch: jest.fn(async (url, init) => {
    sent.push(Object.fromEntries(new Headers(init.headers)));
    return new Response(null, { status: 202 });
  })
}));

jest.unstable_mockModule('../../services/CredentialService.js', () => ({
  default: { resolveSecret: ref => `secret-of-${ref}` }
}));

const { McpServerConnection } = await import('../../services/mcp/McpServerConnection.js');
const { mcpServerConfigSchema } = await import('../../validators/mcpServerConfigSchema.js');

async function sendThrough(serverConfig) {
  const config = mcpServerConfigSchema.parse({ id: 'x', name: 'x', ...serverConfig });
  const conn = new McpServerConnection(config, { blockPrivateIps: true, allowedHosts: [] });
  const transport = await conn._buildTransport();
  await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return sent.at(-1);
}

describe('McpServerConnection request headers', () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it('keeps the protocol headers the SDK sets', async () => {
    const headers = await sendThrough({
      transport: { type: 'streamableHttp', url: 'https://mcp.example.com/mcp' }
    });
    expect(headers['content-type']).toBe('application/json');
    expect(headers.accept).toBe('application/json, text/event-stream');
  });

  it('sends a bearer token once, not joined with a second copy', async () => {
    const headers = await sendThrough({
      transport: { type: 'streamableHttp', url: 'https://mcp.example.com/mcp' },
      auth: { type: 'bearer', tokenRef: 'gh' }
    });
    expect(headers.authorization).toBe('Bearer secret-of-gh');
  });

  it('sends a vendor header with its prefix, plus static headers', async () => {
    const headers = await sendThrough({
      transport: {
        type: 'streamableHttp',
        url: 'https://mcp.example.com/mcp',
        headers: { 'Close-Scope': 'mcp.read' }
      },
      auth: {
        type: 'header',
        headerName: 'Authorization',
        valuePrefix: 'Sentry-Bearer ',
        valueRef: 's'
      }
    });
    expect(headers.authorization).toBe('Sentry-Bearer secret-of-s');
    expect(headers['close-scope']).toBe('mcp.read');
  });
});
