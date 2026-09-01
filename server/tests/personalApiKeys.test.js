#!/usr/bin/env node

/**
 * Unit tests for personal API keys (`server/utils/personalApiKeyManager.js`).
 *
 * Run directly with `node server/tests/personalApiKeys.test.js`.
 *
 * The modules under test read `import.meta.url`, so they cannot run under the
 * root Jest config (which transpiles to CommonJS). This suite therefore runs as
 * native ESM under plain node, like the other tests in this directory.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import configCache from '../configCache.js';
import {
  buildPersonalKeyEndpoints,
  canUserManagePersonalKeys,
  createPersonalKey,
  getPersonalKeyConfig,
  isPersonalKeyExpired,
  isPersonalKeysEnabled,
  listPersonalKeys,
  revokePersonalKey,
  rotatePersonalKey
} from '../utils/personalApiKeyManager.js';
import {
  verifyOAuthToken,
  personalKeyGeneration,
  isCurrentKeyGeneration
} from '../utils/oauthTokenService.js';
import { loadOAuthClients, findClientById } from '../utils/oauthClientManager.js';
import { isAdminEligiblePrincipal } from '../utils/authorization.js';
import { isValidId } from '../utils/pathSecurity.js';

let failures = 0;

function check(label, expected, actual) {
  const ok = Object.is(expected, actual);
  if (!ok) failures += 1;
  console.log(`${ok ? '✅' : '❌'} ${label}`);
  if (!ok) {
    console.log(`   expected: ${JSON.stringify(expected)}`);
    console.log(`   actual:   ${JSON.stringify(actual)}`);
  }
}

async function checkRejects(label, status, promise) {
  try {
    await promise;
    failures += 1;
    console.log(`❌ ${label}`);
    console.log('   expected a rejection, but the call resolved');
  } catch (error) {
    check(label, status, error.status);
  }
}

// --- Test fixtures -------------------------------------------------------

const USER = {
  id: 'alice',
  username: 'alice',
  name: 'Alice Example',
  email: 'alice@example.com',
  groups: ['users', 'authenticated']
};

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-api-keys-'));
const clientsFile = path.join(tempDir, 'oauth-clients.json');

/**
 * A minimal in-memory stand-in for the config cache. The OAuth client store
 * reads and writes through it, and tokenService resolves the signing key from
 * the platform config it returns.
 */
const cacheEntries = new Map();
configCache.get = key => cacheEntries.get(key) || {};
configCache.setCacheEntry = (key, data) => {
  cacheEntries.set(key, { data });
};
configCache.getPlatform = () => cacheEntries.get('config/platform.json')?.data || {};

function platformConfig(personalKeys = {}, extra = {}) {
  return {
    // HS256 keeps the test independent of any RSA key material on disk.
    jwt: { algorithm: 'HS256' },
    auth: { jwtSecret: 'test-secret-for-personal-api-keys' },
    oauth: {
      enabled: { authz: true, clients: true },
      clientsFile,
      personalKeys: { enabled: true, ...personalKeys }
    },
    ...extra
  };
}

function fakeRequest(headers = { host: 'ihub.example.com' }) {
  return {
    protocol: 'https',
    get: name => headers[name.toLowerCase()] ?? null
  };
}

function resetClientStore() {
  cacheEntries.clear();
  fs.writeFileSync(
    clientsFile,
    JSON.stringify({ clients: {}, metadata: { version: '1.0.0' } }, null, 2)
  );
  configCache.setCacheEntry('config/platform.json', platformConfig());
}

function storedClient(keyId) {
  return findClientById(loadOAuthClients(clientsFile), keyId);
}

