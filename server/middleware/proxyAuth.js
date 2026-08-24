import jwt from 'jsonwebtoken';
import { httpFetch } from '../utils/httpConfig.js';
import * as jose from 'jose';
import config from '../config.js';
import configCache from '../configCache.js';
import { enhanceUserGroups } from '../utils/authorization.js';
import { validateAndPersistExternalUser } from '../utils/userManager.js';
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

async function fetchJwks(jwkUrl, previous) {
  // Record the attempt regardless of outcome so a persistently unreachable
  // endpoint is retried on a fixed interval instead of on every request.
  const attemptedAt = Date.now();
  try {
    const res = await httpFetch(jwkUrl);
    if (!res.ok) throw new Error(`Failed to load JWKs: ${res.status}`);
    const jwks = await res.json();
    jwksCache.set(jwkUrl, { jwks, fetchedAt: attemptedAt, lastAttemptAt: attemptedAt });
    return jwks;
  } catch (error) {
    logger.error('Error fetching JWKs', { component: 'ProxyAuth', error });
    if (previous) jwksCache.set(jwkUrl, { ...previous, lastAttemptAt: attemptedAt });
    return null;
  }
}

async function getJwks(jwkUrl, { forceRefresh = false } = {}) {
  const entry = jwksCache.get(jwkUrl);
  if (entry) {
    const fresh = Date.now() - entry.fetchedAt < JWKS_CACHE_TTL_MS;
    const throttled = Date.now() - entry.lastAttemptAt < JWKS_REFRESH_MIN_INTERVAL_MS;
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
    jwtProviders: platform?.proxyAuth?.jwtProviders || []
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
