/**
 * Governance for clients identified by a metadata document.
 *
 * Four properties this suite exists to keep true:
 *
 * - **A block is a block.** Blocking a client revokes every connection it has
 *   and makes the gateway refuse the tokens it already holds on the next
 *   request — not merely the next authorization.
 * - **A refusal costs no outbound request.** A blocked host is refused before
 *   the server would fetch anything for it, which is the same rule the host
 *   allowlist has always had.
 * - **An unknown client does not connect.** With the shipped default the first
 *   `client_id` nobody has approved is refused and becomes a pending row, and
 *   approving that row lets the very same flow through.
 * - **Policy is per client and layered.** Narrowing one client's groups or
 *   apps leaves every other client on the same host alone, and a field nobody
 *   set still inherits the global default.
 *
 * Native-ESM jest (`NODE_OPTIONS=--experimental-vm-modules`); see the
 * `test:oauth` npm script, which `test:quick` chains in.
 */

import { jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import os from 'os';
import path from 'path';
import { mkdtempSync } from 'fs';

const state = {
  rootDir: mkdtempSync(path.join(os.tmpdir(), 'ihub-cimd-gov-')),
  platform: {},
  responses: new Map(),
  fetchCalls: [],
  token: null
};

// The clients file lives outside `contents/` on purpose: `locateConfigFile`
// then writes it directly instead of through the configuration store, so the
// store does not have to be stood up for a test about policy records.
const CLIENTS_FILE = path.join(state.rootDir, 'oauth-clients.json');

jest.unstable_mockModule('../pathUtils.js', () => ({
  getRootDir: () => state.rootDir
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => state.platform,
    get: () => null,
    setCacheEntry: () => {},
    getAppsForUser: () => [],
    // `{ data: ... }`, not a bare groups object: `loadGroupsConfiguration`
    // checks `cached?.data` and falls back to reading contents/config/groups.json
    // from disk when it is missing — which passes on a developer machine that
    // has a contents/ directory and fails on a fresh checkout.
    getGroups: () => ({ data: { groups: {} } })
  }
}));

jest.unstable_mockModule('../configSync.js', () => ({
  announceConfigChange: () => {}
}));

jest.unstable_mockModule('../services/AuditLogService.js', () => ({
  logAudit: () => {}
}));

jest.unstable_mockModule('../middleware/adminAuth.js', () => ({
  adminAuth: (req, res, next) => {
    req.user = { id: 'admin' };
    next();
  }
}));

jest.unstable_mockModule('../utils/ssrfGuard.js', () => ({
  assertPublicTarget: async () => ({ ok: true, addresses: ['203.0.113.10'] }),
  createPinnedLookup: () => () => {}
}));

jest.unstable_mockModule('../utils/httpConfig.js', () => ({
  httpFetch: async url => {
    state.fetchCalls.push(url);
    const canned = state.responses.get(url);
    if (!canned) throw new Error('ECONNREFUSED');
    return {
      status: 200,
      ok: true,
      headers: { get: name => canned.headers[name.toLowerCase()] ?? null },
      text: async () => canned.body
    };
  }
}));

jest.unstable_mockModule('../services/TokenStorageService.js', () => ({
  default: { getPublicKey: () => null, getPrivateKey: () => null }
}));

// The gateway test is about policy, not about token cryptography: the token is
// whatever the test says it is. The rest of the module's surface is stubbed
// because other modules in the import graph name those exports.
const notUsedHere = () => {
  throw new Error('oauthTokenService is stubbed in this suite');
};
jest.unstable_mockModule('../utils/oauthTokenService.js', () => ({
  verifyOAuthToken: () => state.token,
  isCurrentKeyGeneration: () => true,
  isPersonalClient: () => false,
  generateOAuthToken: notUsedHere,
  introspectOAuthToken: notUsedHere,
  generateStaticApiKey: notUsedHere,
  generatePersonalApiKey: notUsedHere,
  personalKeyGeneration: () => 0,
  validateScopes: () => true,
  validateAppAccess: () => true,
  validateModelAccess: () => true
}));

const { clearClientMetadataCache, isHostBlocked } = await import('../utils/clientIdMetadata.js');
const { buildPolicyCimdClient, resolveOAuthClient, getCimdConfig } =
  await import('../utils/oauthClientResolver.js');
