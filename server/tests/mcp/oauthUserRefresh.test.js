import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import tokenStorage from '../../services/TokenStorageService.js';
import mcpClientManager, { userConnectionKey } from '../../services/mcp/McpClientManager.js';
import {
  McpOAuthClientStore,
  registrationFingerprint
} from '../../services/mcp/mcpOAuthClientStore.js';
import { McpToolCatalogStore } from '../../services/mcp/mcpToolCatalogStore.js';
import {
  readUserTokens,
  writeUserTokens,
  tokenBindingFor
} from '../../services/mcp/mcpUserTokens.js';
import { chatToolSeam } from '../../services/chat/chatSeams.js';

/**
 * Per-user OAuth review fixes in McpClientManager:
 *
 *   - iHub refreshes tokens itself, once per (user, server): parallel calls
 *     share one refresh; a transient failure (network, 5xx) keeps the tokens;
 *     only a definitive refusal (invalid_grant, …) deletes them, and not when
 *     another worker rotated them meanwhile.
 *   - parallel calls share one pooled connection.
 *   - tokens are bound to the endpoint + auth block and removed when the
 *     server is removed or repointed.
 *   - an admin Test of an edited draft never uses the admin's token nor
 *     touches the live registration.
 *   - the shared catalog never shrinks from a non-admin listing.
 */

const OKTA = {
  id: 'okta',
  name: 'Okta MCP',
  transport: { type: 'streamableHttp', url: 'https://okta-mcp.example.com/mcp' },
  auth: { type: 'oauthUser' }
};

const TOOL = {
  name: 'get-current-user',
  description: 'The signed-in Okta user',
  inputSchema: { type: 'object', properties: {} }
};

const ALICE = { id: 'alice', groups: ['users'] };

const saved = {};
let tmpDir;
let clientStore;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-mcp-oauth-refresh-'));
  saved.key = tokenStorage.encryptionKey;
  saved.base = tokenStorage.storageBasePath;
  tokenStorage.encryptionKey = 'e'.repeat(64);
  tokenStorage.storageBasePath = tmpDir;
});

afterAll(async () => {
  await mcpClientManager.shutdown();
  mcpClientManager.refreshAuthorization = null;
  tokenStorage.encryptionKey = saved.key;
  tokenStorage.storageBasePath = saved.base;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  fs.rmSync(path.join(tmpDir, 'mcp'), { recursive: true, force: true });
  clientStore = new McpOAuthClientStore({ documents: null });
  mcpClientManager.clientStore = clientStore;
  mcpClientManager.catalogStore = new McpToolCatalogStore({ documents: null });
  mcpClientManager.refreshGraceMs = 0;
  mcpClientManager.refreshAuthorization = null;
  await mcpClientManager.shutdown();
  await mcpClientManager.initialize({ servers: [OKTA] });
  await mcpClientManager.saveCatalog(mcpClientManager.getConnection('okta').config, [TOOL], {
    authoritative: true
  });
  await clientStore.put('okta', {
    source: 'dcr',
    clientId: 'dcr-client',
    authorizationServerUrl: 'https://okta-mcp.example.com/',
    discovery: { authorizationServerUrl: 'https://okta-mcp.example.com/' },
    redirectUri: 'https://ihub.example.com/api/mcp/oauth/callback/okta',
    publicBase: 'https://ihub.example.com',
    fingerprint: registrationFingerprint(OKTA)
  });
});

const binding = () =>
  tokenBindingFor(OKTA, {
    authorizationServerUrl: 'https://okta-mcp.example.com/',
    clientId: 'dcr-client',
    resource: 'https://okta-mcp.example.com/mcp'
  });

async function seedTokens(extra = {}) {
  await writeUserTokens(
    'alice',
    'okta',
    { access_token: 'old', token_type: 'bearer', refresh_token: 'r1', ...extra },
    binding()
  );
}

/**
 * Alice's pooled connection with a fake SDK client that behaves like the
 * upstream: it accepts only the access token currently stored ("new" after
 * a refresh) and answers 401 for the old one.
 */
async function fakeUpstream({ accept = token => token !== 'old' } = {}) {
  const entry = await mcpClientManager._userConnection(
    mcpClientManager.getConnection('okta').config,
    'alice'
  );
  entry.conn.connected = true;
  entry.conn.client = {
    callTool: jest.fn(async () => {
      const tokens = await entry.provider.tokens();
      if (!tokens || !accept(tokens.access_token)) throw new UnauthorizedError('401');
      return { content: [{ type: 'text', text: `ok with ${tokens.access_token}` }] };
    }),
    listTools: jest.fn(async () => ({ tools: [TOOL] })),
    close: jest.fn(async () => {})
  };
  return entry;
}

