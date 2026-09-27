import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Per-user OAuth for outbound MCP servers — the flow routes, end to end with
 * the MCP SDK's OAuth functions mocked: start (discovery, DCR / CIMD, PKCE,
 * signed state), callback (state checks, user binding, code exchange, token
 * storage), connections listing, disconnect (revocation) and the CIMD document.
 */

const state = {
  platform: { anonymousAuth: { enabled: false }, auth: {} },
  apps: [{ id: 'assistant', tools: ['okta'] }]
};

class FakeUnauthorizedError extends Error {}

const AS_METADATA = {
  issuer: 'https://okta-mcp.example.com/',
  authorization_endpoint: 'https://okta-mcp.example.com/authorize',
  token_endpoint: 'https://okta-mcp.example.com/token',
  registration_endpoint: 'https://okta-mcp.example.com/register',
  revocation_endpoint: 'https://okta-mcp.example.com/revoke',
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256']
};

const sdk = {
  discoverOAuthServerInfo: jest.fn(),
  discoverAuthorizationServerMetadata: jest.fn(),
  discoverOAuthProtectedResourceMetadata: jest.fn(),
  registerClient: jest.fn(),
  startAuthorization: jest.fn(),
  exchangeAuthorization: jest.fn(),
  refreshAuthorization: jest.fn(),
  auth: jest.fn(),
  extractWWWAuthenticateParams: jest.fn(() => ({})),
  selectResourceURL: jest.fn()
};

jest.unstable_mockModule('@modelcontextprotocol/sdk/client/auth.js', () => ({
  ...sdk,
  UnauthorizedError: FakeUnauthorizedError
}));

const safeFetch = jest.fn();
jest.unstable_mockModule('../../services/mcp/safeFetch.js', () => ({
  safeFetch,
  assertSafeHost: jest.fn(async () => {}),
  hostMatchesPattern: () => false,
  isPrivateIp: () => false
}));

jest.unstable_mockModule('../../configCache.js', () => ({
  default: {
    getPlatform: () => state.platform,
    getUI: () => ({ data: { title: { en: 'iHub Apps' } } }),
    getAppsForUser: jest.fn(async () => ({ data: state.apps })),
    getMcpServers: () => ({ data: { servers: [] } }),
    get: () => null
  }
}));

jest.unstable_mockModule('../../middleware/authRequired.js', () => ({
  authRequired: (req, _res, next) => {
    const id = req.headers['x-test-user'];
    req.user = id
      ? { id, groups: ['users'], permissions: {} }
      : { id: 'anonymous', groups: ['anonymous'], permissions: {} };
    next();
  }
}));

const { default: tokenStorage } = await import('../../services/TokenStorageService.js');
const { default: mcpClientManager } = await import('../../services/mcp/McpClientManager.js');
const { McpOAuthClientStore } = await import('../../services/mcp/mcpOAuthClientStore.js');
const { McpToolCatalogStore } = await import('../../services/mcp/mcpToolCatalogStore.js');
const { readUserTokens, writeUserTokens } = await import('../../services/mcp/mcpUserTokens.js');
const { issueMcpOAuthTicket } = await import('../../services/mcp/mcpOAuthTicket.js');
const { validateClientMetadata } = await import('../../utils/clientIdMetadata.js');
const { default: registerMcpOAuthRoutes, withQuery } = await import('../../routes/mcpOAuth.js');

const SERVER = {
  id: 'okta',
  name: 'Okta MCP',
  transport: { type: 'streamableHttp', url: 'https://okta-mcp.example.com/mcp' },
  auth: { type: 'oauthUser', scopes: ['openid', 'profile'] }
};

const app = express();
app.use(express.json());
registerMcpOAuthRoutes(app);