const {
  approvalSatisfied,
  effectiveField,
  evaluateCimdActivation,
  intersectScopes,
  isUserAllowedByGroups
} = await import('../utils/oauthClientPolicy.js');
const {
  upsertCimdClientPolicy,
  findCimdClientPolicy,
  listCimdClientPolicies,
  validateClientCredentials
} = await import('../utils/oauthClientManager.js');
const { grantConsent, listConsents } = await import('../utils/consentStore.js');
const { generateRefreshToken, storeRefreshToken, listRefreshTokenUserIds } =
  await import('../utils/refreshTokenStore.js');
const { revokeConnectionsForClient } = await import('../services/oauth/ConnectionService.js');
const { listCimdClientRows, recordCimdDiscovery } =
  await import('../services/oauth/CimdGovernanceService.js');
const { default: registerAdminOAuthCimdRoutes } =
  await import('../routes/admin/oauthCimdClients.js');
const { default: registerOAuthAuthorizeRoutes } = await import('../routes/oauthAuthorize.js');
const { default: mcpAuth } = await import('../middleware/mcpAuth.js');

const CODE_URL = 'https://claude.ai/oauth/claude-code-client-metadata';
const WEB_URL = 'https://claude.ai/oauth/claude-web-client-metadata';

const doc = (url, name) => ({
  client_id: url,
  client_name: name,
  client_uri: 'https://claude.ai',
  redirect_uris: ['http://localhost/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none'
});

function serve(url, name) {
  state.responses.set(url, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(doc(url, name))
  });
}

function setPlatform({ hosts = ['claude.ai'], blocked = [], approvalMode = 'auto', ...rest } = {}) {
  state.platform = {
    oauth: {
      enabled: { authz: true, clients: true },
      clientsFile: CLIENTS_FILE,
      defaultTokenExpirationMinutes: 60,
      cimd: {
        enabled: true,
        allowedClientHosts: hosts,
        blockedClientHosts: blocked,
        approvalMode,
        ...rest
      }
    },
    mcpServer: { enabled: true },
    auth: { mode: 'local' }
  };
}

async function resetClientStore() {
  const fs = await import('fs');
  fs.writeFileSync(
    CLIENTS_FILE,
    JSON.stringify({ clients: {}, metadata: { version: '1.0.0' } }, null, 2)
  );
}

async function resetStores() {
  const fs = await import('fs');
  // The stores resolve their path from `config.CONTENTS_DIR`, so this must too
  // — hardcoding 'contents' makes the suite silently stop resetting anything
  // when CONTENTS_DIR is set.
  const { default: serverConfig } = await import('../config.js');
  const dataDir = path.join(state.rootDir, serverConfig.CONTENTS_DIR, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'oauth-consent.json'), JSON.stringify({ consents: {} }));
  fs.writeFileSync(path.join(dataDir, 'oauth-refresh-tokens.json'), JSON.stringify({ tokens: {} }));
}

beforeEach(async () => {
  clearClientMetadataCache();
  state.responses.clear();
  state.fetchCalls = [];
  state.token = null;
  setPlatform();
  await resetClientStore();
  await resetStores();
});

describe('blocked hosts', () => {
  test('matches the same patterns the allowlist does', () => {
    expect(isHostBlocked(CODE_URL, ['claude.ai'])).toBe(true);
    expect(isHostBlocked(CODE_URL, ['*.claude.ai'])).toBe(false);
    expect(isHostBlocked('https://mcp.claude.ai/doc', ['*.claude.ai'])).toBe(true);
    expect(isHostBlocked(CODE_URL, [])).toBe(false);
  });

  test('wins over the allowlist and causes no outbound request', async () => {
    setPlatform({ hosts: ['claude.ai'], blocked: ['claude.ai'] });
    serve(CODE_URL, 'Claude Code');

    const resolved = await resolveOAuthClient(CODE_URL, state.platform, { allowFetch: true });

    expect(resolved.ok).toBe(false);
    expect(resolved.code).toBe('host_blocked');
    expect(state.fetchCalls).toHaveLength(0);
    expect(buildPolicyCimdClient(CODE_URL, state.platform)).toBeNull();
  });
});

