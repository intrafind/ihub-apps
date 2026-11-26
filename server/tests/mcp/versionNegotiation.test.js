// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect } from '@jest/globals';
import { versionNegotiationFor } from '../../services/mcp/McpServerConnection.js';

/**
 * Which protocol revision an outbound MCP connection negotiates: Streamable
 * HTTP probes for 2026-07-28 and falls back to the 2025 handshake; the other
 * transports keep the 2025 handshake (a stdio probe would spawn a second copy
 * of the server process).
 */
describe('versionNegotiationFor', () => {
  it('probes for 2026-07-28 over Streamable HTTP', () => {
    expect(versionNegotiationFor({ type: 'streamableHttp' })).toEqual({ mode: 'auto' });
  });

  it.each(['stdio', 'sse', 'websocket', undefined])('keeps the 2025 handshake for %s', type => {
    expect(versionNegotiationFor(type ? { type } : undefined)).toEqual({ mode: 'legacy' });
  });
});
