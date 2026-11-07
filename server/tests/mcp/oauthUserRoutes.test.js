// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import errorHandler from '../../middleware/errorHandler.js';
import { scratchDocuments } from '../helpers/testStorage.js';

const scratch = await scratchDocuments();

/**
 * Per-user OAuth for outbound MCP servers — the one connect flow of every
 * integration (`POST /api/integrations/:id/connect|disconnect`,
 * `GET /api/integrations`) and the MCP callback alias, end to end with the MCP
 * SDK's OAuth functions mocked: start (discovery, DCR / CIMD, PKCE,
 * server-side state), callback (state checks, user binding, code exchange,
 * token storage), the listing, disconnect (revocation) and the CIMD document
 * — plus the review fixes: per-server callbacks and the RFC 9207 issuer check
 * against an OAuth mix-up between two authorization servers, a forged Host
 * that must not replace the shared registration, and OAuth requests that
 * refuse redirects.
 */

/** The installations the per-user servers come from (`config/integrations.json`). */
function installationsOf(ids, extra = {}) {
  return {
    installed: ids.map(id => ({
      id,
      definition: 'com.intrafind/mcp-server',
      // Up to date with the loaded definition (else the listing withholds it).
      definitionVersion: '1.0.0',
      values: { url: `https://${id}-mcp.example.com/mcp` },
      auth: { mode: 'oauth-user' },
      ...extra
    }))
  };
}

function oktaInstallation(extra = {}) {
  return installationsOf(['okta'], extra);
}

/** Every group may use every integration (`permissions.integrations`, #3093). */
const OPEN_GROUPS = {
  users: { id: 'users', permissions: { integrations: ['*'] } },
  admins: { id: 'admins', permissions: { integrations: ['*'], adminAccess: true } }
};

const state = {
  platform: { anonymousAuth: { enabled: false }, auth: {} },
  apps: [{ id: 'assistant', integrations: { okta: {} } }],
  integrations: oktaInstallation(),
  groups: OPEN_GROUPS
};

class FakeUnauthorizedError extends Error {}

/** What a token endpoint answers: `(url, params) => {status, body}`. */
const tokenAnswer = jest.fn();

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

// The per-IP limit of the start route is not what these tests exercise.
jest.unstable_mockModule('express-rate-limit', () => ({
  default: () => (_req, _res, next) => next()
}));

const safeFetch = jest.fn();
jest.unstable_mockModule('../../services/mcp/safeFetch.js', () => ({
  safeFetch,
  assertSafeHost: jest.fn(async () => {}),
  hostMatchesPattern: () => false
}));

jest.unstable_mockModule('../../configCache.js', () => ({
  default: {
    getPlatform: () => state.platform,
    getUI: () => ({ data: { title: { en: 'iHub Apps' } } }),
    getAppsForUser: jest.fn(async () => ({ data: state.apps })),
    getIntegrations: () => ({ data: state.integrations }),
    getGroups: () => ({ data: { groups: state.groups } }),
    getFeatures: () => ({ integrations: true }),
    get: key => (key === 'config/integrations.json' ? { data: state.integrations } : null)
  }
}));

function testUser(req, _res, next) {
  const id = req.headers['x-test-user'];
  const admin = Boolean(req.headers['x-test-admin']);
  const groups = admin ? ['admins'] : ['users'];
  // What the request pipeline resolves for these groups (enhanceUserWithPermissions).
  req.user = id
    ? { id, groups, isAdmin: admin, isContentAdmin: admin, permissions: {} }
    : { id: 'anonymous', groups: ['anonymous'], permissions: {} };
  next();
}

jest.unstable_mockModule('../../middleware/authRequired.js', () => ({
  authRequired: testUser,
  authOptional: testUser
}));

const { default: tokenStorage } = await import('../../services/TokenStorageService.js');
const { default: mcpClientManager } = await import('../../services/mcp/McpClientManager.js');
const { McpOAuthClientStore } = await import('../../services/mcp/mcpOAuthClientStore.js');
const { McpToolCatalogStore } = await import('../../services/mcp/mcpToolCatalogStore.js');
const { readUserTokens, writeUserTokens, tokenBindingFor } =
  await import('../../services/mcp/mcpUserTokens.js');
