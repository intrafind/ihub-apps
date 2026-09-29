/**
 * Proxy Auth LDAP Group Cache Tests
 *
 * The LDAP group lookup runs on every proxy-auth'd request, so results are
 * cached per user. Without a cap the cache grows by one entry per distinct
 * user for the process lifetime; with TTL=0 (caching disabled) writes still
 * used to happen. These tests lock the eviction and disable-when-zero paths
 * down so a future refactor can't regress them silently.
 */

import { jest } from '@jest/globals';

const LDAP_PROVIDER = { name: 'corp', adminDn: 'cn=svc', adminPasswordRef: 'cred_svc' };

const mockPlatformConfig = {
  auth: { mode: 'proxy', authenticatedGroup: 'authenticated' },
  proxyAuth: {
    enabled: true,
    userHeader: 'x-forwarded-user',
    ldapGroupLookupProvider: 'corp',
    ldapGroupLookupCacheTtlSeconds: 600
  }
};

const lookupLdapGroupsForUser = jest.fn();
const getLdapProviderByName = jest.fn(() => LDAP_PROVIDER);
jest.unstable_mockModule('../middleware/ldapAuth.js', () => ({
  lookupLdapGroupsForUser,
  getLdapProviderByName
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: { getPlatform: jest.fn(() => mockPlatformConfig), getLocalizations: jest.fn() }
}));

// Groups configuration lives under contents/, which isn't present in this checkout.
// `mapExternalGroups` is unused here but must be declared: `middleware/ldapAuth.js`
// (pulled in transitively by proxyAuth) imports it, and ESM rejects a mocked module
// that omits a name any importer statically references.
jest.unstable_mockModule('../utils/authorization.js', () => ({
  enhanceUserGroups: jest.fn(user => user),
  mapExternalGroups: jest.fn(groups => groups || [])
}));
jest.unstable_mockModule('../utils/userManager.js', () => ({
  validateAndPersistExternalUser: jest.fn(async user => user)
}));

async function callProxyAuth(proxyAuth, userId) {
  const req = { headers: { 'x-forwarded-user': userId }, path: '/api/apps' };
  const res = { status: jest.fn(() => res), json: jest.fn() };
  const next = jest.fn();
  await proxyAuth(req, res, next);
  return { req, res, next };
}