async function run() {
  console.log('🧪 getPersonalKeyConfig\n');
  resetClientStore();

  const defaults = getPersonalKeyConfig({});
  check('defaults to disabled', false, defaults.enabled);
  check('defaults to 5 keys per user', 5, defaults.maxKeysPerUser);
  check('defaults to a 90 day expiry', 90, defaults.defaultExpirationDays);
  check('defaults to a 365 day maximum', 365, defaults.maxExpirationDays);
  check('offers client credentials by default', true, defaults.allowClientCredentials);

  const clamped = getPersonalKeyConfig({
    oauth: { personalKeys: { defaultExpirationDays: 900, maxExpirationDays: 30 } }
  });
  check('clamps the default expiry to the maximum', 30, clamped.defaultExpirationDays);

  const scoped = getPersonalKeyConfig({ mcpServer: { defaultScopes: ['mcp:tools:read'] } });
  check('falls back to the MCP gateway scopes', 'mcp:tools:read', scoped.scopes.join(','));

  console.log('\n🧪 isPersonalKeysEnabled\n');
  const withoutClients = platformConfig();
  withoutClients.oauth.enabled.clients = false;
  check('requires the OAuth client store', false, isPersonalKeysEnabled(withoutClients));
  check('enabled when both switches are on', true, isPersonalKeysEnabled(platformConfig()));

  console.log('\n🧪 canUserManagePersonalKeys\n');
  check('signed-in user may manage keys', true, canUserManagePersonalKeys(USER, platformConfig()));
  check(
    'anonymous user may not',
    false,
    canUserManagePersonalKeys({ id: 'anonymous' }, platformConfig())
  );
  const restricted = platformConfig({ allowedGroups: ['power-users'] });
  check(
    'user outside the allowed groups may not',
    false,
    canUserManagePersonalKeys(USER, restricted)
  );
  check(
    'user inside the allowed groups may',
    true,
    canUserManagePersonalKeys({ ...USER, groups: ['power-users'] }, restricted)
  );
  check(
    'a personal key may not mint further keys',
    false,
    canUserManagePersonalKeys({ ...USER, authMode: 'oauth_personal_key' }, platformConfig())
  );
  check(
    'an OAuth service account may not mint keys',
    false,
    canUserManagePersonalKeys({ ...USER, isOAuthClient: true }, platformConfig())
  );
  check(
    'a delegated authorization-code token may not mint keys',
    false,
    canUserManagePersonalKeys({ ...USER, authMode: 'oauth_authorization_code' }, platformConfig())
  );
  check(
    'a static API key may not mint keys',
    false,
    canUserManagePersonalKeys({ ...USER, authMode: 'oauth_static_api_key' }, platformConfig())
  );
  check(
    'an agent principal may not mint keys',
    false,
    canUserManagePersonalKeys({ ...USER, isAgent: true }, platformConfig())
  );

  console.log('\n🧪 isPersonalKeyExpired\n');
  check('a key without a recorded expiry has not expired', false, isPersonalKeyExpired({}));
  check(
    'a key expiring in the future has not expired',
    false,
    isPersonalKeyExpired({
      metadata: { apiKeyExpiresAt: new Date(Date.now() + 60_000).toISOString() }
    })
  );
  check(
    'a key past its expiry has expired',
    true,
    isPersonalKeyExpired({
      metadata: { apiKeyExpiresAt: new Date(Date.now() - 60_000).toISOString() }
    })
  );

  console.log('\n🧪 buildPersonalKeyEndpoints\n');
  const endpoints = buildPersonalKeyEndpoints(fakeRequest(), platformConfig());
  check('advertises the base URL', 'https://ihub.example.com', endpoints.baseUrl);
  check(
    'advertises the OpenAI-compatible endpoint',
    'https://ihub.example.com/api/inference/v1/chat/completions',
    endpoints.chatCompletions
  );
  check(
    'advertises the token endpoint',
    'https://ihub.example.com/api/oauth/token',
    endpoints.token
  );
  check('omits MCP while the gateway is off', undefined, endpoints.mcp);

  const withMcp = buildPersonalKeyEndpoints(
    fakeRequest(),
    platformConfig({}, { mcpServer: { enabled: true } })
  );
  check('advertises MCP once the gateway is on', 'https://ihub.example.com/mcp', withMcp.mcp);
  check('advertises the MCP SSE transport', 'https://ihub.example.com/mcp/sse', withMcp.mcpSse);

  const withoutCredentials = buildPersonalKeyEndpoints(
    fakeRequest(),
    platformConfig({ allowClientCredentials: false })
  );
  check('omits the token endpoint without client credentials', undefined, withoutCredentials.token);

  const forwarded = buildPersonalKeyEndpoints(
    fakeRequest({
      'x-forwarded-proto': 'https, https',
      'x-forwarded-host': 'public.example.com',
      host: 'internal:3000'
    }),
    platformConfig()
  );
  check('honours forwarded headers', 'https://public.example.com', forwarded.baseUrl);

  console.log('\n🧪 createPersonalKey\n');
  resetClientStore();
  const created = await createPersonalKey({
    user: USER,
    platform: platformConfig(),
    name: 'My laptop'
  });
  check('uses the supplied name', 'My laptop', created.key.name);
  check('returns the client id', created.key.id, created.secrets.clientId);
  check('returns a client secret', true, typeof created.secrets.clientSecret === 'string');

  const claims = verifyOAuthToken(created.secrets.apiKey);
  check('issues a verifiable token', true, claims !== null);
  check('the token acts as its owner', 'alice', claims.sub);
  check('the token is marked as a personal key', 'oauth_personal_key', claims.authMode);
  check('the token is a static key', true, claims.static_key);
  check('the token carries no frozen group list', undefined, claims.groups);

  const client = storedClient(created.key.id);
  check('the backing client is marked personal', true, client.personal);
  check('the backing client records the owner', 'alice', client.ownerUserId);
  check(
    'the owner snapshot carries the groups',
    'users,authenticated',
    client.ownerGroups.join(',')
  );
  check('no app allow-list narrows the owner', 0, client.allowedApps.length);
  check('no model allow-list narrows the owner', 0, client.allowedModels.length);
  check('the secret is stored hashed', false, client.clientSecret === created.secrets.clientSecret);

  resetClientStore();
  const noCredentials = await createPersonalKey({
    user: USER,
    platform: platformConfig({ allowClientCredentials: false })
  });
  check('withholds the client id', undefined, noCredentials.secrets.clientId);
  check('withholds the client secret', undefined, noCredentials.secrets.clientSecret);
  check(
    'disables the client-credentials grant',
    0,
    storedClient(noCredentials.key.id).grantTypes.length
  );

  resetClientStore();
  const shortLived = await createPersonalKey({
    user: USER,
    platform: platformConfig({ maxExpirationDays: 30 }),
    expirationDays: 7
  });
  const shortClaims = verifyOAuthToken(shortLived.secrets.apiKey);
  check(
    'honours the requested expiry',
    7,
    Math.round((shortClaims.exp - shortClaims.iat) / (24 * 60 * 60))
  );
  await checkRejects(
    'rejects an expiry beyond the maximum',
    400,
    createPersonalKey({
      user: USER,
      platform: platformConfig({ maxExpirationDays: 30 }),
      expirationDays: 90
    })
  );
  await checkRejects(
    'rejects a fractional expiry',
    400,
    createPersonalKey({ user: USER, platform: platformConfig(), expirationDays: 1.5 })
  );

  resetClientStore();
  await createPersonalKey({ user: USER, platform: platformConfig({ maxKeysPerUser: 1 }) });
  await checkRejects(
    'enforces the per-user key limit',
    409,
    createPersonalKey({ user: USER, platform: platformConfig({ maxKeysPerUser: 1 }) })
  );

  console.log('\n🧪 listPersonalKeys\n');
  resetClientStore();
  await createPersonalKey({ user: USER, platform: platformConfig(), name: 'Alice key' });
  await createPersonalKey({
    user: { ...USER, id: 'bob', username: 'bob' },
    platform: platformConfig()
  });
  const aliceKeys = listPersonalKeys(USER, platformConfig());
  check('lists only the caller keys', 1, aliceKeys.length);
  check('lists the caller key by name', 'Alice key', aliceKeys[0].name);
  check('never exposes a secret', undefined, aliceKeys[0].clientSecret);

  console.log('\n🧪 rotatePersonalKey\n');
  resetClientStore();
  const toRotate = await createPersonalKey({ user: USER, platform: platformConfig() });
  const promoted = { ...USER, groups: ['users', 'authenticated', 'power-users'] };
  const rotated = await rotatePersonalKey({
    user: promoted,
    platform: platformConfig(),
    keyId: toRotate.key.id
  });
  check('issues a different API key', false, rotated.secrets.apiKey === toRotate.secrets.apiKey);
  check(
    'issues a different client secret',
    false,
    rotated.secrets.clientSecret === toRotate.secrets.clientSecret
  );
  const rotatedClient = storedClient(toRotate.key.id);
  check(
    'refreshes the owner group snapshot',
    true,
    rotatedClient.ownerGroups.includes('power-users')
  );
  check(
    'records the rotation so older tokens are refused',
    true,
    new Date(rotatedClient.lastRotated).getTime() >= new Date(toRotate.key.createdAt).getTime()
  );

  console.log('\n🧪 rotation generations\n');
  // The generation, not `iat`, is what invalidates older credentials: two keys
  // minted in the same second are indistinguishable by timestamp.
  check('rotation advances the stored generation', 2, personalKeyGeneration(rotatedClient));
  check(
    'the original key carries the superseded generation',
    1,
    verifyOAuthToken(toRotate.secrets.apiKey).key_generation
  );
  check(
    'the rotated key carries the current generation',
    2,
    verifyOAuthToken(rotated.secrets.apiKey).key_generation
  );
  check(
    'the superseded key is refused for the current client',
    false,
    isCurrentKeyGeneration(verifyOAuthToken(toRotate.secrets.apiKey), rotatedClient)
  );
  check(
    'the rotated key is accepted for the current client',
    true,
    isCurrentKeyGeneration(verifyOAuthToken(rotated.secrets.apiKey), rotatedClient)
  );
  // The generation is written by the same request that mints the credential and
  // the client store is served from a per-worker cache, so a reader that has not
  // caught up yet must not reject a credential that was just issued.
  check(
    'a credential is accepted against a client whose generation lags behind it',
    true,
    isCurrentKeyGeneration({ key_generation: 2 }, { metadata: { keyGeneration: 1 } })
  );
  check(
    'a credential from an earlier generation is refused',
    false,
    isCurrentKeyGeneration({ key_generation: 1 }, { metadata: { keyGeneration: 2 } })
  );
  check(
    'a credential without a generation claim is refused',
    false,
    isCurrentKeyGeneration({}, { metadata: { keyGeneration: 1 } })
  );

  console.log('\n🧪 grant list reconciliation\n');
  resetClientStore();
  const noGrantKey = await createPersonalKey({
    user: USER,
    platform: platformConfig({ allowClientCredentials: false })
  });
  check(
    'a key created without client credentials records no grant',
    0,
    (storedClient(noGrantKey.key.id).grantTypes || []).length
  );
  check('and is not handed a client secret', undefined, noGrantKey.secrets.clientSecret);
  // Turning the policy on has to reach keys that already exist, otherwise a
  // rotation would show a secret the token endpoint always rejects.
  const reconciled = await rotatePersonalKey({
    user: USER,
    platform: platformConfig({ allowClientCredentials: true }),
    keyId: noGrantKey.key.id
  });
  check(
    'enabling the policy adds the grant on the next issue',
    true,
    (storedClient(noGrantKey.key.id).grantTypes || []).includes('client_credentials')
  );
  check('and hands out a client secret', 'string', typeof reconciled.secrets.clientSecret);
  // And back off again.
  await rotatePersonalKey({
    user: USER,
    platform: platformConfig({ allowClientCredentials: false }),
    keyId: noGrantKey.key.id
  });
  check(
    'disabling the policy removes the grant again',
    0,
    (storedClient(noGrantKey.key.id).grantTypes || []).length
  );

  console.log('\n🧪 per-user limit under concurrency\n');
  resetClientStore();
  const limited = platformConfig({ maxKeysPerUser: 2 });
  const outcomes = await Promise.allSettled(
    Array.from({ length: 5 }, () => createPersonalKey({ user: USER, platform: limited }))
  );
  check(
    'never creates more keys than the limit allows',
    2,
    outcomes.filter(outcome => outcome.status === 'fulfilled').length
  );
  check('and the store agrees', 2, listPersonalKeys(USER, limited).length);
  check(
    'the rejected requests report the limit',
    3,
    outcomes.filter(outcome => outcome.status === 'rejected' && outcome.reason.status === 409)
      .length
  );

  console.log('\n🧪 generated client identifiers\n');
  resetClientStore();
  const longName = await createPersonalKey({
    user: { ...USER, id: 'x'.repeat(120), username: 'y'.repeat(120) },
    platform: platformConfig()
  });
  // The client ID is derived from the key name and is later validated as a path
  // segment, so an unbounded user name must not produce an unusable key.
  check('a very long user name still yields a usable key id', true, isValidId(longName.key.id));

  console.log('\n🧪 revokePersonalKey\n');
  resetClientStore();
  const toRevoke = await createPersonalKey({ user: USER, platform: platformConfig() });
  await revokePersonalKey({ user: USER, platform: platformConfig(), keyId: toRevoke.key.id });
  check('deletes the backing client', null, storedClient(toRevoke.key.id));
  check('drops the key from the list', 0, listPersonalKeys(USER, platformConfig()).length);

  console.log('\n🧪 isAdminEligiblePrincipal\n');
  check('a browser session may be an admin', true, isAdminEligiblePrincipal({ authMode: 'local' }));
  check(
    'a personal API key may not',
    false,
    isAdminEligiblePrincipal({ authMode: 'oauth_personal_key' })
  );
  check(
    'a delegated authorization-code token may not',
    false,
    isAdminEligiblePrincipal({ authMode: 'oauth_authorization_code' })
  );
  check(
    'a client-credentials token may not',
    false,
    isAdminEligiblePrincipal({ authMode: 'oauth_client_credentials' })
  );
  check(
    'a static API key may not',
    false,
    isAdminEligiblePrincipal({ authMode: 'oauth_static_api_key' })
  );
  check('an OAuth client may not', false, isAdminEligiblePrincipal({ isOAuthClient: true }));
  check('an agent principal may not', false, isAdminEligiblePrincipal({ isAgent: true }));
  check('a missing principal may not', false, isAdminEligiblePrincipal(null));

  console.log('\n🧪 ownership checks\n');
  resetClientStore();
  const owned = await createPersonalKey({ user: USER, platform: platformConfig() });
  const mallory = { ...USER, id: 'mallory', username: 'mallory' };
  await checkRejects(
    'another user cannot revoke the key',
    404,
    revokePersonalKey({ user: mallory, platform: platformConfig(), keyId: owned.key.id })
  );
  await checkRejects(
    'another user cannot rotate the key',
    404,
    rotatePersonalKey({ user: mallory, platform: platformConfig(), keyId: owned.key.id })
  );
  await checkRejects(
    'an unknown key id is reported as missing',
    404,
    revokePersonalKey({ user: USER, platform: platformConfig(), keyId: 'client_does_not_exist' })
  );
}

run()
  .catch(error => {
    failures += 1;
    console.error('❌ Unexpected error', error);
  })
  .finally(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log(`\n${failures === 0 ? '🎉 All tests passed.' : `❌ ${failures} failure(s).`}`);
    process.exit(failures === 0 ? 0 : 1);
  });