const { buildMcpOAuthFetch } = await import('../../services/mcp/McpUserOAuthProvider.js');
const { validateClientMetadata } = await import('../../utils/clientIdMetadata.js');
const { default: registerMcpOAuthRoutes } = await import('../../routes/mcpOAuth.js');
const { default: userIntegrationRoutes } =
  await import('../../routes/integrations/userIntegrations.js');
const { returnPathWith, IntegrationConnectionService, setIntegrationConnectionServiceForTests } =
  await import('../../services/integrations/auth/IntegrationConnectionService.js');
const { OAUTH_FLOWS_NAMESPACE, OAuthFlowStore, setOAuthFlowStoreForTests } =
  await import('../../services/integrations/auth/oauthFlowStore.js');
const { default: cryptoModule } = await import('node:crypto');

const SERVER = {
  id: 'okta',
  name: 'Okta MCP',
  transport: { type: 'streamableHttp', url: 'https://okta-mcp.example.com/mcp' },
  auth: { type: 'oauthUser', scopes: ['openid', 'profile'] }
};

/** The routes under test: the MCP callback and CIMD, and the one connect flow. */
function mountRoutes(target) {
  target.use(express.json());
  // The global authentication of the real server sets `req.user` before any
  // router (the anonymous principal when nobody signed in); the routes rely
  // on it before their own `authRequired`.
  target.use(testUser);
  registerMcpOAuthRoutes(target);
  target.use('/api/integrations', userIntegrationRoutes);
  target.use(errorHandler);
  return target;
}

const app = mountRoutes(express());

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
  // Every case starts without the previous case's registration, flows and
  // connections: they live in the shared scratch store.
  await scratch.reset();
  const flowStore = new OAuthFlowStore({ documents: scratch.documents });
  setOAuthFlowStoreForTests(flowStore);
  setIntegrationConnectionServiceForTests(
    new IntegrationConnectionService({ documents: scratch.documents, flowStore })
  );
  state.platform = { anonymousAuth: { enabled: false }, auth: {} };
  state.apps = [{ id: 'assistant', integrations: { okta: {} } }];
  state.integrations = oktaInstallation();
  state.groups = OPEN_GROUPS;
  fs.rmSync(path.join(tmpDir, 'mcp'), { recursive: true, force: true });
  mcpClientManager.clientStore = new McpOAuthClientStore({ documents: scratch.documents });
  mcpClientManager.catalogStore = new McpToolCatalogStore({ documents: scratch.documents });
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
  // The token endpoints answer through the SSRF-guarded fetch (the shared
  // OAuth client sends every token request through the strategy's fetch).
  tokenAnswer.mockImplementation(() => ({
    status: 200,
    body: {
      access_token: 'access-1',
      token_type: 'bearer',
      expires_in: 3600,
      refresh_token: 'refresh-1',
      scope: 'openid profile'
    }
  }));
  // The MCP server itself is unreachable here: the catalog refresh after a
  // sign-in fails quietly. Revocation answers 200.
  safeFetch.mockImplementation(async (url, init = {}) => {
    if (String(url).includes('/revoke')) return { ok: true, status: 200 };
    if (String(url).endsWith('/token')) {
      const { status, body } = tokenAnswer(String(url), new URLSearchParams(String(init.body)));
      return {
        ok: status < 400,
        status,
        headers: new Map(),
        json: async () => body,
        text: async () => JSON.stringify(body)
      };
    }
    throw new Error('offline in tests');
  });
});

/** The token requests the shared OAuth client sent: `[url, params]`. */
function tokenRequests() {
  return tokenAnswer.mock.calls;
}

/**
 * The `state` of an authorization redirect and the server-side flow it names
 * (the flow store runs memory-only here; it is keyed by a hash of the state).
 */
function decodeState(location) {
  const url = new URL(location);
  const stateParam = url.searchParams.get('state');
  const key = `flow_${cryptoModule.createHash('sha256').update(stateParam, 'utf8').digest('hex').slice(0, 48)}`;
  return {
    stateParam,
    challenge: url.searchParams.get('code_challenge'),
    key
  };
}

/** Whether a verifier is the one behind a PKCE S256 challenge. */
function matchesChallenge(verifier, challenge) {
  return cryptoModule.createHash('sha256').update(verifier).digest('base64url') === challenge;
}

/**
 * Start a sign-in the way the chat's Connect card does:
 * `POST /api/integrations/:id/connect` → `{ url }`. Answers the status, the
 * body and the authorization URL (`location`).
 */
