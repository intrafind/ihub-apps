/**
 * A session token is only as good as the user behind it.
 *
 * Every sign-in that mints an iHub JWT for a user of users.json - local, OIDC,
 * LDAP, Teams, NTLM - leaves a record there, and `jwtAuth` checks that record
 * on every request. This locks in, for each of those modes and for the
 * OAuth authorization-code token that is minted from such a session:
 *
 * - a token minted the way the provider mints it (the real persist + the real
 *   `generateJwt`) resolves to the record it persisted, and is let through,
 * - a token whose user was deleted is refused with 401, for every mode alike -
 *   it used to fall through for everything but local - and a disabled user with
 *   403,
 * - the refusal drops the httpOnly session cookie and lets the auth endpoints
 *   (status, logins, logout) carry on, so the person is not locked out of
 *   signing in again,
 * - a record that another cluster worker persisted a moment ago, which this
 *   worker's cached copy does not have yet, is found by one re-read of the
 *   store instead of being taken for a deleted account,
 * - a users file that cannot be read answers 503 rather than "deleted".
 *
 * Native-ESM jest; see the `test:auth-routes` npm script.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SECRET = 'jwt-persisted-user-validation-secret';
process.env.JWT_SECRET = SECRET;

const USERS_KEY = 'config/users.json';
const CLIENTS_KEY = 'config/oauth-clients.json';

const state = {
  platform: {},
  cache: null, // this worker's copy of users.json
  disk: null, // the shared users.json
  clients: null, // oauth-clients.json
  storeUnreadable: false,
  cacheReadFails: false,
  storeReads: 0
};

const clone = value => (value === null || value === undefined ? value : structuredClone(value));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getPlatform: () => state.platform,
    get: key => {
      if (key === USERS_KEY) {
        if (state.cacheReadFails) throw new Error('cache entry is corrupt');
        return state.cache ? { data: state.cache } : null;
      }
      if (key === CLIENTS_KEY) return { data: state.clients };
      return null;
    },
    setCacheEntry: (key, data) => {
      if (key === USERS_KEY) state.cache = clone(data);
    },
    getGroups: () => ({ data: { groups: {} } }),
    getAppsForUser: () => []
  }
}));

jest.unstable_mockModule('../services/config/ConfigStore.js', () => ({
  default: {
    readJson: () => Promise.resolve(clone(state.disk)),
    readJsonStrict: () => {
      state.storeReads += 1;
      if (state.storeUnreadable) return Promise.reject(new Error('users.json is unreadable'));
      return Promise.resolve(clone(state.disk));
    },
    writeJson: (_relPath, data) => {
      state.disk = clone(data);
      return Promise.resolve();
    }
  }
}));

jest.unstable_mockModule('../configSync.js', () => ({
  // As outside cluster mode: nobody to tell, so nothing was sent.
  announceConfigChange: () => false
}));

// Not under test: promotes the first user to admin when no admin exists.
jest.unstable_mockModule('../utils/adminRescue.js', () => ({
  ensureFirstUserIsAdmin: user => Promise.resolve(user)
}));

jest.unstable_mockModule('../services/TokenStorageService.js', () => ({
  default: { getJwtSecret: () => SECRET, getRSAPrivateKey: () => null, getRSAPublicKey: () => null }
}));

const { default: jwtAuth } = await import('../middleware/jwtAuth.js');
const { processNtlmLogin } = await import('../middleware/ntlmAuth.js');
const { validateAndPersistExternalUser, loadUsersFresh } = await import('../utils/userManager.js');
const { generateJwt } = await import('../utils/tokenService.js');
const { generatePersonalApiKey } = await import('../utils/oauthTokenService.js');

/** What each provider hands to `validateAndPersistExternalUser`. */
const EXTERNAL_USERS = {
  oidc: {
    id: 'idp-subject-1',
    username: 'jdoe',
    name: 'Jane Doe',
    email: 'jane@example.com',
    provider: 'corp-sso',
    groups: ['authenticated'],
    externalGroups: []
  },
  ldap: {
    id: 'ldap-subject-1',
    username: 'jdoe',
    name: 'Jane Doe',
    email: 'jane@example.com',
    authMethod: 'ldap',
    provider: 'corp-ldap',
    groups: ['authenticated'],
    ldapData: { subject: 'ldap-subject-1', username: 'jdoe' }
  },
  teams: {
    id: 'aad-object-id-1',
    username: 'jane@example.com',
    name: 'Jane Doe',
    email: 'jane@example.com',
    provider: 'teams',
    groups: ['authenticated'],
    teamsData: { tenantId: 'tenant-1', upn: 'jane@example.com' }
  },
  ntlm: {
    id: 'CORP\\jdoe',
    username: 'jdoe',
    name: 'Jane Doe',
    email: 'jane@example.com',
    domain: 'CORP',
    authMethod: 'ntlm',
    provider: 'ntlm',
    groups: ['authenticated']
  }
};

