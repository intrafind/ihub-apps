import jwt from 'jsonwebtoken';
import { httpFetch } from '../utils/httpConfig.js';
import * as jose from 'jose';
import config from '../config.js';
import configCache from '../configCache.js';
import { enhanceUserGroups } from '../utils/authorization.js';
import { validateAndPersistExternalUser } from '../utils/userManager.js';
import { getLdapProviderByName, lookupLdapGroupsForUser } from './ldapAuth.js';
import logger from '../utils/logger.js';

// JWKS documents are cached per provider URL, but only for a bounded TTL. The
// previous cache never expired, so once an IdP rotated its signing keys every
// token signed with the new key failed verification until the process was
// restarted. `httpFetch` is deliberately kept instead of a library with its own
// HTTP stack (e.g. `jwks-rsa`) so the platform's proxy and TLS settings still
// apply to the JWKS request.
const JWKS_CACHE_TTL_MS = 10 * 60 * 60 * 1000; // 10 hours
// Floor between forced refreshes, so a stream of tokens carrying unknown `kid`
// values cannot turn into a stream of outbound requests to the IdP.
const JWKS_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const jwksCache = new Map();
// One in-flight request per URL. The throttle below is checked before the fetch
// is awaited, so without this a burst of concurrent requests arriving after the
// TTL expires would each start their own outbound call.
const inFlightFetches = new Map();

// Proxy auth runs on every request. An uncached LDAP lookup per request would
// hammer the directory server, so cache the resolved group list per user with
// a bounded TTL. Keyed by `<providerName>::<userId>` so switching the
// configured provider (or user impersonation across sessions) doesn't reuse a
// stale entry.
const ldapGroupsCache = new Map();
const ldapGroupsInFlight = new Map();
const DEFAULT_LDAP_GROUPS_TTL_MS = 10 * 60 * 1000; // 10 minutes
// Hard cap on cached users per process. Without this, a long-running server
// with churn in the proxy-authenticated user set would accumulate one entry
// per distinct user for the process lifetime. Map preserves insertion order,
// so evicting `keys().next()` drops the least-recently-refreshed entry.
const LDAP_GROUPS_CACHE_MAX_ENTRIES = 5000;
// Cooldown between LDAP lookups for the same user after a failure. Without it,
// every request during a directory outage opens its own LDAP timeout, piling
// latency on top of the outage and load on the recovering server.
const LDAP_GROUPS_FAILURE_COOLDOWN_MS = 30 * 1000;

function getLdapGroupsCacheKey(providerName, userId) {
  return `${providerName}::${userId}`;
}

function storeLdapGroupsCacheEntry(cacheKey, entry) {
  // Delete + re-set refreshes insertion order, so recently-used entries
  // survive when the cap kicks in.
  ldapGroupsCache.delete(cacheKey);
  ldapGroupsCache.set(cacheKey, entry);
  while (ldapGroupsCache.size > LDAP_GROUPS_CACHE_MAX_ENTRIES) {
    const oldest = ldapGroupsCache.keys().next().value;
    if (oldest === undefined) break;
    ldapGroupsCache.delete(oldest);
  }
}

async function fetchLdapGroupsForProxyUser(providerName, userId) {
  const ldapProvider = getLdapProviderByName(providerName);

  if (!ldapProvider) {
    logger.error('Proxy Auth: ldapGroupLookupProvider references non-existent LDAP provider', {
      component: 'ProxyAuth',
      ldapGroupLookupProvider: providerName
    });
    return [];
  }

  if (!ldapProvider.adminDn || !ldapProvider.adminPasswordRef) {
    logger.error(
      'Proxy Auth: LDAP provider for group lookup is missing adminDn or adminPasswordRef',
      {
        component: 'ProxyAuth',
        ldapProvider: providerName
      }
    );
    return [];
  }

  return await lookupLdapGroupsForUser(userId, ldapProvider);
}