const saved = {};
let tmpDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-mcp-oauth-routes-'));
  saved.key = tokenStorage.encryptionKey;
  saved.base = tokenStorage.storageBasePath;
  saved.jwt = tokenStorage.jwtSecret;
  tokenStorage.encryptionKey = 'c'.repeat(64);
  tokenStorage.storageBasePath = tmpDir;
  tokenStorage.jwtSecret = 'mcp-oauth-routes-secret';
});

afterAll(async () => {
  await mcpClientManager.shutdown();
  tokenStorage.encryptionKey = saved.key;
  tokenStorage.storageBasePath = saved.base;
  tokenStorage.jwtSecret = saved.jwt;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  jest.clearAllMocks();
  state.platform = { anonymousAuth: { enabled: false }, auth: {} };
  state.apps = [{ id: 'assistant', tools: ['okta'] }];
  fs.rmSync(path.join(tmpDir, 'mcp'), { recursive: true, force: true });
  mcpClientManager.clientStore = new McpOAuthClientStore({ documents: null });
  mcpClientManager.catalogStore = new McpToolCatalogStore({ documents: null });
  await mcpClientManager.shutdown();
  await mcpClientManager.initialize({ servers: [SERVER] });

  sdk.discoverOAuthServerInfo.mockResolvedValue({
    authorizationServerUrl: 'https://okta-mcp.example.com/',
    authorizationServerMetadata: AS_METADATA,
    resourceMetadata: undefined
  });
  sdk.registerClient.mockResolvedValue({
    client_id: 'dcr-client',
    redirect_uris: ['http://127.0.0.1/api/mcp/oauth/callback']
  });
  // What the real startAuthorization builds: PKCE S256 + resource indicator.
  sdk.startAuthorization.mockImplementation(async (asUrl, opts) => {
    const url = new URL(opts.metadata.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', opts.clientInformation.client_id);
    url.searchParams.set('code_challenge', 'challenge-of-verifier');
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('redirect_uri', String(opts.redirectUrl));
    if (opts.scope) url.searchParams.set('scope', opts.scope);
    if (opts.resource) url.searchParams.set('resource', opts.resource.href);
    return { authorizationUrl: url, codeVerifier: 'pkce-verifier-123' };
  });
  sdk.exchangeAuthorization.mockResolvedValue({
    access_token: 'access-1',
    token_type: 'bearer',
    expires_in: 3600,
    refresh_token: 'refresh-1',
    scope: 'openid profile'
  });
  // The MCP server itself is unreachable here: the catalog refresh after a
  // sign-in fails quietly. Revocation answers 200.
  safeFetch.mockImplementation(async url => {
    if (String(url).includes('/revoke')) return { ok: true, status: 200 };
    throw new Error('offline in tests');
  });
});

function decodeState(location) {
  const stateParam = new URL(location).searchParams.get('state');
  return {
    stateParam,
    payload: JSON.parse(Buffer.from(stateParam.split('.')[0], 'base64url').toString('utf8'))
  };
}

async function startFlow(user = 'alice', returnUrl = '/chat/abc') {
  const res = await request(app)
    .get('/api/mcp/oauth/authorize')
    .query({ serverId: 'okta', returnUrl })
    .set('x-test-user', user);
  return res;
}

describe('GET /api/mcp/oauth/authorize', () => {
  it('redirects to the authorization server with PKCE, resource and a signed state', async () => {
    const res = await startFlow();
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.origin + location.pathname).toBe('https://okta-mcp.example.com/authorize');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')).toBeTruthy();
    expect(location.searchParams.get('client_id')).toBe('dcr-client');
    expect(location.searchParams.get('resource')).toBe('https://okta-mcp.example.com/mcp');
    expect(location.searchParams.get('scope')).toBe('openid profile');
    expect(location.searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/api\/mcp\/oauth\/callback$/
    );

    const { payload } = decodeState(res.headers.location);
    expect(payload).toMatchObject({ serverId: 'okta', userId: 'alice', returnUrl: '/chat/abc' });
    // The verifier travels encrypted only.
    expect(JSON.stringify(payload)).not.toContain('pkce-verifier-123');
    expect(payload.cv).toMatch(/^ENC\[/);

    // Discovery and DCR ran through the SSRF-guarded fetch.
    expect(sdk.discoverOAuthServerInfo).toHaveBeenCalledWith('https://okta-mcp.example.com/mcp', {
      fetchFn: expect.any(Function)
    });
    expect(sdk.registerClient).toHaveBeenCalledWith(
      'https://okta-mcp.example.com/',
      expect.objectContaining({
        fetchFn: expect.any(Function),
        clientMetadata: expect.objectContaining({ token_endpoint_auth_method: 'none' })
      })
    );
  });

  it('reuses the registration for the next user', async () => {
    // A stable public URL: supertest listens on a new port per request, and a
    // changed redirect URI rightly means a new registration.
    state.platform = { ...state.platform, mcpServer: { publicUrl: 'http://ihub.test' } };
    await startFlow('alice');
    await startFlow('bob');
    expect(sdk.registerClient).toHaveBeenCalledTimes(1);
  });

  it('uses the CIMD URL as client id when the AS supports it and the base is https', async () => {
    state.platform = { ...state.platform, mcpServer: { publicUrl: 'https://ihub.example.com' } };
    sdk.discoverOAuthServerInfo.mockResolvedValue({
      authorizationServerUrl: 'https://okta-mcp.example.com/',
      authorizationServerMetadata: { ...AS_METADATA, client_id_metadata_document_supported: true }
    });
    const res = await startFlow();
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.searchParams.get('client_id')).toBe(
      'https://ihub.example.com/api/mcp/oauth/client-metadata.json'
    );
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://ihub.example.com/api/mcp/oauth/callback'
    );
    expect(sdk.registerClient).not.toHaveBeenCalled();
  });

  it('replaces an off-site returnUrl with the settings page', async () => {
    const res = await startFlow('alice', 'https://evil.example.com/steal');
    expect(res.status).toBe(302);
    expect(decodeState(res.headers.location).payload.returnUrl).toBe('/settings/integrations');
  });

  it('refuses anonymous callers', async () => {
    const res = await request(app).get('/api/mcp/oauth/authorize').query({ serverId: 'okta' });
    expect(res.status).toBe(401);
  });

  it('answers an unknown or invisible server with server_not_found', async () => {
    const unknown = await request(app)
      .get('/api/mcp/oauth/authorize')
      .query({ serverId: 'nope', returnUrl: '/chat/abc' })
      .set('x-test-user', 'alice');
    expect(unknown.headers.location).toBe('/chat/abc?mcp_error=server_not_found&mcp_server=nope');

    state.apps = [];
    const hidden = await startFlow();
    expect(hidden.headers.location).toBe('/chat/abc?mcp_error=server_not_found&mcp_server=okta');
    expect(sdk.discoverOAuthServerInfo).not.toHaveBeenCalled();
  });

  it('reports discovery and registration failures with stable codes', async () => {
    sdk.discoverOAuthServerInfo.mockRejectedValueOnce(new Error('boom <script>'));
    const discovery = await startFlow();
    expect(discovery.headers.location).toBe('/chat/abc?mcp_error=discovery_failed&mcp_server=okta');
    sdk.registerClient.mockRejectedValueOnce(new Error('registration refused'));
    const registration = await startFlow();
    expect(registration.headers.location).toBe(
      '/chat/abc?mcp_error=registration_failed&mcp_server=okta'
    );
  });
});