const SSO_MODES = Object.keys(EXTERNAL_USERS);

function emptyUsersFile() {
  return { users: {}, metadata: { version: '2.0.0' } };
}

/** Sign in as the provider does: persist, then mint the token from the result. */
async function signIn(mode) {
  const persisted = await validateAndPersistExternalUser(EXTERNAL_USERS[mode], state.platform);
  const { token } = generateJwt(persisted, {
    authMode: mode,
    authProvider: persisted.provider,
    additionalClaims: mode === 'ntlm' ? { domain: persisted.domain } : undefined
  });
  return { token, userId: persisted.id };
}

function makeRes() {
  const res = { statusCode: 200, body: undefined, clearedCookies: [], ended: false };
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.json = body => {
    res.body = body;
    res.ended = true;
    return res;
  };
  res.clearCookie = name => {
    res.clearedCookies.push(name);
  };
  return res;
}

/** Send one request through the real middleware. */
async function request(token, { path = '/api/apps', viaCookie = false } = {}) {
  const req = {
    headers: viaCookie ? {} : { authorization: `Bearer ${token}` },
    cookies: viaCookie ? { authToken: token } : {},
    path,
    method: 'GET',
    protocol: 'http',
    get: () => undefined
  };
  const res = makeRes();
  let nextCalled = false;
  await jwtAuth(req, res, () => {
    nextCalled = true;
  });
  return { req, res, nextCalled };
}

/** Delete a user from the shared file and from this worker's copy. */
function deleteUser(userId) {
  delete state.disk.users[userId];
  delete state.cache.users[userId];
}

beforeEach(() => {
  state.platform = {
    jwt: { algorithm: 'HS256' },
    auth: { mode: 'local' },
    localAuth: { enabled: true },
    oidcAuth: { enabled: true, allowSelfSignup: true },
    ldapAuth: { enabled: true },
    teamsAuth: { enabled: true, allowSelfSignup: true },
    ntlmAuth: { enabled: true },
    oauth: { enabled: { authz: true, clients: true } }
  };
  state.disk = emptyUsersFile();
  // The cache starts authoritative so loadUsers never reaches for a users.json
  // on the machine running the tests.
  state.cache = emptyUsersFile();
  state.clients = {
    clients: { 'mcp-client': { clientId: 'mcp-client', active: true } },
    metadata: {}
  };
  state.storeUnreadable = false;
  state.cacheReadFails = false;
  state.storeReads = 0;
});

