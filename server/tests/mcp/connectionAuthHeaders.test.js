import { describe, it, expect } from '@jest/globals';
import { McpServerConnection } from '../../services/mcp/McpServerConnection.js';

// _buildAuthHeaders receives the auth block after _resolveAuth has inlined the
// secret, so these cases pass plaintext fields directly.
describe('McpServerConnection auth headers', () => {
  const conn = new McpServerConnection({
    id: 'x',
    transport: { type: 'streamableHttp', url: 'https://mcp.example.com/mcp' }
  });

  it('sends no header without auth', () => {
    expect(conn._buildAuthHeaders({ type: 'none' })).toEqual({});
  });

  it('sends a bearer token', () => {
    expect(conn._buildAuthHeaders({ type: 'bearer', token: 't0k' })).toEqual({
      Authorization: 'Bearer t0k'
    });
  });

  it('sends an API key in the configured header', () => {
    expect(
      conn._buildAuthHeaders({ type: 'header', headerName: 'X-Goog-Api-Key', value: 'k3y' })
    ).toEqual({ 'X-Goog-Api-Key': 'k3y' });
  });

  it('puts the value prefix in front of the key', () => {
    expect(
      conn._buildAuthHeaders({
        type: 'header',
        headerName: 'Authorization',
        valuePrefix: 'Token token=',
        value: 'k3y'
      })
    ).toEqual({ Authorization: 'Token token=k3y' });
  });
});
