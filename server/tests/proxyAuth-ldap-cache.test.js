/**
 * Proxy Auth LDAP Group Cache Tests
 *
 * The LDAP group lookup runs on every proxy-auth'd request, so results are
 * cached per user. These tests lock down the size cap, the failure cooldown,
 * the bounded stale fallback and the TTL=0 contract (nothing cached, nothing
 * cached earlier served) so a future refactor can't regress them silently.
 */

import { jest } from '@jest/globals';

const LDAP_PROVIDER = { name: 'corp', adminDn: 'cn=svc', adminPasswordRef: 'cred_svc' };

const mockPlatformConfig = {
  auth: { mode: 'proxy', authenticatedGroup: 'authenticated' },
  proxyAuth: {
    enabled: true,
    userHeader: 'x-forwarded-user',
    groupsHeader: 'x-forwarded-groups',
    // The requests below come from the local host, which this trusts.
    trustedProxies: ['loopback'],
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

async function callProxyAuth(proxyAuth, userId, extraHeaders = {}) {
  const req = {
    headers: { 'x-forwarded-user': userId, ...extraHeaders },
    path: '/api/apps',
    socket: { remoteAddress: '127.0.0.1' }
  };
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

  it('merges LDAP groups with header groups, without duplicates', async () => {
    lookupLdapGroupsForUser.mockResolvedValue(['shared', 'ldap-only']);

    const { req } = await callProxyAuth(proxyAuth, 'alice', {
      'x-forwarded-groups': 'header-only, shared'
    });

    expect(lookupLdapGroupsForUser).toHaveBeenCalledWith('alice', LDAP_PROVIDER);
    expect(req.user.externalGroups).toEqual(['header-only', 'shared', 'ldap-only']);
  });

  it('shares one LDAP lookup between concurrent requests for the same user', async () => {
    lookupLdapGroupsForUser.mockResolvedValue(['g1']);

    const results = await Promise.all([
      callProxyAuth(proxyAuth, 'alice'),
      callProxyAuth(proxyAuth, 'alice'),
      callProxyAuth(proxyAuth, 'alice')
    ]);

    expect(lookupLdapGroupsForUser).toHaveBeenCalledTimes(1);
    for (const { req } of results) {
      expect(req.user.externalGroups).toEqual(['g1']);
    }
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
    lookupLdapGroupsForUser.mockResolvedValue(['g1']);

    // `alice` is cached first, so she is the oldest entry once 5000 more
    // distinct users push the cache past its cap.
    await callProxyAuth(proxyAuth, 'alice');
    for (let i = 0; i < 5000; i++) {
      await callProxyAuth(proxyAuth, `user-${i}`);
    }
    expect(lookupLdapGroupsForUser).toHaveBeenCalledTimes(5001);

    // The most recent user is still served from the cache...
    await callProxyAuth(proxyAuth, 'user-4999');
    expect(lookupLdapGroupsForUser).toHaveBeenCalledTimes(5001);

    // ...while `alice` was evicted and needs a fresh lookup, well within TTL.
    await callProxyAuth(proxyAuth, 'alice');
    expect(lookupLdapGroupsForUser).toHaveBeenCalledTimes(5002);
    expect(lookupLdapGroupsForUser).toHaveBeenLastCalledWith('alice', LDAP_PROVIDER);
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

  it('stops serving cached groups once the TTL is lowered to 0', async () => {
    lookupLdapGroupsForUser.mockResolvedValueOnce(['g1', 'g2']);
    await callProxyAuth(proxyAuth, 'alice');

    // The operator disables caching, then the directory goes down. The entry
    // cached under the old TTL must not stand in for the failed lookup.
    mockPlatformConfig.proxyAuth.ldapGroupLookupCacheTtlSeconds = 0;
    lookupLdapGroupsForUser.mockRejectedValue(new Error('LDAP unreachable'));

    const first = await callProxyAuth(proxyAuth, 'alice');
    expect(first.req.user.externalGroups).toEqual([]);

    // The dropped entry cannot come back on later failures either.
    now += 5_000;
    const second = await callProxyAuth(proxyAuth, 'alice');
    expect(second.req.user.externalGroups).toEqual([]);
    expect(lookupLdapGroupsForUser).toHaveBeenCalledTimes(3);
  });

  it('ignores a failure cooldown recorded before the TTL was lowered to 0', async () => {
    lookupLdapGroupsForUser.mockResolvedValueOnce(['g1', 'g2']);
    await callProxyAuth(proxyAuth, 'alice');

    // Past the TTL a lookup fails, which records a cooldown holding the old groups.
    now += 601 * 1000;
    lookupLdapGroupsForUser.mockRejectedValueOnce(new Error('LDAP unreachable'));
    const outage = await callProxyAuth(proxyAuth, 'alice');
    expect(outage.req.user.externalGroups).toEqual(['g1', 'g2']);

    // Within that cooldown the operator disables caching: the next request
    // goes to LDAP and uses only what it returns.
    mockPlatformConfig.proxyAuth.ldapGroupLookupCacheTtlSeconds = 0;
    lookupLdapGroupsForUser.mockResolvedValueOnce(['g1']);
    now += 5_000;
    const afterChange = await callProxyAuth(proxyAuth, 'alice');

    expect(lookupLdapGroupsForUser).toHaveBeenCalledTimes(3);
    expect(afterChange.req.user.externalGroups).toEqual(['g1']);
  });

  it('does not hand stale groups to a TTL=0 request that joins an in-flight lookup', async () => {
    lookupLdapGroupsForUser.mockResolvedValueOnce(['g1', 'g2']);
    await callProxyAuth(proxyAuth, 'alice');

    // Past the TTL, a refresh starts under the positive TTL and hangs.
    now += 601 * 1000;
    let rejectLookup;
    lookupLdapGroupsForUser.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectLookup = reject;
        })
    );
    const underTtl = callProxyAuth(proxyAuth, 'alice');

    // While it is in flight caching is disabled, and a second request joins it.
    mockPlatformConfig.proxyAuth.ldapGroupLookupCacheTtlSeconds = 0;
    const underZeroTtl = callProxyAuth(proxyAuth, 'alice');

    // Let both requests reach the shared lookup before it fails.
    await new Promise(resolve => setImmediate(resolve));
    rejectLookup(new Error('LDAP unreachable'));
    const [first, second] = await Promise.all([underTtl, underZeroTtl]);

    expect(lookupLdapGroupsForUser).toHaveBeenCalledTimes(2);
    // The request that started under the old TTL keeps the documented fallback...
    expect(first.req.user.externalGroups).toEqual(['g1', 'g2']);
    // ...but the one running with caching disabled gets no cached groups.
    expect(second.req.user.externalGroups).toEqual([]);
  });
});