describe.each(SSO_MODES)('%s token', mode => {
  it('resolves to the record the sign-in persisted and is let through', async () => {
    const { token, userId } = await signIn(mode);
    expect(state.disk.users[userId]).toBeDefined();

    const { req, res, nextCalled } = await request(token);

    expect(nextCalled).toBe(true);
    expect(res.ended).toBe(false);
    expect(req.user.id).toBe(userId);
    expect(req.user.authMode).toBe(mode);
  });

  it('works the same when it arrives as the session cookie', async () => {
    const { token, userId } = await signIn(mode);

    const { req, nextCalled } = await request(token, { viaCookie: true });

    expect(nextCalled).toBe(true);
    expect(req.user.id).toBe(userId);
  });

  it('is refused with 401 once the user has been deleted', async () => {
    const { token, userId } = await signIn(mode);
    deleteUser(userId);

    const { req, res, nextCalled } = await request(token);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({
      error: 'invalid_token',
      error_description: 'User account no longer exists'
    });
    expect(nextCalled).toBe(false);
    expect(req.user).toBeUndefined();
  });

  it('is refused with 403 once the user has been disabled', async () => {
    const { token, userId } = await signIn(mode);
    state.cache.users[userId].active = false;
    state.disk.users[userId].active = false;

    const { res, nextCalled } = await request(token);

    expect(res.statusCode).toBe(403);
    expect(res.body.error_description).toBe('User account has been disabled');
    expect(nextCalled).toBe(false);
  });

  it('drops the session cookie when the user is gone', async () => {
    const { token, userId } = await signIn(mode);
    deleteUser(userId);

    const { res } = await request(token, { viaCookie: true });

    expect(res.clearedCookies).toContain('authToken');
  });

  it.each(['/api/auth/status', '/api/auth/logout', '/api/auth/local/login'])(
    'lets %s carry on without a user when the user is gone, so they can sign in again',
    async path => {
      const { token, userId } = await signIn(mode);
      deleteUser(userId);

      const { req, res, nextCalled } = await request(token, { path, viaCookie: true });

      expect(nextCalled).toBe(true);
      expect(res.ended).toBe(false);
      expect(req.user).toBeUndefined();
      expect(res.clearedCookies).toContain('authToken');
    }
  );

  it('finds a user another worker persisted that this worker has not heard about yet', async () => {
    const { token, userId } = await signIn(mode);
    // This worker's copy predates the write; the shared file has it.
    state.cache = emptyUsersFile();
    state.storeReads = 0;

    const { req, nextCalled } = await request(token);

    expect(nextCalled).toBe(true);
    expect(req.user.id).toBe(userId);
    expect(state.storeReads).toBe(1);
    // The worker caught up, so the next request costs no read.
    expect(state.cache.users[userId]).toBeDefined();
    await request(token);
    expect(state.storeReads).toBe(1);
  });

  it('does not re-read the store for a user this worker already has', async () => {
    const { token } = await signIn(mode);
    state.storeReads = 0;

    await request(token);

    expect(state.storeReads).toBe(0);
  });

  it('answers 503, not "deleted", when the store cannot be read to check', async () => {
    const { token, userId } = await signIn(mode);
    // Not in this worker's copy, and the store is down.
    state.cache = emptyUsersFile();
    state.storeUnreadable = true;
    expect(state.disk.users[userId]).toBeDefined();

    const { res, nextCalled } = await request(token);

    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe('service_unavailable');
    expect(nextCalled).toBe(false);
    expect(res.clearedCookies).toEqual([]);
  });

  it('answers 503, not "deleted", when the cached users cannot be loaded', async () => {
    const { token } = await signIn(mode);
    state.cacheReadFails = true;

    const { res, nextCalled } = await request(token);

    expect(res.statusCode).toBe(503);
    expect(nextCalled).toBe(false);
    expect(res.clearedCookies).toEqual([]);
  });

  it('is not revived by a later account for the same person', async () => {
    const first = await signIn(mode);
    deleteUser(first.userId);
    // The same person signs in again: same email, same provider subject, a new account.
    const second = await signIn(mode);
    expect(second.userId).not.toBe(first.userId);

    const old = await request(first.token);
    const current = await request(second.token);

    expect(old.res.statusCode).toBe(401);
    expect(old.nextCalled).toBe(false);
    expect(current.nextCalled).toBe(true);
    expect(current.req.user.id).toBe(second.userId);
  });

  it('still resolves a token whose subject is the provider subject (older sessions)', async () => {
    const { userId } = await signIn(mode);
    const external = EXTERNAL_USERS[mode];
    const { token } = generateJwt(
      { id: external.id, username: external.username, email: external.email, groups: [] },
      { authMode: mode }
    );

    const { req, nextCalled } = await request(token);

    expect(state.disk.users[userId]).toBeDefined();
    expect(nextCalled).toBe(true);
    expect(req.user.id).toBe(external.id);
  });

  it('does not match a record that has no provider subject at all', async () => {
    state.disk.users.user_without_provider_data = {
      id: 'user_without_provider_data',
      username: 'plain',
      active: true,
      authMethods: [mode]
    };
    state.cache = clone(state.disk);
    const { token } = generateJwt(
      { id: `${mode}-someone-else`, username: 'x', email: 'x@example.com', groups: [] },
      { authMode: mode }
    );

    const { res, nextCalled } = await request(token);

    expect(res.statusCode).toBe(401);
    expect(nextCalled).toBe(false);
  });

  it('is refused when the user was never persisted at all', async () => {
    const { token } = generateJwt(
      { id: `${mode}-never-persisted`, username: 'ghost', email: 'ghost@example.com', groups: [] },
      { authMode: mode }
    );

    const { res, nextCalled } = await request(token);

    expect(res.statusCode).toBe(401);
    expect(nextCalled).toBe(false);
  });
});