const call = (user = ALICE) =>
  mcpClientManager.callTool('okta__get-current-user', { user, chatId: 'chat-1' });

describe('token refresh owned by iHub', () => {
  it('refreshes a rejected token at the issuing AS and retries the call', async () => {
    await seedTokens();
    await fakeUpstream();
    mcpClientManager.refreshAuthorization = jest.fn(async () => ({
      access_token: 'new',
      token_type: 'bearer',
      refresh_token: 'r2'
    }));
    expect(await call()).toBe('ok with new');
    expect(mcpClientManager.refreshAuthorization).toHaveBeenCalledWith(
      'https://okta-mcp.example.com/',
      expect.objectContaining({
        refreshToken: 'r1',
        clientInformation: expect.objectContaining({ client_id: 'dcr-client' }),
        resource: new URL('https://okta-mcp.example.com/mcp'),
        fetchFn: expect.any(Function)
      })
    );
    const stored = await readUserTokens('alice', 'okta');
    expect(stored).toMatchObject({ access_token: 'new', refresh_token: 'r2' });
    // The binding survives the refresh.
    expect(stored.binding).toEqual(binding());
  });

  it('shares one refresh between parallel calls (no refresh-token reuse)', async () => {
    await seedTokens();
    await fakeUpstream();
    let release;
    const gate = new Promise(resolve => {
      release = resolve;
    });
    mcpClientManager.refreshAuthorization = jest.fn(async () => {
      await gate;
      return { access_token: 'new', token_type: 'bearer', refresh_token: 'r2' };
    });
    const calls = Promise.all([call(), call(), call()]);
    await new Promise(resolve => setTimeout(resolve, 20));
    release();
    expect(await calls).toEqual(['ok with new', 'ok with new', 'ok with new']);
    expect(mcpClientManager.refreshAuthorization).toHaveBeenCalledTimes(1);
    expect((await readUserTokens('alice', 'okta')).access_token).toBe('new');
  });

  it('keeps the tokens when the refresh fails for a transient reason', async () => {
    await seedTokens();
    await fakeUpstream();
    for (const failure of [
      new TypeError('fetch failed'),
      Object.assign(new Error('Service unavailable'), { name: 'ServerError' }),
      Object.assign(new Error('boom'), { errorCode: 'server_error' })
    ]) {
      mcpClientManager.refreshAuthorization = jest.fn(async () => {
        throw failure;
      });
      await expect(call()).rejects.toThrow(/could not be renewed/);
      expect(await readUserTokens('alice', 'okta')).toMatchObject({
        access_token: 'old',
        refresh_token: 'r1'
      });
    }
  });

  it('deletes the tokens only when the AS definitively refuses them', async () => {
    await seedTokens();
    await fakeUpstream();
    mcpClientManager.refreshAuthorization = jest.fn(async () => {
      throw Object.assign(new Error('refresh token revoked'), {
        name: 'InvalidGrantError',
        errorCode: 'invalid_grant'
      });
    });
    expect(await call()).toMatchObject({ error: 'MCP_AUTH_REQUIRED' });
    expect(await readUserTokens('alice', 'okta')).toBeNull();
    expect(mcpClientManager.userConnections.has(userConnectionKey('okta', 'alice'))).toBe(false);
    // invalid_grant says nothing about the client: the registration stays.
    expect(await clientStore.get('okta')).not.toBeNull();
  });

  it('drops a dead client registration on invalid_client', async () => {
    await seedTokens();
    await fakeUpstream();
    mcpClientManager.refreshAuthorization = jest.fn(async () => {
      throw Object.assign(new Error('unknown client'), { errorCode: 'invalid_client' });
    });
    expect(await call()).toMatchObject({ error: 'MCP_AUTH_REQUIRED' });
    expect(await clientStore.get('okta')).toBeNull();
  });

  it('keeps tokens another worker rotated while this refresh was refused', async () => {
    await seedTokens();
    await fakeUpstream();
    mcpClientManager.refreshAuthorization = jest.fn(async () => {
      // The other worker won the race with the same refresh token.
      await writeUserTokens(
        'alice',
        'okta',
        { access_token: 'new', token_type: 'bearer', refresh_token: 'r2' },
        binding()
      );
      throw Object.assign(new Error('reused'), { errorCode: 'invalid_grant' });
    });
    expect(await call()).toBe('ok with new');
    expect(await readUserTokens('alice', 'okta')).toMatchObject({ access_token: 'new' });
  });

  it('refreshes an access token known to be expired before calling', async () => {
    await writeUserTokens(
      'alice',
      'okta',
      { access_token: 'old', token_type: 'bearer', refresh_token: 'r1', expires_in: 1 },
      binding()
    );
    const entry = await fakeUpstream();
    // An hour later the one-second token has long expired.
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60 * 60 * 1000);
    try {
      mcpClientManager.refreshAuthorization = jest.fn(async () => ({
        access_token: 'new',
        token_type: 'bearer'
      }));
      expect(await call()).toBe('ok with new');
    } finally {
      Date.now.mockRestore();
    }
    expect(mcpClientManager.refreshAuthorization).toHaveBeenCalledTimes(1);
    // One upstream call: no 401 round trip first.
    expect(entry.conn.client.callTool).toHaveBeenCalledTimes(1);
  });

  it('drops a token the server refuses even right after a refresh', async () => {
    await seedTokens();
    await fakeUpstream({ accept: () => false });
    mcpClientManager.refreshAuthorization = jest.fn(async () => ({
      access_token: 'new',
      token_type: 'bearer',
      refresh_token: 'r2'
    }));
    expect(await call()).toMatchObject({ error: 'MCP_AUTH_REQUIRED' });
    expect(await readUserTokens('alice', 'okta')).toBeNull();
  });

  it('never refreshes with a refresh token issued to another client', async () => {
    await writeUserTokens(
      'alice',
      'okta',
      { access_token: 'old', token_type: 'bearer', refresh_token: 'r1' },
      tokenBindingFor(OKTA, {
        authorizationServerUrl: 'https://other-as.example.com/',
        clientId: 'dcr-client'
      })
    );
    await fakeUpstream();
    mcpClientManager.refreshAuthorization = jest.fn();
    expect(await call()).toMatchObject({ error: 'MCP_AUTH_REQUIRED' });
    expect(mcpClientManager.refreshAuthorization).not.toHaveBeenCalled();
    expect(await readUserTokens('alice', 'okta')).toBeNull();
  });
});

