// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `GET /api/mcp/oauth/callback/:serverId` is reached by browsers returning from
 * a sign-in, signed in or not, and exchanges the code at the authorization
 * server. It sits outside `/api/integrations`, so it carries the public API
 * limiter itself, counted per address for an anonymous caller.
 *
 * Run with `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const platform = { rateLimit: { publicApi: { limit: 2, windowMs: 60000 } } };
const handled = jest.fn();

jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: () => platform }
}));
jest.unstable_mockModule('../services/mcp/McpClientManager.js', () => ({
  default: { getConnection: () => null }
}));
jest.unstable_mockModule('../services/mcp/mcpOAuthService.js', () => ({
  isUserOAuthServer: () => false
}));
jest.unstable_mockModule('../services/mcp/mcpOAuthPublicUrl.js', () => ({
  buildMcpClientMetadata: () => ({}),
  resolveMcpPublicBaseInfo: () => ({ publicBase: null, configured: false }),
  MCP_OAUTH_CALLBACK_PATH: '/api/mcp/oauth/callback',
  MCP_OAUTH_CLIENT_METADATA_PATH: '/api/mcp/oauth/client-metadata'
}));
jest.unstable_mockModule('../middleware/authRequired.js', () => ({
  authOptional: (_req, _res, next) => next()
}));
jest.unstable_mockModule('../routes/integrations/oauthCallback.js', () => ({
  integrationOAuthCallbackHandler: () => (req, res) => {
    handled(req.params.serverId);
    res.status(204).end();
  }
}));
jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const { default: registerMcpOAuthRoutes } = await import('../routes/mcpOAuth.js');
const { default: errorHandler } = await import('../middleware/errorHandler.js');

const app = express();
registerMcpOAuthRoutes(app);
app.use(errorHandler);

describe('MCP OAuth callback rate limit', () => {
  it('answers requests within the budget and then refuses with 429', async () => {
    const callback = () => request(app).get('/api/mcp/oauth/callback/okta?code=x&state=y');
    expect((await callback()).status).toBe(204);
    expect((await callback()).status).toBe(204);
    const blocked = await callback();
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    expect(handled).toHaveBeenCalledTimes(2);
  });
});
