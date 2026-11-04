// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import tokenStorage from '../../services/TokenStorageService.js';
import { tokenStorageIdFor } from '../../services/integrations/auth/tokenSecrets.js';
import {
  readUserTokens,
  writeUserTokens,
  listServerConnections,
  userTokenStatus,
  tokenBindingFor
} from '../../services/mcp/mcpUserTokens.js';
import {
  McpUserOAuthProvider,
  McpAuthRequiredError,
  isAuthRequiredError
} from '../../services/mcp/McpUserOAuthProvider.js';
import {
  McpOAuthClientStore,
  registrationFingerprint
} from '../../services/mcp/mcpOAuthClientStore.js';
import {
  OAuthFlowStore,
  OAUTH_FLOW_TTL_MS,
  OAUTH_FLOWS_NAMESPACE
} from '../../services/integrations/auth/oauthFlowStore.js';
import { buildMcpClientMetadata } from '../../services/mcp/mcpOAuthPublicUrl.js';
import { validateClientMetadata } from '../../utils/clientIdMetadata.js';
import { mcpServerConfigSchema } from '../../validators/mcpServerConfigSchema.js';
import { createHash } from 'node:crypto';
import { scratchDocuments } from '../helpers/testStorage.js';

const scratch = await scratchDocuments();

/**
 * Per-user OAuth for outbound MCP servers — the pieces below the routes: the
 * storage id of a user's token file, the SDK OAuthClientProvider, the signed
 * `state` ticket, iHub's own Client ID Metadata Document, and the config
 * schema for `auth.type: "oauthUser"`.
 */

const SERVER = mcpServerConfigSchema.parse({
  id: 'okta',
  name: 'Okta MCP',
  transport: { type: 'streamableHttp', url: 'https://okta-mcp.example.com/mcp' },
  auth: { type: 'oauthUser', scopes: ['openid', 'profile'] }
});

const originalKey = tokenStorage.encryptionKey;
const originalBase = tokenStorage.storageBasePath;
const originalJwtSecret = tokenStorage.jwtSecret;
let tmpDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-mcp-oauth-'));
  tokenStorage.encryptionKey = 'b'.repeat(64);
  tokenStorage.storageBasePath = tmpDir;
  // The state ticket is signed with the platform's JWT secret.
  tokenStorage.jwtSecret = 'mcp-oauth-test-secret';
});

