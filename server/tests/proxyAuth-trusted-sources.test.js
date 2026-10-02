/**
 * Proxy auth uses its identity headers (user, groups, name, email) only when
 * the request came through a proxy an admin trusts: a connection from an
 * address in `proxyAuth.trustedProxies`, and/or the shared secret in
 * `proxyAuth.sharedSecretHeader`. When both are configured both must hold;
 * when neither is, the headers are ignored. Unset, the list is the local host,
 * so a proxy in the same pod works. The secret header never travels past the
 * check.
 */
import { jest } from '@jest/globals';

const platform = {
  auth: { mode: 'proxy', authenticatedGroup: 'authenticated' },
  proxyAuth: {}
};
const secrets = { cred_proxy: 'proxy-secret-value' };
const env = {};

jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: jest.fn(() => platform), getLocalizations: jest.fn() }
}));
jest.unstable_mockModule('../services/CredentialService.js', () => ({
  default: { tryResolveSecret: ref => secrets[ref] }
}));
const realConfig = (await import('../config.js')).default;
// The real config is frozen; a copy whose two proxy-trust settings read `env`.
jest.unstable_mockModule('../config.js', () => ({
  default: Object.defineProperties(
    { ...realConfig },
    {
      PROXY_AUTH_TRUSTED_PROXIES: { get: () => env.PROXY_AUTH_TRUSTED_PROXIES },
      PROXY_AUTH_SHARED_SECRET: { get: () => env.PROXY_AUTH_SHARED_SECRET }
    }
  )
}));
jest.unstable_mockModule('../utils/authorization.js', () => ({
  enhanceUserGroups: jest.fn(user => user),
  mapExternalGroups: jest.fn(groups => groups || [])
}));
jest.unstable_mockModule('../utils/userManager.js', () => ({
  validateAndPersistExternalUser: jest.fn(async user => user)
}));

const { proxyAuth } = await import('../middleware/proxyAuth.js');
const { resetProxyTrustForTests } = await import('../utils/proxyAuthTrust.js');

const IDENTITY = {
  'x-forwarded-user': 'alice',
  'x-forwarded-groups': 'staff, admins',
  'x-forwarded-name': 'Alice A.',
  'x-forwarded-email': 'alice@example.com'
};

async function call({ from = '127.0.0.1', headers = {} } = {}) {
  const req = {
    headers: { ...IDENTITY, ...headers },
    path: '/api/apps',
    socket: { remoteAddress: from }
  };
  const res = { status: jest.fn(() => res), json: jest.fn() };
  const next = jest.fn();
  await proxyAuth(req, res, next);
  expect(next).toHaveBeenCalled();
  return req;
}

beforeEach(() => {
  resetProxyTrustForTests();
  for (const key of Object.keys(env)) delete env[key];
  platform.proxyAuth = {
    enabled: true,
    userHeader: 'X-Forwarded-User',
    groupsHeader: 'X-Forwarded-Groups'
  };
});

describe('without trustedProxies set', () => {
  test('a connection from the local host is trusted', async () => {
    expect((await call()).user?.id).toBe('alice');
    expect((await call({ from: '::1' })).user?.id).toBe('alice');
  });

  test('a connection from any other address has the identity headers ignored', async () => {
    expect((await call({ from: '192.0.2.10' })).user).toBeNull();
  });
});

describe('with an empty list and no shared secret', () => {
  test('identity headers are ignored', async () => {
    platform.proxyAuth.trustedProxies = [];
    expect((await call()).user).toBeNull();
  });
});

describe('trusted proxy addresses', () => {
  test('a connection from a listed address is trusted', async () => {
    platform.proxyAuth.trustedProxies = ['loopback'];
    const req = await call();
    expect(req.user).toMatchObject({
      id: 'alice',
      name: 'Alice A.',
      email: 'alice@example.com',
      externalGroups: ['staff', 'admins'],
      authMethod: 'proxy'
    });
  });

  test('subnets and IPv4-mapped addresses match', async () => {
    platform.proxyAuth.trustedProxies = ['10.0.0.0/8'];
    expect((await call({ from: '10.1.2.3' })).user?.id).toBe('alice');
    expect((await call({ from: '::ffff:10.1.2.3' })).user?.id).toBe('alice');
  });

  test('a connection from any other address has all identity headers ignored', async () => {
    platform.proxyAuth.trustedProxies = ['10.0.0.0/8'];
    const req = await call({ from: '192.0.2.10' });
    expect(req.user).toBeNull();
  });

  test('an invalid list trusts nobody', async () => {
    platform.proxyAuth.trustedProxies = ['not-an-address'];
    expect((await call()).user).toBeNull();
  });

  test('PROXY_AUTH_TRUSTED_PROXIES takes precedence over the platform setting', async () => {
    platform.proxyAuth.trustedProxies = ['10.0.0.0/8'];
    env.PROXY_AUTH_TRUSTED_PROXIES = '192.0.2.0/24, loopback';
    expect((await call({ from: '192.0.2.10' })).user?.id).toBe('alice');
    expect((await call({ from: '10.1.2.3' })).user).toBeNull();
  });

  test('a list without loopback does not trust the local host', async () => {
    platform.proxyAuth.trustedProxies = ['10.0.0.0/8'];
    expect((await call()).user).toBeNull();
  });
});

describe('shared secret alone (empty trustedProxies)', () => {
  beforeEach(() => {
    platform.proxyAuth.trustedProxies = [];
    platform.proxyAuth.sharedSecretRef = 'cred_proxy';
  });

  test('the right secret is trusted from any address', async () => {
    const req = await call({
      from: '192.0.2.10',
      headers: { 'x-proxy-secret': 'proxy-secret-value' }
    });
    expect(req.user?.id).toBe('alice');
  });

  test('a wrong or missing secret has the identity headers ignored', async () => {
    expect((await call({ headers: { 'x-proxy-secret': 'guess' } })).user).toBeNull();
    expect((await call()).user).toBeNull();
  });

  test('the secret header is removed from the request', async () => {
    const req = await call({ headers: { 'x-proxy-secret': 'proxy-secret-value' } });
    expect(req.headers).not.toHaveProperty('x-proxy-secret');
  });

  test('the header name is configurable, and PROXY_AUTH_SHARED_SECRET overrides the store', async () => {
    platform.proxyAuth.sharedSecretHeader = 'X-Gate';
    env.PROXY_AUTH_SHARED_SECRET = 'from-env';
    expect((await call({ headers: { 'x-gate': 'from-env' } })).user?.id).toBe('alice');
    expect((await call({ headers: { 'x-gate': 'proxy-secret-value' } })).user).toBeNull();
  });
});

describe('trusted proxies and a shared secret together', () => {
  beforeEach(() => {
    platform.proxyAuth.trustedProxies = ['loopback'];
    platform.proxyAuth.sharedSecretRef = 'cred_proxy';
  });

  test('both must hold', async () => {
    const secret = { 'x-proxy-secret': 'proxy-secret-value' };
    expect((await call({ headers: secret })).user?.id).toBe('alice');
    expect((await call({ from: '192.0.2.10', headers: secret })).user).toBeNull();
    expect((await call()).user).toBeNull();
  });

  test('the same holds with the default list', async () => {
    delete platform.proxyAuth.trustedProxies;
    const secret = { 'x-proxy-secret': 'proxy-secret-value' };
    expect((await call({ headers: secret })).user?.id).toBe('alice');
    expect((await call({ from: '192.0.2.10', headers: secret })).user).toBeNull();
  });
});