describe('blocking one client', () => {
  test('refuses it at authorize and on the request path, leaving its neighbour alone', async () => {
    await upsertCimdClientPolicy(CODE_URL, { active: false }, CLIENTS_FILE, 'admin');
    serve(CODE_URL, 'Claude Code');
    serve(WEB_URL, 'Claude');

    const blockedClient = await resolveOAuthClient(CODE_URL, state.platform, { allowFetch: true });
    expect(blockedClient.ok).toBe(false);
    expect(blockedClient.code).toBe('client_blocked');
    // A blocked client must not make the server fetch its document either.
    expect(state.fetchCalls).toHaveLength(0);
    expect(buildPolicyCimdClient(CODE_URL, state.platform)).toBeNull();

    const neighbour = await resolveOAuthClient(WEB_URL, state.platform, { allowFetch: true });
    expect(neighbour.ok).toBe(true);
    expect(neighbour.client.active).toBe(true);
  });

  test('a policy record never carries a secret and can never be trusted', async () => {
    const record = await upsertCimdClientPolicy(
      CODE_URL,
      { active: true, trusted: true, consentRequired: false, clientSecret: 'nope' },
      CLIENTS_FILE,
      'admin'
    );

    expect(record.trusted).toBe(false);
    expect(record.consentRequired).toBe(true);
    expect(record.clientSecret).toBeNull();
  });

  test('a policy record cannot be used as client credentials', async () => {
    await upsertCimdClientPolicy(CODE_URL, { active: true }, CLIENTS_FILE, 'admin');

    // bcrypt throws rather than returning false when handed a null hash, so
    // this is a 500 on the token endpoint if the refusal is not explicit.
    await expect(validateClientCredentials(CODE_URL, 'anything', CLIENTS_FILE)).resolves.toBeNull();
  });

  test('refuses to write a record for a non-URL client id', async () => {
    await expect(
      upsertCimdClientPolicy('client_reporting_a1b2', { active: false }, CLIENTS_FILE, 'admin')
    ).rejects.toThrow(/https client_id/);
  });
});

describe('bulk revocation', () => {
  test('clears consents and refresh tokens for every user of a client', async () => {
    await grantConsent(CODE_URL, 'alice', ['openid'], 90, { clientKind: 'cimd' });
    await grantConsent(CODE_URL, 'bob', ['openid'], 90, { clientKind: 'cimd' });
    await grantConsent(WEB_URL, 'alice', ['openid'], 90, { clientKind: 'cimd' });
    await storeRefreshToken(generateRefreshToken(), { clientId: CODE_URL, userId: 'alice' }, 30);
    await storeRefreshToken(generateRefreshToken(), { clientId: CODE_URL, userId: 'bob' }, 30);
    await storeRefreshToken(generateRefreshToken(), { clientId: WEB_URL, userId: 'alice' }, 30);

    const result = await revokeConnectionsForClient(CODE_URL);

    expect(result.connectionsRevoked).toBe(2);
    expect(result.refreshTokensRevoked).toBe(2);
    expect(listConsents({ clientId: CODE_URL })).toHaveLength(0);
    expect(listRefreshTokenUserIds(CODE_URL)).toHaveLength(0);
    // The other client on the same host keeps its connection.
    expect(listConsents({ clientId: WEB_URL })).toHaveLength(1);
    expect(listRefreshTokenUserIds(WEB_URL)).toEqual(['alice']);
  });

  test('also revokes a user whose consent lapsed but whose refresh token is live', async () => {
    await storeRefreshToken(generateRefreshToken(), { clientId: CODE_URL, userId: 'carol' }, 30);

    const result = await revokeConnectionsForClient(CODE_URL);

    expect(result.connectionsRevoked).toBe(1);
    expect(result.refreshTokensRevoked).toBe(1);
  });
});