afterAll(() => {
  tokenStorage.encryptionKey = originalKey;
  tokenStorage.storageBasePath = originalBase;
  tokenStorage.jwtSecret = originalJwtSecret;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('tokenStorageIdFor', () => {
  it('keeps ids the token store accepts', () => {
    expect(tokenStorageIdFor('alice')).toBe('alice');
    expect(tokenStorageIdFor('alice@example.com')).toBe('alice@example.com');
  });

  it('hashes ids outside the file-name allowlist to a stable u_<32 hex> id', () => {
    const id = tokenStorageIdFor('auth0|12345');
    expect(id).toMatch(/^u_[0-9a-f]{32}$/);
    expect(tokenStorageIdFor('auth0|12345')).toBe(id);
    expect(tokenStorageIdFor('auth0|12346')).not.toBe(id);
    expect(tokenStorageIdFor('https://idp.example.com/users/1')).toMatch(/^u_[0-9a-f]{32}$/);
  });

  it('refuses an empty id', () => {
    expect(() => tokenStorageIdFor('')).toThrow();
    expect(() => tokenStorageIdFor(undefined)).toThrow();
  });
});

describe('per-user token files', () => {
  it('stores tokens encrypted, with the real user id inside the payload', async () => {
    await writeUserTokens('auth0|carol', 'okta', {
      access_token: 'secret-access',
      token_type: 'bearer',
      expires_in: 3600,
      refresh_token: 'secret-refresh',
      scope: 'openid'
    });
    const file = path.join(tmpDir, 'mcp', `${tokenStorageIdFor('auth0|carol')}__okta.json`);
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain('secret-access');
    expect(raw).not.toContain('secret-refresh');
    expect(JSON.parse(raw).expiresAt).toEqual(expect.any(String));

    const payload = await readUserTokens('auth0|carol', 'okta');
    expect(payload).toMatchObject({
      access_token: 'secret-access',
      refresh_token: 'secret-refresh',
      expiresIn: 3600,
      userId: 'auth0|carol',
      serverId: 'okta'
    });

    const connections = await listServerConnections('okta');
    expect(connections).toEqual([
      expect.objectContaining({ userId: 'auth0|carol', expired: false })
    ]);
    // Bound to the server config: an unbound file is not a connection of it.
    expect(await listServerConnections('okta', SERVER)).toEqual([]);
    expect(await userTokenStatus('auth0|carol', 'okta')).toMatchObject({
      connected: true,
      scope: 'openid'
    });
    expect(await userTokenStatus('dave', 'okta')).toMatchObject({ connected: false });
  });
});

describe('McpUserOAuthProvider', () => {
  let clientStore;
  const provider = (userId = 'alice', extra = {}) =>
    new McpUserOAuthProvider({
      serverConfig: SERVER,
      userId,
      publicBase: 'https://ihub.example.com',
      clientStore,
      ...extra
    });

  beforeEach(async () => {
    await scratch.reset();
    clientStore = new McpOAuthClientStore({ documents: scratch.documents });
  });

  it("exposes the server's own redirect URI and CIMD URL for an https base", () => {
    const p = provider();
    expect(p.redirectUrl).toBe('https://ihub.example.com/api/mcp/oauth/callback/okta');
    expect(p.clientMetadataUrl).toBe('https://ihub.example.com/api/mcp/oauth/client-metadata/okta');
    expect(p.clientMetadata).toMatchObject({
      redirect_uris: ['https://ihub.example.com/api/mcp/oauth/callback/okta'],
      token_endpoint_auth_method: 'none',
      scope: 'openid profile'
    });
    expect(p.clientMetadata.client_id).toBeUndefined();
  });

  it('offers no CIMD URL on a plain-http base', () => {
    const p = provider('alice', { publicBase: 'http://localhost:3000' });
    expect(p.clientMetadataUrl).toBeUndefined();
  });

  it('round-trips tokens for exactly one (user, server)', async () => {
    const alice = provider('alice');
    expect(await alice.tokens()).toBeUndefined();
    await alice.saveTokens({ access_token: 'a1', token_type: 'bearer', expires_in: 60 });
    expect(await alice.tokens()).toMatchObject({ access_token: 'a1', expires_in: 60 });
    expect(await provider('bob').tokens()).toBeUndefined();
  });

  it('never hands the refresh token to the SDK (iHub refreshes itself)', async () => {
    await writeUserTokens(
      'alice',
      'okta',
      { access_token: 'a1', token_type: 'bearer', refresh_token: 'r1' },
      tokenBindingFor(SERVER)
    );
    const tokens = await provider('alice').tokens();
    expect(tokens.access_token).toBe('a1');
    expect(tokens.refresh_token).toBeUndefined();
  });

  it('treats tokens issued for another endpoint or auth block as not connected', async () => {
    const other = mcpServerConfigSchema.parse({
      ...SERVER,
      transport: { type: 'streamableHttp', url: 'https://vendor.example.com/mcp' }
    });
    await writeUserTokens(
      'alice',
      'okta',
      { access_token: 'for-old-endpoint', token_type: 'bearer' },
      tokenBindingFor(other)
    );
    expect(await provider('alice').tokens()).toBeUndefined();
    // Unbound files (no binding at all) never match either.
    await writeUserTokens('alice', 'okta', { access_token: 'unbound', token_type: 'bearer' });
    expect(await provider('alice').tokens()).toBeUndefined();
    expect(await userTokenStatus('alice', SERVER)).toMatchObject({ connected: false });
  });

  it('invalidates tokens it handed out, but keeps tokens refreshed elsewhere', async () => {
    const alice = provider('alice');
    // Never handed out a token: nothing is deleted.
    await writeUserTokens(
      'alice',
      'okta',
      { access_token: 'untouched', token_type: 'bearer' },
      tokenBindingFor(SERVER)
    );
    expect(await alice.invalidateTokens()).toBe(false);
    expect((await readUserTokens('alice', 'okta')).access_token).toBe('untouched');

    await alice.saveTokens({ access_token: 'old', token_type: 'bearer' });
    await alice.tokens();
    // Another worker refreshed the token in the meantime.
    await writeUserTokens(
      'alice',
      'okta',
      { access_token: 'new', token_type: 'bearer' },
      tokenBindingFor(SERVER)
    );
    expect(await alice.invalidateTokens()).toBe(false);
    expect((await readUserTokens('alice', 'okta')).access_token).toBe('new');

    await alice.tokens();
    await alice.invalidateCredentials('tokens');
    expect(await readUserTokens('alice', 'okta')).toBeNull();
  });

  it('asks for sign-in instead of registering or redirecting on the server', async () => {
    const p = provider();
    await expect(p.clientInformation()).rejects.toBeInstanceOf(McpAuthRequiredError);
    expect(() => p.redirectToAuthorization(new URL('https://as.example.com/authorize'))).toThrow(
      McpAuthRequiredError
    );
    expect(isAuthRequiredError(new McpAuthRequiredError('okta'))).toBe(true);
    expect(() => p.codeVerifier()).toThrow(McpAuthRequiredError);
    p.saveCodeVerifier('v-1');
    expect(p.codeVerifier()).toBe('v-1');
    await p.invalidateCredentials('verifier');
    expect(() => p.codeVerifier()).toThrow(McpAuthRequiredError);
  });

  it('returns a stored registration and forgets it on invalid_client', async () => {
    await clientStore.put('okta', {
      source: 'dcr',
      clientId: 'dcr-1',
      clientSecret: 'dcr-secret',
      authorizationServerUrl: 'https://okta-mcp.example.com/',
      redirectUri: 'https://ihub.example.com/api/mcp/oauth/callback',
      publicBase: 'https://ihub.example.com',
      fingerprint: registrationFingerprint(SERVER)
    });
    // The secret is stored encrypted.
    expect((await clientStore.get('okta')).clientSecret).toMatch(/^ENC\[/);
    const p = provider();
    expect(await p.clientInformation()).toEqual({
      client_id: 'dcr-1',
      client_secret: 'dcr-secret'
    });
    await p.invalidateCredentials('client');
    await expect(p.clientInformation()).rejects.toBeInstanceOf(McpAuthRequiredError);
  });

  it('ignores a registration made for another endpoint or auth block, without deleting it', async () => {
    await clientStore.put('okta', {
      source: 'dcr',
      clientId: 'dcr-1',
      authorizationServerUrl: 'https://okta-mcp.example.com/',
      fingerprint: 'made-for-an-older-config'
    });
    await expect(provider().clientInformation()).rejects.toBeInstanceOf(McpAuthRequiredError);
    // A draft or a stale worker config must never delete the live record.
    expect((await clientStore.get('okta')).clientId).toBe('dcr-1');
  });

  it('prefers a pre-registered client from the config', async () => {
    const serverConfig = mcpServerConfigSchema.parse({
      ...SERVER,
      auth: { type: 'oauthUser', clientId: 'pre-registered' }
    });
    const p = new McpUserOAuthProvider({ serverConfig, userId: 'alice', clientStore });
    expect(await p.clientInformation()).toEqual({
      client_id: 'pre-registered',
      token_endpoint_auth_method: 'none'
    });
  });

  it('saves discovery state onto the registration', async () => {
    await clientStore.put('okta', {
      source: 'dcr',
      clientId: 'dcr-1',
      authorizationServerUrl: '',
      fingerprint: registrationFingerprint(SERVER)
    });
    const p = provider();
    await p.saveDiscoveryState({ authorizationServerUrl: 'https://as.example.com/' });
    expect(await p.discoveryState()).toEqual({ authorizationServerUrl: 'https://as.example.com/' });
    expect((await clientStore.get('okta')).authorizationServerUrl).toBe('https://as.example.com/');
  });

  it('hands the SDK a random state per call', () => {
    const p = provider();
    expect(p.state()).toMatch(/^[0-9a-f]{32}$/);
    expect(p.state()).not.toBe(p.state());
  });
});

describe('MCP OAuth state (server-side flow record)', () => {
  const context = {
    stack: 'mcp',
    installationId: 'okta',
    userId: 'alice',
    returnUrl: '/chat/1',
    codeVerifier: 'the-pkce-verifier',
    redirectUri: 'https://ihub.example.com/api/mcp/oauth/callback/okta',
    issuer: 'https://okta-mcp.example.com/',
    authorizationServerUrl: 'https://okta-mcp.example.com/',
    clientId: 'dcr-1',
    issRequired: true,
    resource: 'https://okta-mcp.example.com/mcp',
    scopes: []
  };

  it('keeps the context server-side; the state is an opaque random handle', async () => {
    const store = new OAuthFlowStore({ documents: scratch.documents });
    const state = await store.create(context);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state).not.toContain('alice');
    const key = `flow_${createHash('sha256').update(state, 'utf8').digest('hex').slice(0, 48)}`;
    const record = (await scratch.documents.get(OAUTH_FLOWS_NAMESPACE, key)).data;
    expect(JSON.stringify(record)).not.toContain('the-pkce-verifier');
    const consumed = await store.consume(state);
    expect(consumed.ok).toBe(true);
    expect(consumed.flow).toMatchObject({ ...context, codeVerifier: 'the-pkce-verifier' });
  });

  it('is single use and refuses unknown states', async () => {
    const store = new OAuthFlowStore({ documents: scratch.documents });
    const state = await store.create(context);
    expect((await store.consume(state)).ok).toBe(true);
    expect(await store.consume(state)).toEqual({ ok: false, reason: 'invalid' });
    expect((await store.consume('garbage')).ok).toBe(false);
    expect((await store.consume('')).ok).toBe(false);
  });

  it('refuses to record a flow without the user, installation or verifier', async () => {
    const store = new OAuthFlowStore({ documents: scratch.documents });
    await expect(store.create({ ...context, userId: '' })).rejects.toThrow(/userId/);
    await expect(store.create({ ...context, installationId: undefined })).rejects.toThrow(
      /installationId/
    );
    await expect(store.create({ ...context, codeVerifier: '' })).rejects.toThrow(/codeVerifier/);
  });

  it('expires after 15 minutes', async () => {
    let now = Date.now();
    const store = new OAuthFlowStore({ documents: scratch.documents, now: () => now });
    const fresh = await store.create(context);
    now += OAUTH_FLOW_TTL_MS - 1000;
    expect((await store.consume(fresh)).ok).toBe(true);
    const stale = await store.create(context);
    now += OAUTH_FLOW_TTL_MS + 1000;
    const expired = await store.consume(stale);
    expect(expired.ok).toBe(false);
    expect(expired.reason).toBe('expired');
    expect(expired.flow).not.toHaveProperty('codeVerifier');
  });
});

describe("iHub's Client ID Metadata Document", () => {
  it("is accepted by iHub's own CIMD validator", () => {
    const doc = buildMcpClientMetadata({
      publicBase: 'https://ihub.example.com/ihub',
      serverId: 'okta',
      clientName: 'iHub Apps'
    });
    expect(doc.client_id).toBe('https://ihub.example.com/ihub/api/mcp/oauth/client-metadata/okta');
    const result = validateClientMetadata(doc, doc.client_id);
    // One document per server, listing exactly that server's callback.
    expect(result).toMatchObject({
      ok: true,
      metadata: {
        name: 'iHub Apps',
        redirectUris: ['https://ihub.example.com/ihub/api/mcp/oauth/callback/okta']
      }
    });
    expect(Buffer.byteLength(JSON.stringify(doc))).toBeLessThan(8 * 1024);
  });
});

describe('oauthUser config', () => {
  it('is accepted on HTTP transports only', () => {
    expect(SERVER.auth).toEqual({ type: 'oauthUser', scopes: ['openid', 'profile'] });
    const stdio = mcpServerConfigSchema.safeParse({
      id: 'local',
      name: 'Local',
      transport: { type: 'stdio', command: 'node' },
      auth: { type: 'oauthUser' }
    });
    expect(stdio.success).toBe(false);
    const sse = mcpServerConfigSchema.safeParse({
      id: 'legacy',
      name: 'Legacy',
      transport: { type: 'sse', url: 'https://legacy.example.com/sse' },
      auth: { type: 'oauthUser' }
    });
    expect(sse.success).toBe(true);
  });

  it('requires an https authorization server override', () => {
    const insecure = mcpServerConfigSchema.safeParse({
      ...SERVER,
      auth: { type: 'oauthUser', authorizationServer: 'http://as.example.com' }
    });
    expect(insecure.success).toBe(false);
  });
});