describe('pooled per-user connections', () => {
  it('parallel first uses share one connection', async () => {
    await seedTokens();
    const [a, b, c] = await Promise.all([
      mcpClientManager.withUserConnection('okta', ALICE, async conn => conn),
      mcpClientManager.withUserConnection('okta', ALICE, async conn => conn),
      mcpClientManager.withUserConnection('okta', ALICE, async conn => conn)
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(mcpClientManager.userConnections.size).toBe(1);
  });
});

describe('tokens bound to the server endpoint', () => {
  it('removes every user token when the server is repointed or removed', async () => {
    await seedTokens();
    await writeUserTokens('bob', 'okta', { access_token: 'b', token_type: 'bearer' }, binding());

    // An unrelated change (the display name) keeps them.
    await mcpClientManager.initialize({ servers: [{ ...OKTA, name: 'Okta' }] });
    expect(await readUserTokens('alice', 'okta')).not.toBeNull();

    await mcpClientManager.initialize({
      servers: [{ ...OKTA, transport: { ...OKTA.transport, url: 'https://vendor.example/mcp' } }]
    });
    expect(await readUserTokens('alice', 'okta')).toBeNull();
    expect(await readUserTokens('bob', 'okta')).toBeNull();

    // Removal, too — a later server with the same id starts clean.
    await writeUserTokens(
      'alice',
      'okta',
      { access_token: 'x', token_type: 'bearer' },
      tokenBindingFor({
        ...OKTA,
        transport: { ...OKTA.transport, url: 'https://vendor.example/mcp' }
      })
    );
    await mcpClientManager.initialize({ servers: [] });
    expect(await readUserTokens('alice', 'okta')).toBeNull();
  });

  it('never sends tokens issued for the old endpoint to a new one', async () => {
    await seedTokens();
    const repointed = {
      ...OKTA,
      transport: { ...OKTA.transport, url: 'https://vendor.example/mcp' }
    };
    // A config changed while iHub was down: the file is still there.
    await mcpClientManager.shutdown();
    await mcpClientManager.initialize({ servers: [repointed] });
    expect(await readUserTokens('alice', 'okta')).not.toBeNull();
    await expect(mcpClientManager.connectionForUser('okta', ALICE)).rejects.toMatchObject({
      code: 'MCP_AUTH_REQUIRED'
    });
    await mcpClientManager.saveCatalog(repointed, [TOOL], { authoritative: true });
    expect(await call()).toMatchObject({ error: 'MCP_AUTH_REQUIRED' });
  });
});

describe('admin Test of an edited per-user draft', () => {
  const ADMIN = { id: 'admin', groups: ['admins'] };

  it("never probes an edited endpoint or auth block with the admin's token", async () => {
    await writeUserTokens(
      'admin',
      'okta',
      { access_token: 'admin-token', token_type: 'bearer' },
      binding()
    );
    for (const draft of [
      { ...OKTA, transport: { ...OKTA.transport, url: 'https://candidate.example/mcp' } },
      { ...OKTA, auth: { type: 'oauthUser', scopes: ['openid', 'admin'] } },
      { ...OKTA, id: 'brand-new' }
    ]) {
      expect(await mcpClientManager.testConfig(draft, ADMIN)).toMatchObject({
        status: 'auth_required',
        reason: 'unsaved_changes'
      });
    }
    // The live registration every user depends on is untouched.
    expect(await clientStore.get('okta')).toMatchObject({ clientId: 'dcr-client' });
    expect(await readUserTokens('admin', 'okta')).toMatchObject({ access_token: 'admin-token' });
  });
});

describe('shared tool catalog policy', () => {
  const ADMIN_TOOL = { name: 'reset-password', inputSchema: { type: 'object', properties: {} } };
  const USER_TOOL = { name: 'my-tickets', inputSchema: { type: 'object', properties: {} } };
  const toolIds = async () => (await mcpClientManager.listAllTools()).map(t => t.id).sort();

  it("a user's narrower listing never shrinks the catalog; an admin listing replaces it", async () => {
    const config = mcpClientManager.getConnection('okta').config;
    await mcpClientManager.saveCatalog(config, [TOOL, ADMIN_TOOL], { authoritative: true });
    await mcpClientManager.saveCatalog(config, [TOOL]);
    expect(await toolIds()).toEqual(['okta__get-current-user', 'okta__reset-password']);

    // New tools a user sees are added.
    await mcpClientManager.saveCatalog(config, [TOOL, USER_TOOL]);
    expect(await toolIds()).toEqual([
      'okta__get-current-user',
      'okta__my-tickets',
      'okta__reset-password'
    ]);

    await mcpClientManager.saveCatalog(config, [TOOL], { authoritative: true });
    expect(await toolIds()).toEqual(['okta__get-current-user']);
  });

  it('only admin connections list authoritatively', async () => {
    await seedTokens();
    const entry = mcpClientManager._userConnection(
      mcpClientManager.getConnection('okta').config,
      'alice'
    );
    expect(entry.authoritativeCatalog).toBe(false);
    const admin = mcpClientManager._userConnection(
      mcpClientManager.getConnection('okta').config,
      'admin',
      { authoritativeCatalog: true }
    );
    expect(admin.authoritativeCatalog).toBe(true);
  });
});

describe('chat projection of an MCP App tool that needs a sign-in', () => {
  it('records no view for a call that never reached the server', async () => {
    const frames = [];
    const views = [];
    const seam = chatToolSeam({
      chatId: 'chat-1',
      buildLogData: () => ({}),
      logInteraction: async () => {},
      mcpAppViews: views,
      mcpAuthPrompts: []
    });
    const ctx = { iteration: 1, meta: { stream: { emit: (type, data) => frames.push(data) } } };
    const info = {
      call: { id: 'c1' },
      toolId: 'okta__draw',
      name: 'okta__draw',
      args: {},
      toolDef: {
        _mcp: { serverId: 'okta', originalName: 'draw', ui: { resourceUri: 'ui://okta/view' } }
      }
    };
    await seam.postTool(ctx, info, {
      rawResult: {
        error: 'MCP_AUTH_REQUIRED',
        authRequired: { serverId: 'okta', serverName: 'Okta', connectUrl: '/api/mcp/x' }
      },
      message: { content: '' },
      durationMs: 1
    });
    expect(views).toEqual([]);
    expect(frames[0].mcpApp).toBeUndefined();
    expect(frames[0].authRequired).toMatchObject({ serverId: 'okta' });
  });
});