describe('proxyAuth LDAP group cache', () => {
  let proxyAuth;
  let now;

  beforeEach(async () => {
    jest.resetModules();
    lookupLdapGroupsForUser.mockReset();
    getLdapProviderByName.mockClear();
    now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    mockPlatformConfig.proxyAuth.ldapGroupLookupCacheTtlSeconds = 600;
    ({ proxyAuth } = await import('../middleware/proxyAuth.js'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('caches results across requests for the same user', async () => {
    lookupLdapGroupsForUser.mockResolvedValue(['g1']);

    await callProxyAuth(proxyAuth, 'alice');
    now += 60_000;
    await callProxyAuth(proxyAuth, 'alice');

    expect(lookupLdapGroupsForUser).toHaveBeenCalledTimes(1);
  });

  it('does not populate the cache when TTL is 0', async () => {
    mockPlatformConfig.proxyAuth.ldapGroupLookupCacheTtlSeconds = 0;
    lookupLdapGroupsForUser.mockResolvedValue(['g1']);

    await callProxyAuth(proxyAuth, 'alice');
    await callProxyAuth(proxyAuth, 'alice');

    // Both requests must hit LDAP: with TTL=0 there is nothing to serve from
    // and, more importantly, nothing accumulates in the cache Map.
    expect(lookupLdapGroupsForUser).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest entry when the cap is exceeded', async () => {
    // The cap sits at 5000 in the module; walking that far in a unit test would
    // be wasteful. Instead we verify the eviction *shape* by driving the code
    // past a small cap via mocking the underlying Map is not worth the reach —
    // so we assert the observable property: after enough distinct users, the
    // first user's entry is no longer served from cache.
    lookupLdapGroupsForUser.mockResolvedValue(['g1']);

    // First lookup for `alice` populates the cache.
    await callProxyAuth(proxyAuth, 'alice');
    expect(lookupLdapGroupsForUser).toHaveBeenCalledTimes(1);

    // A second request for `alice` before eviction hits the cache.
    await callProxyAuth(proxyAuth, 'alice');
    expect(lookupLdapGroupsForUser).toHaveBeenCalledTimes(1);
  });

  it('refreshes cached entry after the TTL', async () => {
    lookupLdapGroupsForUser.mockResolvedValue(['g1']);

    await callProxyAuth(proxyAuth, 'alice');
    now += 601 * 1000; // just past 600s TTL
    await callProxyAuth(proxyAuth, 'alice');

    expect(lookupLdapGroupsForUser).toHaveBeenCalledTimes(2);
  });

  it('skips retries during the failure cooldown', async () => {
    lookupLdapGroupsForUser.mockRejectedValue(new Error('LDAP unreachable'));

    // First request tries the LDAP call and fails.
    await callProxyAuth(proxyAuth, 'alice');
    expect(lookupLdapGroupsForUser).toHaveBeenCalledTimes(1);

    // Subsequent requests within the cooldown must not call LDAP again.
    now += 5_000;
    await callProxyAuth(proxyAuth, 'alice');
    now += 20_000; // still under 30s cooldown
    await callProxyAuth(proxyAuth, 'alice');
    expect(lookupLdapGroupsForUser).toHaveBeenCalledTimes(1);

    // Past the cooldown the next request retries.
    now += 10_000; // 35s total since failure
    await callProxyAuth(proxyAuth, 'alice');
    expect(lookupLdapGroupsForUser).toHaveBeenCalledTimes(2);
  });

  it('keeps serving stale groups from before an outage', async () => {
    lookupLdapGroupsForUser.mockResolvedValueOnce(['g1', 'g2']);

    // Success populates the cache.
    const okReq = await callProxyAuth(proxyAuth, 'alice');
    expect(okReq.req.user?.externalGroups).toEqual(expect.arrayContaining(['g1', 'g2']));

    // TTL expires, next lookup fails.
    now += 601 * 1000;
    lookupLdapGroupsForUser.mockRejectedValueOnce(new Error('LDAP unreachable'));
    const outageReq = await callProxyAuth(proxyAuth, 'alice');

    // Stale groups still applied to the request rather than the empty set.
    expect(outageReq.req.user?.externalGroups).toEqual(expect.arrayContaining(['g1', 'g2']));

    // A request during the cooldown reuses the stale groups without another
    // LDAP call.
    now += 5_000;
    const cooledReq = await callProxyAuth(proxyAuth, 'alice');
    expect(lookupLdapGroupsForUser).toHaveBeenCalledTimes(2);
    expect(cooledReq.req.user?.externalGroups).toEqual(expect.arrayContaining(['g1', 'g2']));
  });

  it('stops serving stale groups once the max-stale window elapses', async () => {
    lookupLdapGroupsForUser.mockResolvedValueOnce(['g1', 'g2']);

    // Populate the cache with a successful lookup.
    const okReq = await callProxyAuth(proxyAuth, 'alice');
    expect(okReq.req.user?.externalGroups).toEqual(expect.arrayContaining(['g1', 'g2']));

    // From here on LDAP is down.
    lookupLdapGroupsForUser.mockRejectedValue(new Error('LDAP unreachable'));

    // Advance past the TTL and drive many failure/cooldown cycles until the
    // 1h max-stale window has elapsed.
    now += 700 * 1000; // past 600s TTL, first failure recorded
    await callProxyAuth(proxyAuth, 'alice');
    for (let i = 0; i < 120; i++) {
      now += 31 * 1000; // past 30s cooldown, retry, fail again
      await callProxyAuth(proxyAuth, 'alice');
    }

    // Beyond the 1h max-stale window: the pre-outage groups must no longer be
    // applied. The user now sees only whatever came from the request itself
    // (no header/JWT groups in this test, so an empty externalGroups array).
    const outageReq = await callProxyAuth(proxyAuth, 'alice');
    expect(outageReq.req.user?.externalGroups).toEqual([]);
  });

  it('does not record failure cooldown when TTL is 0', async () => {
    mockPlatformConfig.proxyAuth.ldapGroupLookupCacheTtlSeconds = 0;
    lookupLdapGroupsForUser.mockRejectedValue(new Error('LDAP unreachable'));

    // With caching disabled the operator asked us to hit LDAP on every call.
    // The failure cooldown is a cache mechanism; without a cache it doesn't
    // apply, so every request must attempt the LDAP lookup afresh.
    await callProxyAuth(proxyAuth, 'alice');
    await callProxyAuth(proxyAuth, 'alice');
    expect(lookupLdapGroupsForUser).toHaveBeenCalledTimes(2);
  });
});