async function getLdapGroupsForProxyUser(providerName, userId, ttlMs) {
  const cacheKey = getLdapGroupsCacheKey(providerName, userId);
  const now = Date.now();
  const entry = ldapGroupsCache.get(cacheKey);
  if (entry) {
    if (entry.fetchedAt !== undefined && now - entry.fetchedAt < ttlMs) {
      return entry.groups;
    }
    if (
      entry.failedAt !== undefined &&
      now - entry.failedAt < LDAP_GROUPS_FAILURE_COOLDOWN_MS
    ) {
      // Recent failure: skip the LDAP round-trip and return whatever we last
      // had (empty for a first-time failure, or the pre-outage groups).
      return entry.groups;
    }
  }

  const inFlight = ldapGroupsInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  const pending = (async () => {
    try {
      const groups = await fetchLdapGroupsForProxyUser(providerName, userId);
      if (ttlMs > 0) {
        storeLdapGroupsCacheEntry(cacheKey, { groups, fetchedAt: Date.now() });
      } else if (ldapGroupsCache.has(cacheKey)) {
        // TTL was lowered to 0 at runtime; drop any pre-existing entry so the
        // stale-fallback branch below can't hand back a value the operator
        // just asked us to stop caching.
        ldapGroupsCache.delete(cacheKey);
      }
      return groups;
    } catch (error) {
      // Fall back to the stale copy, if any, instead of locking a user out
      // while the directory is briefly unreachable.
      logger.error('Proxy Auth: LDAP group lookup failed, continuing with header/JWT groups only', {
        component: 'ProxyAuth',
        username: userId,
        ldapGroupLookupProvider: providerName,
        error
      });
      const staleGroups = entry?.groups ?? [];
      if (ttlMs > 0) {
        // Record the failure so the next request within the cooldown skips
        // another LDAP call. Even when the failure is because of pure
        // misconfiguration (bad DN, missing password) the cooldown is fine —
        // the operator has to change config to fix it either way.
        storeLdapGroupsCacheEntry(cacheKey, { groups: staleGroups, failedAt: Date.now() });
      }
      return staleGroups;
    } finally {
      ldapGroupsInFlight.delete(cacheKey);
    }
  })();

  ldapGroupsInFlight.set(cacheKey, pending);
  return pending;
}

async function requestJwks(jwkUrl, previous) {
  const attemptedAt = Date.now();
  try {
    const res = await httpFetch(jwkUrl);
    if (!res.ok) throw new Error(`Failed to load JWKs: ${res.status}`);
    const jwks = await res.json();
    jwksCache.set(jwkUrl, { jwks, fetchedAt: attemptedAt, lastAttemptAt: attemptedAt });
    return jwks;
  } catch (error) {
    logger.error('Error fetching JWKs', { component: 'ProxyAuth', error });
    // Record the attempt whatever the outcome, so an unreachable endpoint is
    // retried on a fixed interval instead of on every request. This has to
    // happen on a cold start too, where there is no stale document to carry
    // over — otherwise an outage at startup turns into one outbound call per
    // login attempt.
    jwksCache.set(jwkUrl, {
      jwks: previous?.jwks ?? null,
      fetchedAt: previous?.fetchedAt ?? 0,
      lastAttemptAt: attemptedAt
    });
    return null;
  }
}

function fetchJwks(jwkUrl, previous) {
  const inFlight = inFlightFetches.get(jwkUrl);
  if (inFlight) return inFlight;

  const pending = requestJwks(jwkUrl, previous).finally(() => inFlightFetches.delete(jwkUrl));
  inFlightFetches.set(jwkUrl, pending);
  return pending;
}

async function getJwks(jwkUrl, { forceRefresh = false } = {}) {
  const entry = jwksCache.get(jwkUrl);
  if (entry) {
    const now = Date.now();
    const fresh = now - entry.fetchedAt < JWKS_CACHE_TTL_MS;
    const throttled = now - entry.lastAttemptAt < JWKS_REFRESH_MIN_INTERVAL_MS;
    if ((fresh && !forceRefresh) || throttled) return entry.jwks;
  }

  // Fall back to the stale copy if the refresh fails, rather than locking every
  // user out while the IdP's JWKS endpoint is briefly unreachable.
  const jwks = await fetchJwks(jwkUrl, entry);
  return jwks || entry?.jwks || null;
}

