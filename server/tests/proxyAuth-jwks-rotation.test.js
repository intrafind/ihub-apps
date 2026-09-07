/**
 * Proxy Auth JWKS Cache Tests
 *
 * The JWKS document fetched for a `proxyAuth.jwtProviders` entry used to be cached
 * for the lifetime of the process, so an identity provider that rotated its signing
 * keys locked every user out until iHub was restarted. These tests pin down the
 * refresh behaviour: TTL expiry, refresh on an unknown `kid`, the throttle that keeps
 * unknown key ids from hammering the provider, and the stale-copy fallback.
 */

import { jest } from '@jest/globals';
import * as jose from 'jose';

const JWK_URL = 'https://idp.example.com/.well-known/jwks.json';
const JWKS_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000; // mirrors proxyAuth.js
const ISSUER = 'https://idp.example.com';
const AUDIENCE = 'ihub';

const mockPlatformConfig = {
  auth: { mode: 'proxy', authenticatedGroup: 'authenticated' },
  proxyAuth: {
    enabled: true,
    userHeader: 'x-forwarded-user',
    jwtProviders: [{ header: 'authorization', jwkUrl: JWK_URL, issuer: ISSUER, audience: AUDIENCE }]
  }
};

const httpFetch = jest.fn();
jest.unstable_mockModule('../utils/httpConfig.js', () => ({ httpFetch }));

jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: jest.fn(() => mockPlatformConfig), getLocalizations: jest.fn() }
}));

// Groups configuration lives under contents/, which isn't present in this checkout.
jest.unstable_mockModule('../utils/authorization.js', () => ({
  enhanceUserGroups: jest.fn(user => user)
}));
jest.unstable_mockModule('../utils/userManager.js', () => ({
  validateAndPersistExternalUser: jest.fn(async user => user)
}));

/** Generate a signing key plus the JWK the provider would publish for it. */
async function makeKey(kid) {
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await jose.exportJWK(publicKey)), kid, use: 'sig', alg: 'RS256' };
  return { jwk, privateKey, kid };
}

async function signWith(key) {
  return new jose.SignJWT({ email: 'user@example.com', groups: ['users'] })
    .setProtectedHeader({ alg: 'RS256', kid: key.kid })
    .setSubject('user-1')
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key.privateKey);
}

/** Queue the JWKS document the next httpFetch call should answer with. */
function serveJwks(...keys) {
  httpFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ keys: keys.map(k => k.jwk) })
  });
}

async function callProxyAuth(proxyAuth, token) {
  const req = { headers: { authorization: `Bearer ${token}` }, path: '/api/apps' };
  const res = { status: jest.fn(() => res), json: jest.fn() };
  const next = jest.fn();
  await proxyAuth(req, res, next);
  return { req, res, next };
}