async function connect({
  target = app,
  serverId = 'okta',
  user = 'alice',
  returnUrl = '/chat/abc',
  admin = false,
  headers = {}
} = {}) {
  let req = request(target).post(`/api/integrations/${serverId}/connect`);
  if (user) req = req.set('x-test-user', user);
  if (admin) req = req.set('x-test-admin', '1');
  for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
  const res = await req.send({ returnUrl });
  return { status: res.status, body: res.body, location: res.body?.url };
}

function startFlow(user = 'alice', returnUrl = '/chat/abc') {
  return connect({ user, returnUrl });
}

describe('POST /api/integrations/:id/connect (MCP)', () => {
  it('answers the authorization URL with PKCE, resource and a server-side state', async () => {
    const res = await startFlow();
    expect(res.status).toBe(200);
    const location = new URL(res.location);
    expect(location.origin + location.pathname).toBe('https://okta-mcp.example.com/authorize');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')).toBeTruthy();
    expect(location.searchParams.get('client_id')).toBe('dcr-client');
    expect(location.searchParams.get('resource')).toBe('https://okta-mcp.example.com/mcp');
    expect(location.searchParams.get('scope')).toBe('openid profile');
    // The server's own callback.
    expect(location.searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/api\/mcp\/oauth\/callback\/okta$/
    );

    const { key, stateParam } = decodeState(res.location);
    const payload = (await scratch.documents.get(OAUTH_FLOWS_NAMESPACE, key))?.data || null;
    // The state is an opaque handle; the flow stays on the server.
    expect(stateParam).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(payload).toMatchObject({
      installationId: 'okta',
      stack: 'mcp',
      userId: 'alice',
      returnUrl: '/chat/abc',
      // Bound to the authorization server and client the request went to.
      issuer: 'https://okta-mcp.example.com/',
      authorizationServerUrl: 'https://okta-mcp.example.com/',
      clientId: 'dcr-client',
      issRequired: false
    });
    // The verifier is kept encrypted.
    expect(payload.codeVerifier).toMatch(/^ENC\[/);

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
    expect(res.status).toBe(200);
    const location = new URL(res.location);
    expect(location.searchParams.get('client_id')).toBe(
      'https://ihub.example.com/api/mcp/oauth/client-metadata/okta'
    );
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://ihub.example.com/api/mcp/oauth/callback/okta'
    );
    expect(sdk.registerClient).not.toHaveBeenCalled();
  });

  it('refuses an off-site returnUrl before any flow starts', async () => {
    const res = await startFlow('alice', 'https://evil.example.com/steal');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RETURN_URL');
    expect(res.location).toBeUndefined();
    expect(sdk.discoverOAuthServerInfo).not.toHaveBeenCalled();
  });

  it('refuses anonymous callers', async () => {
    const res = await connect({ user: null });
    expect(res.status).toBe(401);
  });

  it('refuses a request without a JSON body (no cross-site form posts)', async () => {
    const res = await request(app)
      .post('/api/integrations/okta/connect')
      .set('x-test-user', 'alice')
      .type('form')
      .send('returnUrl=/chat/abc');
    expect(res.status).toBe(415);
  });

  it('answers an unknown or invisible server with 404', async () => {
    const unknown = await connect({ serverId: 'nope' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('INTEGRATION_NOT_FOUND');

    state.apps = [];
    const hidden = await startFlow();
    expect(hidden.status).toBe(404);
    expect(hidden.body.code).toBe('INTEGRATION_NOT_FOUND');
    expect(sdk.discoverOAuthServerInfo).not.toHaveBeenCalled();
  });

  it('lets a user connect a server an accessible app binds through app.integrations', async () => {
    // Since V193 an app binds the installation; it no longer lists the server in `tools`.
    state.apps = [{ id: 'assistant', integrations: { okta: { actions: ['search'] } } }];
    const res = await startFlow();
    expect(res.status).toBe(200);
    expect(res.location).toContain('https://okta-mcp.example.com/authorize?');
    const listed = await request(app).get('/api/integrations').set('x-test-user', 'alice');
    expect(listed.body.integrations.map(entry => entry.id)).toContain('okta');
  });

  it('refuses a user whose groups do not grant the installation, whatever the apps grant', async () => {
    // A stable public URL: supertest listens on a new port per request, and only
    // the admin's sign-in may move the registration to another base.
    state.platform = { ...state.platform, mcpServer: { publicUrl: 'http://ihub.test' } };
    state.apps = [{ id: 'assistant', integrations: { okta: {} } }];
    state.groups = {
      users: { id: 'users', permissions: { integrations: ['type:people-directory'] } },
      admins: { id: 'admins', permissions: { integrations: [], adminAccess: true } }
    };
    const hidden = await startFlow();
    expect(hidden.status).toBe(404);
    // The listing never shows an integration the user's groups do not allow.
    const listed = await request(app).get('/api/integrations').set('x-test-user', 'alice');
    expect(listed.body.integrations.map(entry => entry.id)).not.toContain('okta');
    // Admins configure and test the server: they always may connect.
    const admin = await connect({ user: 'root', admin: true });
    expect(admin.status).toBe(200);
    expect(admin.location).toContain('https://okta-mcp.example.com/authorize?');
    // Once the group grants it (by installation id), its members connect.
    state.groups = {
      ...state.groups,
      users: { id: 'users', permissions: { integrations: ['okta'] } }
    };
    const member = await startFlow();
    expect(member.status).toBe(200);
  });

  it('reports discovery and registration failures with stable codes', async () => {
    sdk.discoverOAuthServerInfo.mockRejectedValueOnce(new Error('boom <script>'));
    const discovery = await startFlow();
    expect(discovery.status).toBe(502);
    expect(discovery.body).toMatchObject({
      status: 502,
      detail: 'The sign-in could not be started',
      code: 'INTEGRATION_CONNECT_FAILED',
      details: { reason: 'discovery_failed' }
    });
    sdk.registerClient.mockRejectedValueOnce(new Error('registration refused'));
    const registration = await startFlow();
    expect(registration.status).toBe(502);
    expect(registration.body.code).toBe('INTEGRATION_CONNECT_FAILED');
    expect(registration.body.details.reason).toBe('registration_failed');
  });
});

describe('GET /api/mcp/oauth/callback/:serverId', () => {
  async function callback(query, user = 'alice', serverId = 'okta') {
    return request(app)
      .get(`/api/mcp/oauth/callback/${serverId}`)
      .query(query)
      .set('x-test-user', user);
  }

  it('exchanges the code with the verifier, stores the tokens and returns', async () => {
    const { stateParam, challenge } = decodeState((await startFlow()).location);
    const res = await callback({ code: 'auth-code-1', state: stateParam });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/chat/abc?integration_connected=okta');
    const [[tokenUrl, params]] = tokenRequests();
    expect(tokenUrl).toBe('https://okta-mcp.example.com/token');
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code')).toBe('auth-code-1');
    expect(params.get('client_id')).toBe('dcr-client');
    expect(params.get('redirect_uri')).toMatch(/\/api\/mcp\/oauth\/callback\/okta$/);
    expect(params.get('resource')).toBe('https://okta-mcp.example.com/mcp');
    expect(matchesChallenge(params.get('code_verifier'), challenge)).toBe(true);
    expect(await readUserTokens('alice', 'okta')).toMatchObject({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      // Bound to the endpoint, AS, client and resource it was issued for.
      binding: {
        ...tokenBindingFor(SERVER),
        authorizationServerUrl: 'https://okta-mcp.example.com/',
        clientId: 'dcr-client',
        resource: 'https://okta-mcp.example.com/mcp'
      }
    });
    expect(await readUserTokens('bob', 'okta')).toBeNull();
  });

  it('refuses a flow started by another user', async () => {
    const { stateParam } = decodeState((await startFlow('alice')).location);
    const res = await callback({ code: 'c', state: stateParam }, 'mallory');
    // The flow's return URL is only used for its owner.
    expect(res.headers.location).toBe(
      '/settings/integrations?integration_error=user_mismatch&integration=okta'
    );
    expect(tokenRequests()).toHaveLength(0);
    expect(await readUserTokens('mallory', 'okta')).toBeNull();
  });

  it('refuses unknown, replayed and expired state', async () => {
    // A stable public URL: supertest listens on a new port per request.
    state.platform = { ...state.platform, mcpServer: { publicUrl: 'http://ihub.test' } };
    const invalid = await callback({ code: 'c', state: 'not-a-state' });
    expect(invalid.headers.location).toBe(
      '/settings/integrations?integration_error=invalid_state&integration=okta'
    );

    // Single use: a second callback with the same state finds nothing.
    const { stateParam } = decodeState((await startFlow()).location);
    expect((await callback({ code: 'c', state: stateParam })).headers.location).toBe(
      '/chat/abc?integration_connected=okta'
    );
    const replayed = await callback({ code: 'c', state: stateParam });
    expect(replayed.headers.location).toBe(
      '/settings/integrations?integration_error=invalid_state&integration=okta'
    );
    expect(tokenRequests()).toHaveLength(1);

    const started = decodeState((await startFlow()).location);
    const startedDoc = await scratch.documents.get(OAUTH_FLOWS_NAMESPACE, started.key);
    await scratch.documents.put(
      OAUTH_FLOWS_NAMESPACE,
      started.key,
      { ...startedDoc.data, exp: Date.now() - 1000 },
      { ownerId: 'system' }
    );
    const late = await callback({ code: 'c', state: started.stateParam });
    expect(late.headers.location).toBe(
      '/chat/abc?integration_error=state_expired&integration=okta'
    );
    expect(tokenRequests()).toHaveLength(1);
  });

  it('turns an AS error into a stable code without echoing its text', async () => {
    const { stateParam } = decodeState((await startFlow()).location);
    const res = await callback({
      error: 'access_denied',
      error_description: 'The user said <b>no</b>',
      state: stateParam
    });
    expect(res.headers.location).toBe('/chat/abc?integration_error=access_denied&integration=okta');
    expect(res.headers.location).not.toContain('said');
  });

  it('reports a missing code and a failed exchange', async () => {
    state.platform = { ...state.platform, mcpServer: { publicUrl: 'http://ihub.test' } };
    const { stateParam } = decodeState((await startFlow()).location);
    const missing = await callback({ state: stateParam });
    expect(missing.headers.location).toBe(
      '/chat/abc?integration_error=missing_code&integration=okta'
    );

    tokenAnswer.mockImplementationOnce(() => ({ status: 400, body: { error: 'invalid_grant' } }));
    const again = decodeState((await startFlow()).location);
    const failed = await callback({ code: 'c', state: again.stateParam });
    expect(failed.headers.location).toBe(
      '/chat/abc?integration_error=exchange_failed&integration=okta'
    );
    expect(await readUserTokens('alice', 'okta')).toBeNull();
  });
});

describe('GET /api/integrations and POST /api/integrations/:id/disconnect (MCP)', () => {
  it('lists the per-user server with its connection status', async () => {
    await writeUserTokens(
      'alice',
      'okta',
      { access_token: 'a', token_type: 'bearer', expires_in: 3600, scope: 'openid' },
      tokenBindingFor(SERVER)
    );
    const okta = res => res.body.integrations.find(entry => entry.id === 'okta');
    const alice = await request(app).get('/api/integrations').set('x-test-user', 'alice');
    expect(alice.status).toBe(200);
    expect([okta(alice)]).toEqual([
      expect.objectContaining({
        id: 'okta',
        protocol: 'mcp',
        connection: expect.objectContaining({
          mode: 'personal',
          status: 'connected',
          scopes: expect.arrayContaining(['openid']),
          connectable: true
        })
      })
    ]);
    const bob = await request(app).get('/api/integrations').set('x-test-user', 'bob');
    expect(okta(bob).connection).toMatchObject({
      mode: 'personal',
      status: 'not_connected',
      reason: 'not_connected'
    });
    const one = await request(app).get('/api/integrations/okta').set('x-test-user', 'bob');
    expect(one.body.integration).toMatchObject({ id: 'okta' });
    const anonymous = await request(app).get('/api/integrations');
    expect(anonymous.status).toBe(401);
  });

  it('revokes at the authorization server and deletes the tokens', async () => {
    const { stateParam } = decodeState((await startFlow()).location);
    const connected = await request(app)
      .get('/api/mcp/oauth/callback/okta')
      .query({ code: 'c', state: stateParam })
      .set('x-test-user', 'alice');
    expect(connected.headers.location).toBe('/chat/abc?integration_connected=okta');
    expect(await readUserTokens('alice', 'okta')).not.toBeNull();

    const res = await request(app)
      .post('/api/integrations/okta/disconnect')
      .set('x-test-user', 'alice')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, removed: true, revoked: true });
    // Revocation requests refuse redirects too.
    for (const [url, init] of safeFetch.mock.calls) {
      if (String(url).includes('/revoke')) expect(init.redirect).toBe('manual');
    }
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
      .post('/api/integrations/..%2Fetc/disconnect')
      .set('x-test-user', 'alice')
      .send({});
    expect(bad.status).toBe(404);
    const unknown = await request(app)
      .post('/api/integrations/nope/disconnect')
      .set('x-test-user', 'alice')
      .send({});
    expect(unknown.status).toBe(404);
  });
});