describe('local token', () => {
  function addLocalUser(overrides = {}) {
    const record = {
      id: 'user_local_1',
      username: 'jdoe',
      email: 'jane@example.com',
      name: 'Jane Doe',
      active: true,
      authMethods: ['local'],
      internalGroups: [],
      ...overrides
    };
    state.disk.users[record.id] = clone(record);
    state.cache.users[record.id] = clone(record);
    const { token } = generateJwt(record, { authMode: 'local' });
    return { token, userId: record.id };
  }

  it('is let through while the user exists', async () => {
    const { token, userId } = addLocalUser();

    const { req, nextCalled } = await request(token);

    expect(nextCalled).toBe(true);
    expect(req.user.id).toBe(userId);
    expect(req.user.authMode).toBe('local');
  });

  it('is refused with 401, drops the cookie and spares the auth endpoints once the user is gone', async () => {
    const { token, userId } = addLocalUser();
    deleteUser(userId);

    const api = await request(token, { viaCookie: true });
    expect(api.res.statusCode).toBe(401);
    expect(api.res.clearedCookies).toContain('authToken');

    for (const path of ['/api/auth/status', '/api/auth/logout', '/api/auth/local/login']) {
      const bootstrap = await request(token, { path, viaCookie: true });
      expect(bootstrap.nextCalled).toBe(true);
      expect(bootstrap.req.user).toBeUndefined();
    }
  });

  it('is refused with 403 once the user is disabled', async () => {
    const { token } = addLocalUser({ active: false });

    const { res } = await request(token);

    expect(res.statusCode).toBe(403);
  });

  it('finds a user created on another worker', async () => {
    const { token } = addLocalUser();
    state.cache = emptyUsersFile();

    const { nextCalled } = await request(token);

    expect(nextCalled).toBe(true);
  });

  it('answers 503, not "deleted", when the users file cannot be loaded', async () => {
    const { token } = addLocalUser();
    state.cacheReadFails = true;

    const { res } = await request(token);

    expect(res.statusCode).toBe(503);
  });
});

describe('OAuth authorization-code token', () => {
  const mint = userId =>
    generateJwt(
      { id: userId, username: 'jdoe', name: 'Jane Doe', email: 'jane@example.com', groups: [] },
      {
        authMode: 'oauth_authorization_code',
        additionalClaims: { client_id: 'mcp-client', scopes: [], aud: 'mcp-client' }
      }
    ).token;

  it('is let through while the user it was minted for exists', async () => {
    const { userId } = await signIn('oidc');

    const { req, nextCalled } = await request(mint(userId));

    expect(nextCalled).toBe(true);
    expect(req.user.isOAuthAuthCode).toBe(true);
    expect(req.user.id).toBe(userId);
  });

  it('stops working when that user is deleted, however fresh the token is', async () => {
    const { userId } = await signIn('oidc');
    deleteUser(userId);

    const { res, nextCalled } = await request(mint(userId));

    expect(res.statusCode).toBe(401);
    expect(res.body.error_description).toBe('User account no longer exists');
    expect(nextCalled).toBe(false);
  });

  it('is refused with 403 when the user is disabled', async () => {
    const { userId } = await signIn('ldap');
    state.cache.users[userId].active = false;

    const { res } = await request(mint(userId));

    expect(res.statusCode).toBe(403);
  });
});

describe('NTLM login', () => {
  const ntlmConfig = { enabled: true, domain: 'CORP' };
  const ntlmRequest = () => ({
    ntlm: {
      Authenticated: true,
      DomainName: 'CORP',
      UserName: 'jdoe',
      Workstation: 'WS-01'
    },
    headers: {}
  });

  it('issues a token the middleware accepts, for the user it persisted', async () => {
    const { token, user } = await processNtlmLogin(ntlmRequest(), ntlmConfig);

    expect(state.disk.users[user.id]).toBeDefined();
    const { req, nextCalled } = await request(token);

    expect(nextCalled).toBe(true);
    expect(req.user.id).toBe(user.id);
    expect(req.user.authMode).toBe('ntlm');
  });

  it('does not issue a token when the user cannot be persisted', async () => {
    // Self-signup is allowed for NTLM unless the admin turned it off.
    state.platform.ntlmAuth = { enabled: true, allowSelfSignup: false };

    await expect(processNtlmLogin(ntlmRequest(), ntlmConfig)).rejects.toThrow(
      /registration is not allowed/
    );
    expect(Object.keys(state.disk.users)).toHaveLength(0);
  });

  it('does not issue a token to a disabled user', async () => {
    const { user } = await processNtlmLogin(ntlmRequest(), ntlmConfig);
    state.disk.users[user.id].active = false;
    state.cache.users[user.id].active = false;

    await expect(processNtlmLogin(ntlmRequest(), ntlmConfig)).rejects.toThrow(/disabled/);
  });
});