function findSigningKey(jwks, kid) {
  if (!jwks?.keys?.length) return null;
  return (kid ? jwks.keys.find(k => k.kid === kid) : jwks.keys[0]) || null;
}

async function verifyJwt(token, provider) {
  try {
    const decoded = jwt.decode(token, { complete: true });
    const kid = decoded?.header?.kid;

    let jwks = await getJwks(provider.jwkUrl);
    let jwk = findSigningKey(jwks, kid);

    // An unknown `kid` normally means the IdP rotated keys since the last fetch;
    // refresh once before giving up instead of waiting out the full TTL.
    if (!jwk && kid) {
      jwks = await getJwks(provider.jwkUrl, { forceRefresh: true });
      jwk = findSigningKey(jwks, kid);
    }
    if (!jwk) throw new Error('Key not found');

    // Use jose to import the JWK and verify the JWT
    const publicKey = await jose.importJWK(jwk, 'RS256');
    const { payload } = await jose.jwtVerify(token, publicKey, {
      issuer: provider.issuer,
      audience: provider.audience
    });

    return payload;
  } catch (error) {
    logger.error('JWT verification failed', { component: 'ProxyAuth', error });
    return null;
  }
}

export async function proxyAuth(req, res, next) {
  const platform = configCache.getPlatform() || {};
  const proxyCfg = {
    enabled:
      (config.PROXY_AUTH_ENABLED ?? '').toLowerCase() === 'true' || platform?.proxyAuth?.enabled,
    userHeader:
      config.PROXY_AUTH_USER_HEADER || platform?.proxyAuth?.userHeader || 'x-forwarded-user',
    groupsHeader: config.PROXY_AUTH_GROUPS_HEADER || platform?.proxyAuth?.groupsHeader,
    jwtProviders: platform?.proxyAuth?.jwtProviders || [],
    ldapGroupLookupProvider: platform?.proxyAuth?.ldapGroupLookupProvider,
    ldapGroupLookupCacheTtlSeconds: platform?.proxyAuth?.ldapGroupLookupCacheTtlSeconds
  };

  if (!proxyCfg.enabled) {
    // Even if proxy auth is disabled, check for invalid JWT tokens from other auth modes
    const currentAuthMode = platform.auth?.mode || 'anonymous';
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ') && currentAuthMode === 'anonymous') {
      // In anonymous mode, JWT tokens are generally not valid, but admin tokens should be allowed
      // Admin authentication will be handled by the adminAuth middleware
      // Only warn for non-admin routes
      if (!req.path.startsWith('/api/admin/')) {
        logger.warn('Token rejected: JWT token not valid in current auth mode', {
          component: 'ProxyAuth',
          currentAuthMode
        });
      }
      // Don't set req.user, let it continue as anonymous (admin auth will handle admin routes)
    }

    return next();
  }

  let userId = req.headers[proxyCfg.userHeader.toLowerCase()];
  let groups = [];
  if (proxyCfg.groupsHeader) {
    const raw = req.headers[proxyCfg.groupsHeader.toLowerCase()];
    if (raw)
      groups = raw
        .split(',')
        .map(g => g.trim())
        .filter(Boolean);
  }

  let tokenPayload = null;
  for (const provider of proxyCfg.jwtProviders) {
    const hdr = (provider.header || 'authorization').toLowerCase();
    const value = req.headers[hdr];
    if (!value) continue;
    let token = value;
    if (hdr === 'authorization' && token.startsWith('Bearer ')) {
      token = token.slice(7);
    }
    tokenPayload = await verifyJwt(token, provider);
    if (tokenPayload) {
      // Check if token's auth method is still enabled
      // Allow tokens from any enabled auth method, regardless of primary auth mode
      const localAuthConfig = platform.localAuth || {};
      const oidcAuthConfig = platform.oidcAuth || {};

      let authMethodEnabled = false;
      if (tokenPayload.authMode === 'local' && localAuthConfig.enabled) {
        authMethodEnabled = true;
      } else if (tokenPayload.authMode === 'oidc' && oidcAuthConfig.enabled) {
        authMethodEnabled = true;
      } else if (!tokenPayload.authMode) {
        // Legacy tokens without authMode - allow if any auth method is enabled
        authMethodEnabled = true;
      }

      if (!authMethodEnabled) {
        logger.warn('Token rejected: authentication mode is disabled', {
          component: 'ProxyAuth',
          authMode: tokenPayload.authMode
        });
        tokenPayload = null; // Invalidate token from disabled auth method
        continue;
      }

      // For OIDC tokens, also check if the provider is still enabled and available
      if (tokenPayload.authMode === 'oidc' && tokenPayload.authProvider) {
        const oidcConfig = platform.oidcAuth || {};
        const enabledProviders = oidcConfig.enabled
          ? (oidcConfig.providers || []).map(p => p.name)
          : [];

        if (!enabledProviders.includes(tokenPayload.authProvider)) {
          logger.warn('Token rejected: OIDC provider is no longer enabled', {
            component: 'ProxyAuth',
            authProvider: tokenPayload.authProvider
          });
          tokenPayload = null; // Invalidate token from disabled provider
          continue;
        }
      }

      break;
    }
  }

  if (tokenPayload) {
    if (!userId) {
      userId =
        tokenPayload.preferred_username ||
        tokenPayload.upn ||
        tokenPayload.email ||
        tokenPayload.sub;
    }
    if (Array.isArray(tokenPayload.groups)) {
      groups = groups.concat(tokenPayload.groups);
    }
  }

  if (!userId) {
    req.user = null;
    return next();
  }

  if (proxyCfg.ldapGroupLookupProvider) {
    const ttlSeconds = Number.isFinite(proxyCfg.ldapGroupLookupCacheTtlSeconds)
      ? proxyCfg.ldapGroupLookupCacheTtlSeconds
      : DEFAULT_LDAP_GROUPS_TTL_MS / 1000;
    const ttlMs = Math.max(0, ttlSeconds) * 1000;
    const ldapGroups = await getLdapGroupsForProxyUser(
      proxyCfg.ldapGroupLookupProvider,
      userId,
      ttlMs
    );
    if (ldapGroups.length > 0) {
      groups = [...new Set([...groups, ...ldapGroups])];
    }
  }

  let user = {
    id: userId,
    name:
      req.headers['x-forwarded-name'] ||
      (tokenPayload &&
        (tokenPayload.name ||
          (tokenPayload.given_name && tokenPayload.family_name
            ? `${tokenPayload.given_name} ${tokenPayload.family_name}`.trim()
            : tokenPayload.given_name || tokenPayload.family_name))) ||
      userId,
    email: req.headers['x-forwarded-email'] || (tokenPayload && tokenPayload.email) || null,
    groups: [], // Will be populated by merging external and internal groups
    externalGroups: groups, // Store raw external groups for mapping and merging
    authenticated: true,
    authMethod: 'proxy'
  };

  try {
    // Validate and persist proxy user using centralized function
    user = await validateAndPersistExternalUser(user, platform);

    // Enhance user with authenticated group
    const authConfig = platform.auth || {};
    user = enhanceUserGroups(user, authConfig);

    req.user = user;
    next();
  } catch (error) {
    logger.error('Proxy user validation error', { component: 'ProxyAuth', error });
    // Return a 403 Forbidden with a user-friendly error message
    res.status(403).json({
      error: 'Access Denied',
      message: error.message,
      code: 'USER_VALIDATION_FAILED'
    });
  }
}