describe('GET /api/mcp/oauth/client-metadata/:serverId', () => {
  it("serves a per-server document iHub's own CIMD validator accepts", async () => {
    state.platform = { ...state.platform, mcpServer: { publicUrl: 'https://ihub.example.com/' } };
    const res = await request(app).get('/api/mcp/oauth/client-metadata/okta');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(res.body.client_id).toBe('https://ihub.example.com/api/mcp/oauth/client-metadata/okta');
    expect(res.body.redirect_uris).toEqual([
      'https://ihub.example.com/api/mcp/oauth/callback/okta'
    ]);
    expect(res.body.token_endpoint_auth_method).toBe('none');
    expect(validateClientMetadata(res.body, res.body.client_id).ok).toBe(true);
  });

  it('is not cacheable when the base comes from the request, and 404s for unknown servers', async () => {
    const derived = await request(app).get('/api/mcp/oauth/client-metadata/okta');
    expect(derived.status).toBe(200);
    expect(derived.headers['cache-control']).toBe('no-store');
    expect(derived.headers.vary).toMatch(/X-Forwarded-Host/);
    expect((await request(app).get('/api/mcp/oauth/client-metadata/nope')).status).toBe(404);
  });
});

describe('OAuth mix-up defence (two authorization servers)', () => {
  // `evil` is a third-party MCP server whose authorization server the
  // attacker controls; `corp` is the corporate server behind an honest AS.
  const EVIL = {
    id: 'evil',
    name: 'Evil MCP',
    transport: { type: 'streamableHttp', url: 'https://evil-mcp.example.net/mcp' },
    auth: { type: 'oauthUser' }
  };
  const CORP = {
    id: 'corp',
    name: 'Corp MCP',
    transport: { type: 'streamableHttp', url: 'https://corp-mcp.example.com/mcp' },
    auth: { type: 'oauthUser' }
  };
  const EVIL_AS = {
    ...AS_METADATA,
    issuer: 'https://as.evil.example.net',
    authorization_endpoint: 'https://as.evil.example.net/authorize',
    token_endpoint: 'https://as.evil.example.net/token',
    registration_endpoint: 'https://as.evil.example.net/register'
  };
  const HONEST_AS = {
    ...AS_METADATA,
    issuer: 'https://login.corp.example.com',
    authorization_endpoint: 'https://login.corp.example.com/authorize',
    token_endpoint: 'https://login.corp.example.com/token',
    registration_endpoint: 'https://login.corp.example.com/register',
    authorization_response_iss_parameter_supported: true
  };

  beforeEach(async () => {
    state.platform = { ...state.platform, mcpServer: { publicUrl: 'https://ihub.example.com' } };
    state.apps = [{ id: 'assistant', integrations: { evil: {}, corp: {} } }];
    state.integrations = installationsOf(['evil', 'corp']);
    await mcpClientManager.initialize({ servers: [EVIL, CORP] });
    sdk.discoverOAuthServerInfo.mockImplementation(async serverUrl =>
      String(serverUrl).startsWith('https://evil-mcp')
        ? {
            authorizationServerUrl: 'https://as.evil.example.net/',
            authorizationServerMetadata: EVIL_AS
          }
        : {
            authorizationServerUrl: 'https://login.corp.example.com/',
            authorizationServerMetadata: HONEST_AS
          }
    );
    sdk.registerClient.mockImplementation(async asUrl => ({
      client_id: String(asUrl).includes('evil') ? 'client-at-evil' : 'client-at-corp'
    }));
  });

  async function start(serverId) {
    const res = await connect({ serverId });
    expect(res.status).toBe(200);
    return decodeState(res.location);
  }

  it("gives every server its own redirect URI and binds the flow to that server's AS", async () => {
    const evilStart = await start('evil');
    const corpStart = await start('corp');
    const evil = {
      payload: (await scratch.documents.get(OAUTH_FLOWS_NAMESPACE, evilStart.key)).data
    };
    const corp = {
      payload: (await scratch.documents.get(OAUTH_FLOWS_NAMESPACE, corpStart.key)).data
    };
    expect(evil.payload.redirectUri).toBe('https://ihub.example.com/api/mcp/oauth/callback/evil');
    expect(corp.payload.redirectUri).toBe('https://ihub.example.com/api/mcp/oauth/callback/corp');
    expect(evil.payload).toMatchObject({
      issuer: 'https://as.evil.example.net',
      clientId: 'client-at-evil',
      issRequired: false
    });
    expect(corp.payload).toMatchObject({
      issuer: 'https://login.corp.example.com',
      clientId: 'client-at-corp',
      issRequired: true
    });
  });

  it("refuses a code the honest AS sent for the evil server's ticket (iss mismatch)", async () => {
    // The evil AS relayed the browser to the honest AS with the evil ticket.
    const { stateParam } = await start('evil');
    const res = await request(app)
      .get('/api/mcp/oauth/callback/evil')
      .query({ code: 'honest-code', state: stateParam, iss: 'https://login.corp.example.com' })
      .set('x-test-user', 'alice');
    expect(res.headers.location).toBe(
      '/chat/abc?integration_error=issuer_mismatch&integration=evil'
    );
    // The code and the verifier never reach the evil token endpoint.
    expect(tokenRequests()).toHaveLength(0);
    expect(await readUserTokens('alice', 'evil')).toBeNull();
  });

  it("refuses a code delivered to another server's callback", async () => {
    const { stateParam } = await start('evil');
    const res = await request(app)
      .get('/api/mcp/oauth/callback/corp')
      .query({ code: 'honest-code', state: stateParam })
      .set('x-test-user', 'alice');
    expect(res.headers.location).toBe('/chat/abc?integration_error=invalid_state&integration=evil');
    expect(tokenRequests()).toHaveLength(0);
  });

  it('requires iss when the AS advertises RFC 9207 support, and accepts the right one', async () => {
    const first = await start('corp');
    const missing = await request(app)
      .get('/api/mcp/oauth/callback/corp')
      .query({ code: 'c1', state: first.stateParam })
      .set('x-test-user', 'alice');
    expect(missing.headers.location).toBe(
      '/chat/abc?integration_error=issuer_mismatch&integration=corp'
    );
    expect(tokenRequests()).toHaveLength(0);

    const second = await start('corp');
    const ok = await request(app)
      .get('/api/mcp/oauth/callback/corp')
      .query({ code: 'c1', state: second.stateParam, iss: 'https://login.corp.example.com' })
      .set('x-test-user', 'alice');
    expect(ok.headers.location).toBe('/chat/abc?integration_connected=corp');
    const [[tokenUrl, params]] = tokenRequests();
    expect(tokenUrl).toBe('https://login.corp.example.com/token');
    expect(params.get('client_id')).toBe('client-at-corp');
  });

  it('refuses to exchange when the registration changed since the sign-in started', async () => {
    const { stateParam } = await start('evil');
    const record = await mcpClientManager.clientStore.get('evil');
    await mcpClientManager.clientStore.put('evil', {
      ...record,
      authorizationServerUrl: 'https://login.corp.example.com/',
      clientId: 'client-at-corp'
    });
    const res = await request(app)
      .get('/api/mcp/oauth/callback/evil')
      .query({ code: 'c', state: stateParam, iss: 'https://as.evil.example.net' })
      .set('x-test-user', 'alice');
    expect(res.headers.location).toBe(
      '/chat/abc?integration_error=exchange_failed&integration=evil'
    );
    expect(tokenRequests()).toHaveLength(0);
  });
});