describe('loadUsersFresh for a users file outside contents/', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ihub-users-fresh-'));
  const file = path.join(dir, 'users.json');

  it('reads the file itself, not the store', async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ users: { u1: { id: 'u1', active: true } }, metadata: {} })
    );
    state.storeReads = 0;

    const usersConfig = await loadUsersFresh(file);

    expect(usersConfig.users.u1).toBeDefined();
    expect(state.storeReads).toBe(0);
  });

  it('rejects, rather than reporting no users, when the file is unreadable', async () => {
    fs.writeFileSync(file, '{ not json');

    await expect(loadUsersFresh(file)).rejects.toThrow();
  });

  it('treats a missing file as no users', async () => {
    fs.rmSync(file, { force: true });

    const usersConfig = await loadUsersFresh(file);

    expect(usersConfig.users).toEqual({});
  });
});

describe('personal API key', () => {
  // A key is its owner's credential. It authenticates from its client record
  // alone, so nothing about the token names a user to look up: the owner on the
  // record is what has to be checked.
  const OWNER_ID = 'user_owner';

  /** A signed-in local user who has minted a key for themselves. */
  function ownerWithKey() {
    const owner = {
      id: OWNER_ID,
      username: 'owner',
      name: 'Owner',
      email: 'owner@example.com',
      active: true,
      authMethods: ['local'],
      groups: ['authenticated']
    };
    state.disk.users[OWNER_ID] = clone(owner);
    state.cache.users[OWNER_ID] = clone(owner);

    state.platform.oauth = {
      enabled: { authz: true, clients: true },
      personalKeys: { enabled: true }
    };
    const client = {
      clientId: 'key-owner-1',
      name: 'Owner key',
      active: true,
      personal: true,
      ownerUserId: OWNER_ID,
      ownerUsername: 'owner',
      ownerName: 'Owner',
      ownerGroups: ['authenticated'],
      scopes: ['mcp:tools'],
      metadata: {}
    };
    state.clients.clients[client.clientId] = client;
    return generatePersonalApiKey(client, 30).api_key;
  }

  it('is let through while its owner exists, acting as the owner', async () => {
    const { req, nextCalled } = await request(ownerWithKey());

    expect(nextCalled).toBe(true);
    expect(req.user).toMatchObject({ id: OWNER_ID, authMode: 'oauth_personal_key' });
  });

  it('is refused with 401 once its owner has been deleted, even with the key record still there', async () => {
    const key = ownerWithKey();
    deleteUser(OWNER_ID);

    const { res, nextCalled } = await request(key);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({
      error: 'invalid_token',
      error_description: 'The owner of this API key no longer exists'
    });
    expect(nextCalled).toBe(false);
  });

  it('is refused with 403 while its owner is disabled, and works again when they are not', async () => {
    const key = ownerWithKey();
    state.cache.users[OWNER_ID].active = false;

    const refused = await request(key);

    expect(refused.res.statusCode).toBe(403);
    expect(refused.res.body.error).toBe('access_denied');
    expect(refused.nextCalled).toBe(false);

    state.cache.users[OWNER_ID].active = true;
    expect((await request(key)).nextCalled).toBe(true);
  });

  it('finds an owner another worker created that this worker has not heard about yet', async () => {
    const key = ownerWithKey();
    state.cache = emptyUsersFile();

    const { nextCalled } = await request(key);

    expect(nextCalled).toBe(true);
    expect(state.storeReads).toBe(1);
  });

  it('answers 503, not "revoked", when the users cannot be read to check the owner', async () => {
    const key = ownerWithKey();
    state.cache = emptyUsersFile();
    state.storeUnreadable = true;

    const { res, nextCalled } = await request(key);

    expect(res.statusCode).toBe(503);
    expect(nextCalled).toBe(false);
  });

  it('is not let through for an owner who has only the same name or address', async () => {
    const key = ownerWithKey();
    deleteUser(OWNER_ID);
    // A later account for the same person: a different id.
    state.disk.users.user_replacement = state.cache.users.user_replacement = {
      id: 'user_replacement',
      username: 'owner',
      email: 'owner@example.com',
      active: true,
      authMethods: ['local']
    };

    const { res, nextCalled } = await request(key);

    expect(res.statusCode).toBe(401);
    expect(nextCalled).toBe(false);
  });
});