describe('the admin API', () => {
  function buildApp() {
    const app = express();
    app.use(express.json());
    registerAdminOAuthCimdRoutes(app);
    return app;
  }

  const encode = value => Buffer.from(value, 'utf8').toString('base64url');

  test('blocking through the API revokes the connections in the same action', async () => {
    await grantConsent(CODE_URL, 'alice', ['openid'], 90, {
      clientKind: 'cimd',
      clientName: 'Claude Code'
    });
    await storeRefreshToken(generateRefreshToken(), { clientId: CODE_URL, userId: 'alice' }, 30);

    const res = await request(buildApp())
      .put(`/api/admin/oauth/clients/cimd/${encode(CODE_URL)}`)
      .send({ active: false });

    expect(res.status).toBe(200);
    expect(res.body.revoked.connectionsRevoked).toBe(1);
    expect(res.body.revoked.refreshTokensRevoked).toBe(1);
    expect(findCimdClientPolicy(CODE_URL, CLIENTS_FILE).active).toBe(false);
    expect(listConsents({ clientId: CODE_URL })).toHaveLength(0);
  });

  test('revoke-all is available for any client id, encoded in the path', async () => {
    await grantConsent(CODE_URL, 'alice', ['openid'], 90, { clientKind: 'cimd' });
    await grantConsent('client_reporting_a1b2', 'bob', ['openid'], 90, {});

    const res = await request(buildApp()).delete(
      `/api/admin/oauth/clients/${encode(CODE_URL)}/connections`
    );

    expect(res.status).toBe(200);
    expect(res.body.connectionsRevoked).toBe(1);
    expect(listConsents({ clientId: 'client_reporting_a1b2' })).toHaveLength(1);
  });

  test('refuses an identifier that does not decode to a client URL', async () => {
    const res = await request(buildApp())
      .put(`/api/admin/oauth/clients/cimd/${encode('../../etc/passwd')}`)
      .send({ active: false });

    expect(res.status).toBe(400);
  });

  test('refuses a policy field that is not a list of strings', async () => {
    const res = await request(buildApp())
      .put(`/api/admin/oauth/clients/cimd/${encode(CODE_URL)}`)
      .send({ allowedGroups: 'claude-code-users' });

    expect(res.status).toBe(400);
    expect(findCimdClientPolicy(CODE_URL, CLIENTS_FILE)).toBeNull();
  });

  test('accepts null to hand a field back to the global default', async () => {
    await upsertCimdClientPolicy(CODE_URL, { allowedApps: ['chat'] }, CLIENTS_FILE, 'admin');
    setPlatform({ allowedApps: ['chat', 'search'] });

    const res = await request(buildApp())
      .put(`/api/admin/oauth/clients/cimd/${encode(CODE_URL)}`)
      .send({ allowedApps: null });

    expect(res.status).toBe(200);
    expect(buildPolicyCimdClient(CODE_URL, state.platform).allowedApps).toEqual(['chat', 'search']);
  });

  test('lists a client people are connected through even with no record', async () => {
    await grantConsent(CODE_URL, 'alice', ['openid'], 90, {
      clientKind: 'cimd',
      clientName: 'Claude Code',
      clientHost: 'claude.ai'
    });

    const rows = listCimdClientRows(state.platform);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      clientId: CODE_URL,
      name: 'Claude Code',
      hasRecord: false,
      connectionCount: 1
    });
  });
});