describe('public base and the shared registration', () => {
  it('a forged Host does not replace the registration every user depends on', async () => {
    const first = await connect({ headers: { Host: 'ihub.test' } });
    expect(first.status).toBe(200);
    const before = await mcpClientManager.clientStore.get('okta');
    expect(before).toMatchObject({ clientId: 'dcr-client', publicBase: 'http://ihub.test' });

    // X-Forwarded-Host is ignored while `trust proxy` is off.
    const forwarded = await connect({
      user: 'mallory',
      headers: { Host: 'ihub.test', 'X-Forwarded-Host': 'evil.example' }
    });
    expect(new URL(forwarded.location).searchParams.get('redirect_uri')).toBe(
      'http://ihub.test/api/mcp/oauth/callback/okta'
    );

    // A forged Host is refused instead of re-registering.
    sdk.registerClient.mockResolvedValue({ client_id: 'attacker-client' });
    const forged = await connect({ user: 'mallory', headers: { Host: 'evil.example' } });
    expect(forged.status).toBe(409);
    expect(forged.body.code).toBe('INTEGRATION_CONNECT_FAILED');
    expect(forged.body.details.reason).toBe('public_url_mismatch');
    expect(sdk.registerClient).toHaveBeenCalledTimes(1);
    expect(await mcpClientManager.clientStore.get('okta')).toMatchObject({
      clientId: 'dcr-client',
      publicBase: 'http://ihub.test'
    });
  });

  it('honours X-Forwarded-Host only behind a trusted proxy, and still never replaces the registration', async () => {
    const proxied = express();
    proxied.set('trust proxy', true);
    mountRoutes(proxied);
    await connect({
      target: proxied,
      headers: { 'X-Forwarded-Host': 'ihub.example.com', 'X-Forwarded-Proto': 'https' }
    });
    expect(await mcpClientManager.clientStore.get('okta')).toMatchObject({
      publicBase: 'https://ihub.example.com'
    });
    const forged = await connect({
      target: proxied,
      user: 'mallory',
      headers: { 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'https' }
    });
    expect(forged.body.code).toBe('INTEGRATION_CONNECT_FAILED');
    expect(forged.body.details.reason).toBe('public_url_mismatch');
    expect((await mcpClientManager.clientStore.get('okta')).publicBase).toBe(
      'https://ihub.example.com'
    );
  });

  it("lets an admin's own sign-in move the registration to a new base", async () => {
    await connect({ headers: { Host: 'old.ihub.test' } });
    sdk.registerClient.mockResolvedValue({ client_id: 'dcr-client-2' });
    const moved = await connect({ user: 'admin', admin: true, headers: { Host: 'new.ihub.test' } });
    expect(moved.status).toBe(200);
    expect(await mcpClientManager.clientStore.get('okta')).toMatchObject({
      clientId: 'dcr-client-2',
      publicBase: 'http://new.ihub.test'
    });
  });
});