describe('GET /api/mcp/oauth/callback', () => {
  async function callback(query, user = 'alice') {
    return request(app).get('/api/mcp/oauth/callback').query(query).set('x-test-user', user);
  }

  it('exchanges the code with the verifier, stores the tokens and returns', async () => {
    const { stateParam } = decodeState((await startFlow()).headers.location);
    const res = await callback({ code: 'auth-code-1', state: stateParam });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/chat/abc?mcp_connected=okta');
    expect(sdk.exchangeAuthorization).toHaveBeenCalledWith(
      'https://okta-mcp.example.com/',
      expect.objectContaining({
        authorizationCode: 'auth-code-1',
        codeVerifier: 'pkce-verifier-123',
        clientInformation: { client_id: 'dcr-client' },
        redirectUri: expect.stringMatching(/\/api\/mcp\/oauth\/callback$/),
        resource: new URL('https://okta-mcp.example.com/mcp'),
        fetchFn: expect.any(Function)
      })
    );
    expect(await readUserTokens('alice', 'okta')).toMatchObject({
      access_token: 'access-1',
      refresh_token: 'refresh-1'
    });
    expect(await readUserTokens('bob', 'okta')).toBeNull();
  });

  it('refuses a ticket started by another user', async () => {
    const { stateParam } = decodeState((await startFlow('alice')).headers.location);
    const res = await callback({ code: 'c', state: stateParam }, 'mallory');
    expect(res.headers.location).toBe('/chat/abc?mcp_error=user_mismatch&mcp_server=okta');
    expect(sdk.exchangeAuthorization).not.toHaveBeenCalled();
    expect(await readUserTokens('mallory', 'okta')).toBeNull();
  });

  it('refuses invalid, tampered and expired state', async () => {
    const invalid = await callback({ code: 'c', state: 'not-a-ticket' });
    expect(invalid.headers.location).toBe('/settings/integrations?mcp_error=invalid_state');

    const { stateParam } = decodeState((await startFlow()).headers.location);
    const [payload, signature] = stateParam.split('.');
    const forged = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    forged.returnUrl = 'https://evil.example.com/';
    const tampered = await callback({
      code: 'c',
      state: `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signature}`
    });
    expect(tampered.headers.location).toBe('/settings/integrations?mcp_error=invalid_state');

    const expired = issueMcpOAuthTicket({
      serverId: 'okta',
      userId: 'alice',
      returnUrl: '/chat/abc',
      codeVerifier: 'v',
      redirectUri: 'http://127.0.0.1/api/mcp/oauth/callback',
      now: Date.now() - 16 * 60 * 1000
    });
    const late = await callback({ code: 'c', state: expired });
    expect(late.headers.location).toBe('/settings/integrations?mcp_error=state_expired');
    expect(sdk.exchangeAuthorization).not.toHaveBeenCalled();
  });

  it('turns an AS error into oauth_failed without echoing its text', async () => {
    const { stateParam } = decodeState((await startFlow()).headers.location);
    const res = await callback({
      error: 'access_denied',
      error_description: 'The user said <b>no</b>',
      state: stateParam
    });
    expect(res.headers.location).toBe('/chat/abc?mcp_error=oauth_failed&mcp_server=okta');
    expect(res.headers.location).not.toContain('access_denied');
  });

  it('reports a missing code and a failed exchange', async () => {
    const { stateParam } = decodeState((await startFlow()).headers.location);
    const missing = await callback({ state: stateParam });
    expect(missing.headers.location).toBe('/chat/abc?mcp_error=missing_code&mcp_server=okta');

    sdk.exchangeAuthorization.mockRejectedValueOnce(new Error('invalid_grant'));
    const failed = await callback({ code: 'c', state: stateParam });
    expect(failed.headers.location).toBe('/chat/abc?mcp_error=exchange_failed&mcp_server=okta');
    expect(await readUserTokens('alice', 'okta')).toBeNull();
  });
});

