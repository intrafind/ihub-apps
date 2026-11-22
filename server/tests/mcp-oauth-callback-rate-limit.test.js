// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `GET /api/mcp/oauth/callback/:serverId` is reached by browsers returning from
 * a sign-in, signed in or not, and exchanges the code at the authorization
 * server. `GET /api/mcp/oauth/client-metadata/:serverId` is fetched by authorization
 * servers with no credentials. Both sit outside `/api/integrations`, so each carries
 * the public API limiter itself, counted per address for an anonymous caller.
 *
 * Run with `NODE_OPTIONS=--experimental-vm-modules`.
 */
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const platform = { rateLimit: { publicApi: { limit: 2, windowMs: 60000 } } };
const handled = jest.fn();
// The connection `GET .../client-metadata/:serverId` finds; null answers 404 for every server.
const state = { connection: null };

jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: () => platform }
}));
jest.unstable_mockModule('../services/mcp/McpClientManager.js', () => ({
  default: { getConnection: () => state.connection }
}));
jest.unstable_mockModule('../services/mcp/mcpOAuthService.js', () => ({
  isUserOAuthServer: () => true
}));
jest.unstable_mockModule('../services/mcp/mcpOAuthPublicUrl.js', () => ({
  buildMcpClientMetadata: () => ({ client_id: 'https://ihub.example/okta' }),
  resolveMcpPublicBaseInfo: () => ({ publicBase: 'https://ihub.example', configured: true }),
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

// A fresh app per test: each registration builds its own limiter and counter.
function buildApp() {
  const app = express();
  registerMcpOAuthRoutes(app);
  app.use(errorHandler);
  return app;
}

describe('MCP OAuth rate limits', () => {
  beforeEach(() => {
    handled.mockClear();
    state.connection = null;
  });

  it('limits the client metadata document, which has no credentials either', async () => {
    state.connection = { config: { id: 'okta', enabled: true } };
    const app = buildApp();
    const metadata = () => request(app).get('/api/mcp/oauth/client-metadata/okta');
    expect((await metadata()).status).toBe(200);
    expect((await metadata()).status).toBe(200);
    const blocked = await metadata();
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
  });

  it('counts both anonymous routes against one budget per address', async () => {
    state.connection = { config: { id: 'okta', enabled: true } };
    const app = buildApp();
    const metadata = () => request(app).get('/api/mcp/oauth/client-metadata/okta');
    const callback = () => request(app).get('/api/mcp/oauth/callback/okta?code=x&state=y');
    expect((await metadata()).status).toBe(200);
    expect((await callback()).status).toBe(204);
    // The budget is two: one request on each route used it up.
    expect((await metadata()).status).toBe(429);
    expect((await callback()).status).toBe(429);
  });

  it('answers callback requests within the budget and then refuses with 429', async () => {
    const app = buildApp();
    const callback = () => request(app).get('/api/mcp/oauth/callback/okta?code=x&state=y');
    expect((await callback()).status).toBe(204);
    expect((await callback()).status).toBe(204);
    const blocked = await callback();
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    expect(handled).toHaveBeenCalledTimes(2);
  });
});