describe('discovery records', () => {
  test('are written once and are idempotent', async () => {
    const first = await recordCimdDiscovery({
      clientId: CODE_URL,
      platform: state.platform,
      clientName: 'Claude Code',
      user: { sub: 'alice', name: 'Alice' }
    });
    const second = await recordCimdDiscovery({
      clientId: CODE_URL,
      platform: state.platform,
      clientName: 'Claude Code'
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(listCimdClientPolicies(CLIENTS_FILE)).toHaveLength(1);

    const record = findCimdClientPolicy(CODE_URL, CLIENTS_FILE);
    expect(record.approvalState).toBe('auto');
    expect(record.metadata.firstUserId).toBe('alice');
    expect(record.metadata.displayName).toBe('Claude Code');
  });

  test('never resurrect a client an administrator blocked', async () => {
    await upsertCimdClientPolicy(CODE_URL, { active: false }, CLIENTS_FILE, 'admin');

    await recordCimdDiscovery({ clientId: CODE_URL, platform: state.platform });

    expect(findCimdClientPolicy(CODE_URL, CLIENTS_FILE).active).toBe(false);
  });
});

describe('the approval gate', () => {
  function buildApp() {
    const app = express();
    registerOAuthAuthorizeRoutes(app);
    return app;
  }

  const authorizeUrl = clientId =>
    `/api/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent('http://localhost/callback')}` +
    '&code_challenge=abc&code_challenge_method=S256';

  test('is what the shipped default does, even for an allowed host', () => {
    // No `approvalMode` at all: the normalization has to pick the safe side.
    expect(
      getCimdConfig({ oauth: { enabled: { authz: true }, cimd: { enabled: true } } }).approvalMode
    ).toBe('approval');
  });

  test('refuses an unapproved client, names it, and leaves a pending row', async () => {
    setPlatform({ approvalMode: 'approval' });
    serve(CODE_URL, 'Claude Code');

    const res = await request(buildApp()).get(authorizeUrl(CODE_URL));

    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    // The page names the software so the user knows what to ask for.
    expect(res.text).toContain('Claude Code');
    expect(res.text).toContain('needs to be approved');

    const record = findCimdClientPolicy(CODE_URL, CLIENTS_FILE);
    expect(record.approvalState).toBe('pending');
    expect(record.active).toBe(false);
  });

  test('a pending client is refused again without fetching its document', async () => {
    setPlatform({ approvalMode: 'approval' });
    await upsertCimdClientPolicy(
      CODE_URL,
      { approvalState: 'pending', active: false, metadata: { displayName: 'Claude Code' } },
      CLIENTS_FILE,
      'admin'
    );
    serve(CODE_URL, 'Claude Code');

    const res = await request(buildApp()).get(authorizeUrl(CODE_URL));

    expect(res.status).toBe(403);
    expect(res.text).toContain('needs to be approved');
    expect(state.fetchCalls).toHaveLength(0);
  });

  test('approving lets the very same flow through', async () => {
    setPlatform({ approvalMode: 'approval' });
    serve(CODE_URL, 'Claude Code');

    await request(buildApp()).get(authorizeUrl(CODE_URL));
    await upsertCimdClientPolicy(
      CODE_URL,
      { approvalState: 'approved', active: true },
      CLIENTS_FILE,
      'admin'
    );

    const res = await request(buildApp()).get(authorizeUrl(CODE_URL));

    // Nobody is signed in, so the flow continues to the login page — which is
    // the step *after* the gate.
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/login');
  });

  test('a client blocked by an administrator gets the blocked page, not the pending one', async () => {
    setPlatform({ approvalMode: 'approval' });
    await upsertCimdClientPolicy(
      CODE_URL,
      { approvalState: 'approved', active: false, metadata: { displayName: 'Claude Code' } },
      CLIENTS_FILE,
      'admin'
    );

    const res = await request(buildApp()).get(authorizeUrl(CODE_URL));

    expect(res.status).toBe(403);
    expect(res.text).toContain('is blocked');
    expect(state.fetchCalls).toHaveLength(0);
  });

  test('an auto-stamped record still passes once approval is switched on', () => {
    expect(approvalSatisfied({ approvalState: 'auto' }, 'approval')).toBe(true);
    expect(approvalSatisfied({ approvalState: 'pending' }, 'approval')).toBe(false);
    expect(approvalSatisfied(null, 'approval')).toBe(false);
    expect(approvalSatisfied(null, 'auto')).toBe(true);
  });
});

describe('per-client policy', () => {
  test('layers field by field over the platform defaults', async () => {
    setPlatform({ allowedApps: ['shared-app'], allowedGroups: [] });
    await upsertCimdClientPolicy(
      CODE_URL,
      { allowedGroups: ['claude-code-users'] },
      CLIENTS_FILE,
      'admin'
    );
    serve(CODE_URL, 'Claude Code');
    serve(WEB_URL, 'Claude');

    const code = await resolveOAuthClient(CODE_URL, state.platform, { allowFetch: true });
    const web = await resolveOAuthClient(WEB_URL, state.platform, { allowFetch: true });

    expect(code.client.allowedGroups).toEqual(['claude-code-users']);
    // The field nobody set on this client still inherits the global list.
    expect(code.client.allowedApps).toEqual(['shared-app']);
    // And the neighbour on the same host is untouched.
    expect(web.client.allowedGroups).toEqual([]);
    expect(web.client.allowedApps).toEqual(['shared-app']);
  });

  test('an unset field inherits and an empty one does not', () => {
    const defaults = { allowedApps: ['a', 'b'] };
    expect(effectiveField(null, defaults, 'allowedApps')).toEqual(['a', 'b']);
    expect(effectiveField({}, defaults, 'allowedApps')).toEqual(['a', 'b']);
    expect(effectiveField({ allowedApps: null }, defaults, 'allowedApps')).toEqual(['a', 'b']);
    expect(effectiveField({ allowedApps: [] }, defaults, 'allowedApps')).toEqual([]);
  });

  test('narrows the apps of one client without touching another', async () => {
    await upsertCimdClientPolicy(CODE_URL, { allowedApps: ['chat'] }, CLIENTS_FILE, 'admin');
    setPlatform({ allowedApps: ['chat', 'search'] });

    expect(buildPolicyCimdClient(CODE_URL, state.platform).allowedApps).toEqual(['chat']);
    expect(buildPolicyCimdClient(WEB_URL, state.platform).allowedApps).toEqual(['chat', 'search']);
  });

  test('the group check is the same one everywhere', () => {
    expect(isUserAllowedByGroups({ allowedGroups: [] }, { groups: [] })).toBe(true);
    expect(isUserAllowedByGroups({ allowedGroups: ['*'] }, { groups: [] })).toBe(true);
    expect(isUserAllowedByGroups({ allowedGroups: ['devs'] }, { groups: ['devs'] })).toBe(true);
    expect(isUserAllowedByGroups({ allowedGroups: ['devs'] }, { groups: ['sales'] })).toBe(false);
    expect(isUserAllowedByGroups({ allowedGroups: ['devs'] }, {})).toBe(false);
  });

  test('narrowing grantable scopes narrows what a refresh may carry', () => {
    expect(intersectScopes(['openid', 'mcp:tools:call'], ['openid'])).toEqual(['openid']);
    // An empty grantable list is "nothing recorded", not "nothing allowed".
    expect(intersectScopes(['openid'], [])).toEqual(['openid']);
    expect(intersectScopes(['mcp:tools:call'], ['openid'])).toEqual([]);
  });

  test('every condition is re-evaluated, and the first failure is the one reported', () => {
    const cimdConfig = getCimdConfig(state.platform);
    expect(evaluateCimdActivation(CODE_URL, cimdConfig, null).active).toBe(true);
    expect(evaluateCimdActivation(CODE_URL, { ...cimdConfig, enabled: false }, null).code).toBe(
      'cimd_disabled'
    );
    expect(
      evaluateCimdActivation(
        CODE_URL,
        { ...cimdConfig, allowedClientHosts: ['other.example'] },
        null
      ).code
    ).toBe('host_not_allowed');
    expect(evaluateCimdActivation(CODE_URL, cimdConfig, { active: false }).code).toBe(
      'client_blocked'
    );
    expect(
      evaluateCimdActivation(CODE_URL, { ...cimdConfig, approvalMode: 'approval' }, null).code
    ).toBe('approval_pending');
  });
});

describe('the gateway', () => {
  function buildApp() {
    const app = express();
    app.get('/mcp', mcpAuth, (req, res) => res.json({ ok: true, user: req.user.id }));
    // Surfacing the error keeps a 500 from reading as "the policy refused it".
    app.use((error, req, res, _next) => res.status(500).json({ error: error.message }));
    return app;
  }

  const call = () => request(buildApp()).get('/mcp').set('Authorization', 'Bearer test-token');

  beforeEach(() => {
    state.token = {
      sub: 'alice',
      username: 'alice',
      groups: ['users'],
      client_id: CODE_URL,
      authMode: 'oauth_authorization_code',
      scopes: ['mcp:tools:call']
    };
  });

  test('accepts a token for a client that is still allowed', async () => {
    const res = await call();
    expect(res.status).toBe(200);
  });

  test('answers 401 for a blocked client, on the next request', async () => {
    await upsertCimdClientPolicy(CODE_URL, { active: false }, CLIENTS_FILE, 'admin');

    const res = await call();

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
  });

  test('answers 401 for a client that has not been approved', async () => {
    setPlatform({ approvalMode: 'approval' });

    const res = await call();

    expect(res.status).toBe(401);
  });

  test('answers 403 once the client no longer admits the user’s groups', async () => {
    await upsertCimdClientPolicy(
      CODE_URL,
      { allowedGroups: ['claude-code-users'] },
      CLIENTS_FILE,
      'admin'
    );

    const res = await call();

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('access_denied');
  });
});