describe('connections and disconnect', () => {
  it('lists the per-user servers with their connection state', async () => {
    await writeUserTokens('alice', 'okta', {
      access_token: 'a',
      token_type: 'bearer',
      expires_in: 3600,
      scope: 'openid'
    });
    const alice = await request(app).get('/api/mcp/oauth/connections').set('x-test-user', 'alice');
    expect(alice.status).toBe(200);
    expect(alice.body.servers).toEqual([
      expect.objectContaining({
        serverId: 'okta',
        name: 'Okta MCP',
        connected: true,
        scope: 'openid',
        connectUrl: '/api/mcp/oauth/authorize?serverId=okta'
      })
    ]);
    const bob = await request(app).get('/api/mcp/oauth/connections').set('x-test-user', 'bob');
    expect(bob.body.servers[0]).toMatchObject({ serverId: 'okta', connected: false });

    state.apps = [];
    const hidden = await request(app).get('/api/mcp/oauth/connections').set('x-test-user', 'bob');
    expect(hidden.body.servers).toEqual([]);
  });

  it('revokes at the authorization server and deletes the tokens', async () => {
    const { stateParam } = decodeState((await startFlow()).headers.location);
    await request(app)
      .get('/api/mcp/oauth/callback')
      .query({ code: 'c', state: stateParam })
      .set('x-test-user', 'alice');
    expect(await readUserTokens('alice', 'okta')).not.toBeNull();

    const res = await request(app)
      .post('/api/mcp/oauth/disconnect')
      .set('x-test-user', 'alice')
      .send({ serverId: 'okta' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, removed: true, revoked: true });
    const revocations = safeFetch.mock.calls.filter(([url]) => String(url).includes('/revoke'));
    expect(revocations).toHaveLength(2);
    const bodies = revocations.map(([, init]) => new URLSearchParams(init.body));
    expect(bodies.map(b => b.get('token_type_hint')).sort()).toEqual([
      'access_token',
      'refresh_token'
    ]);
    expect(bodies.every(b => b.get('client_id') === 'dcr-client')).toBe(true);
    expect(await readUserTokens('alice', 'okta')).toBeNull();
  });

  it('refuses an invalid or unknown server id', async () => {
    const bad = await request(app)
      .post('/api/mcp/oauth/disconnect')
      .set('x-test-user', 'alice')
      .send({ serverId: '../etc' });
    expect(bad.status).toBe(400);
    const unknown = await request(app)
      .post('/api/mcp/oauth/disconnect')
      .set('x-test-user', 'alice')
      .send({ serverId: 'nope' });
    expect(unknown.status).toBe(404);
  });
});