describe('OAuth requests refuse redirects', () => {
  it('sends redirect: manual and turns a 3xx into an error', async () => {
    safeFetch.mockResolvedValueOnce({
      ok: false,
      status: 307,
      headers: new Map([['location', 'http://169.254.169.254/latest/meta-data']])
    });
    const fetchFn = buildMcpOAuthFetch({});
    await expect(
      fetchFn('https://as.example.com/token', { method: 'POST', body: 'grant_type=x' })
    ).rejects.toMatchObject({ code: 'MCP_OAUTH_REDIRECT_REFUSED' });
    expect(safeFetch).toHaveBeenLastCalledWith(
      'https://as.example.com/token',
      expect.objectContaining({ redirect: 'manual', method: 'POST' }),
      expect.anything()
    );
    safeFetch.mockResolvedValueOnce({ ok: true, status: 200 });
    await expect(fetchFn('https://as.example.com/token')).resolves.toMatchObject({ status: 200 });
  });
});

describe('returnPathWith (the redirect back after a sign-in)', () => {
  it('appends parameters and keeps the path, query and fragment', () => {
    expect(returnPathWith('/chat/1', { a: 'b' })).toBe('/chat/1?a=b');
    expect(returnPathWith('/chat/1?x=1#top', { a: 'b' })).toBe('/chat/1?x=1&a=b#top');
    // A same-host absolute URL becomes a path on this origin.
    expect(returnPathWith('https://ihub.example.com/c', { a: 'b c' })).toBe('/c?a=b+c');
  });

  it('never produces a redirect that leaves this origin', () => {
    for (const hostile of ['/\\evil.example', '//evil.example/x', '/\\/evil.example', '\\evil']) {
      const out = returnPathWith(hostile, { a: 'b' });
      expect(out.startsWith('/')).toBe(true);
      expect(out.startsWith('//')).toBe(false);
      expect(out.startsWith('/\\')).toBe(false);
      expect(new URL(out, 'https://ihub.example.com').host).toBe('ihub.example.com');
    }
  });
});
