// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect } from '@jest/globals';
import mcpClientManager from '../../services/mcp/McpClientManager.js';
import { buildAuthRequiredResult } from '../../services/mcp/mcpOAuthService.js';
import { isAuthRequiredError } from '../../services/mcp/McpUserOAuthProvider.js';

/**
 * Scope step-up on a per-user MCP server: a call refused with
 * `403 insufficient_scope` asks the user to re-authorize once with the union
 * of the granted and the challenged scopes; a refusal after that is final.
 */

const SERVER = {
  id: 'okta',
  name: 'Okta MCP',
  transport: { type: 'streamableHttp', url: 'https://okta-mcp.example.com/mcp' },
  auth: { type: 'oauthUser' }
};

const challenged = header => ({ authProvider: { scopeChallenge: header } });

describe('scope step-up on a per-user MCP server', () => {
  it('turns insufficient_scope into a re-authorization with the union of scopes', () => {
    const conn = challenged('Bearer error="insufficient_scope", scope="tickets:write"');
    const error = mcpClientManager._stepUpError(SERVER, conn, { scope: 'openid tickets:read' });
    expect(isAuthRequiredError(error)).toBe(true);
    expect(error.reason).toBe('insufficient_scope');
    expect(error.scopes).toEqual(['openid', 'tickets:read', 'tickets:write']);
    expect(conn.authProvider.scopeChallenge).toBeNull();

    const result = buildAuthRequiredResult(SERVER, 'en', {
      reason: error.reason,
      scopes: error.scopes
    });
    expect(result).toMatchObject({
      error: 'INTEGRATION_AUTH_REQUIRED',
      integration: 'okta',
      reason: 'insufficient_scope'
    });
    expect(result.connectUrl).toBe(
      '/api/mcp/oauth/authorize?serverId=okta&scope=openid%20tickets%3Aread%20tickets%3Awrite'
    );
    expect(result.authRequired.connectUrl).toBe(result.connectUrl);
  });

  it('re-authorizes once: a refusal for scopes already granted is final', () => {
    const conn = challenged('Bearer error="insufficient_scope", scope="tickets:write"');
    const error = mcpClientManager._stepUpError(SERVER, conn, {
      scope: 'openid tickets:read tickets:write'
    });
    expect(isAuthRequiredError(error)).toBe(false);
    expect(error.message).toMatch(/insufficient_scope/);
  });

  it('leaves other refusals alone (a 401 is answered with a refresh)', () => {
    expect(mcpClientManager._stepUpError(SERVER, { authProvider: {} }, {})).toBeNull();
    expect(mcpClientManager._stepUpError(SERVER, {}, {})).toBeNull();
  });
});