describe('GET /api/mcp/oauth/client-metadata.json', () => {
  it("serves a document iHub's own CIMD validator accepts", async () => {
    state.platform = { ...state.platform, mcpServer: { publicUrl: 'https://ihub.example.com/' } };
    const res = await request(app).get('/api/mcp/oauth/client-metadata.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(res.body.client_id).toBe('https://ihub.example.com/api/mcp/oauth/client-metadata.json');
    expect(res.body.token_endpoint_auth_method).toBe('none');
    expect(validateClientMetadata(res.body, res.body.client_id).ok).toBe(true);
  });
});

describe('withQuery', () => {
  it('appends parameters and keeps the path, query and fragment', () => {
    expect(withQuery('/chat/1', { a: 'b' })).toBe('/chat/1?a=b');
    expect(withQuery('/chat/1?x=1#top', { a: 'b' })).toBe('/chat/1?x=1&a=b#top');
    // A same-host absolute URL becomes a path on this origin.
    expect(withQuery('https://ihub.example.com/c', { a: 'b c' })).toBe('/c?a=b+c');
  });

  it('never produces a redirect that leaves this origin', () => {
    for (const hostile of ['/\\evil.example', '//evil.example/x', '/\\/evil.example', '\\evil']) {
      const out = withQuery(hostile, { a: 'b' });
      expect(out.startsWith('/')).toBe(true);
      expect(out.startsWith('//')).toBe(false);
      expect(out.startsWith('/\\')).toBe(false);
      expect(new URL(out, 'https://ihub.example.com').host).toBe('ihub.example.com');
    }
  });
});