describe('proxyAuth JWKS cache', () => {
  let proxyAuth;
  let now;

  beforeEach(async () => {
    jest.resetModules();
    httpFetch.mockReset();
    now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    // Re-import so each test starts with an empty module-level JWKS cache.
    ({ proxyAuth } = await import('../middleware/proxyAuth.js'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('caches the JWKS document across requests', async () => {
    const key = await makeKey('key-1');
    serveJwks(key);
    const token = await signWith(key);

    const first = await callProxyAuth(proxyAuth, token);
    expect(first.req.user?.id).toBe('user@example.com');

    now += 60_000;
    const second = await callProxyAuth(proxyAuth, token);
    expect(second.req.user?.id).toBe('user@example.com');
    expect(httpFetch).toHaveBeenCalledTimes(1);
  });

  it('re-fetches the JWKS document once the TTL has passed', async () => {
    const key = await makeKey('key-1');
    serveJwks(key);
    const token = await signWith(key);

    await callProxyAuth(proxyAuth, token);
    expect(httpFetch).toHaveBeenCalledTimes(1);

    now += 10 * 60 * 60 * 1000 + 1; // just past the 10h TTL
    serveJwks(key);
    const after = await callProxyAuth(proxyAuth, token);
    expect(after.req.user?.id).toBe('user@example.com');
    expect(httpFetch).toHaveBeenCalledTimes(2);
  });

  it('picks up a rotated signing key without waiting for the TTL', async () => {
    const oldKey = await makeKey('key-1');
    const newKey = await makeKey('key-2');
    serveJwks(oldKey);

    await callProxyAuth(proxyAuth, await signWith(oldKey));
    expect(httpFetch).toHaveBeenCalledTimes(1);

    // Provider rotates; the new token's kid is absent from the cached document.
    now += 6 * 60 * 1000; // past the refresh throttle
    serveJwks(oldKey, newKey);
    const rotated = await callProxyAuth(proxyAuth, await signWith(newKey));

    expect(httpFetch).toHaveBeenCalledTimes(2);
    expect(rotated.req.user?.id).toBe('user@example.com');
  });

  it('throttles refreshes so unknown key ids cannot hammer the provider', async () => {
    const key = await makeKey('key-1');
    const unknown = await makeKey('attacker-kid');
    serveJwks(key);

    await callProxyAuth(proxyAuth, await signWith(key));
    expect(httpFetch).toHaveBeenCalledTimes(1);

    now += 1000; // well inside the 5 minute refresh floor
    for (let i = 0; i < 5; i++) {
      const rejected = await callProxyAuth(proxyAuth, await signWith(unknown));
      expect(rejected.req.user).toBeNull();
    }
    expect(httpFetch).toHaveBeenCalledTimes(1);
  });

  it('throttles retries when the very first fetch fails', async () => {
    const key = await makeKey('key-1');
    const token = await signWith(key);

    // Cold start during an outage: nothing cached to fall back on.
    httpFetch.mockRejectedValueOnce(new Error('JWKS endpoint unreachable'));
    const first = await callProxyAuth(proxyAuth, token);
    expect(first.req.user).toBeNull();
    expect(httpFetch).toHaveBeenCalledTimes(1);

    // Further logins inside the retry interval must not each hit the IdP.
    now += 1000;
    for (let i = 0; i < 3; i++) {
      const rejected = await callProxyAuth(proxyAuth, token);
      expect(rejected.req.user).toBeNull();
    }
    expect(httpFetch).toHaveBeenCalledTimes(1);

    // Once the interval passes it tries again and recovers.
    now += JWKS_REFRESH_MIN_INTERVAL_MS + 1;
    serveJwks(key);
    const recovered = await callProxyAuth(proxyAuth, token);
    expect(httpFetch).toHaveBeenCalledTimes(2);
    expect(recovered.req.user?.id).toBe('user@example.com');
  });

  it('collapses a concurrent burst into a single JWKS request', async () => {
    const key = await makeKey('key-1');
    const token = await signWith(key);

    // Hold the response open so all five requests are in flight at once.
    let release;
    const gate = new Promise(resolve => {
      release = resolve;
    });
    httpFetch.mockImplementation(async () => {
      await gate;
      return { ok: true, json: async () => ({ keys: [key.jwk] }) };
    });

    const inFlight = Array.from({ length: 5 }, () => callProxyAuth(proxyAuth, token));
    release();
    const results = await Promise.all(inFlight);

    expect(httpFetch).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result.req.user?.id).toBe('user@example.com');
    }
  });

  it('keeps serving the cached keys when a refresh fails', async () => {
    const key = await makeKey('key-1');
    serveJwks(key);
    const token = await signWith(key);

    await callProxyAuth(proxyAuth, token);

    now += 10 * 60 * 60 * 1000 + 1; // TTL expired, forcing a refresh
    httpFetch.mockRejectedValueOnce(new Error('JWKS endpoint unreachable'));

    const during = await callProxyAuth(proxyAuth, token);
    expect(httpFetch).toHaveBeenCalledTimes(2);
    expect(during.req.user?.id).toBe('user@example.com');
  });
});
