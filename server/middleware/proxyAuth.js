import fetch from 'node-fetch';
import jwt from 'jsonwebtoken';
import jwkToPem from 'jwk-to-pem';
import config from '../config.js';
import configCache from '../configCache.js';
import { enhanceUserGroups } from '../utils/authorization.js';
import { validateAndPersistExternalUser } from '../utils/userManager.js';
import logger from '../utils/logger.js';

const jwksCache = new Map();

async function getJwks(jwkUrl) {
  if (jwksCache.has(jwkUrl)) return jwksCache.get(jwkUrl);
  try {
    const res = await fetch(jwkUrl);
    if (!res.ok) throw new Error(`Failed to load JWKs: ${res.status}`);
    const jwks = await res.json();
    jwksCache.set(jwkUrl, jwks);
    return jwks;
  } catch (err) {
    logger.error('Error fetching JWKs', err);
    return null;
  }
}

async function verifyJwt(token, provider) {
  try {
    const jwks = await getJwks(provider.jwkUrl);
    if (!jwks || !jwks.keys?.length) throw new Error('No keys');
    const decoded = jwt.decode(token, { complete: true });
    const kid = decoded?.header?.kid;
    const jwk = kid ? jwks.keys.find(k => k.kid === kid) : jwks.keys[0];
    if (!jwk) throw new Error('Key not found');
    const pem = jwkToPem(jwk);
    return jwt.verify(token, pem, {
      algorithms: ['RS256'],
      issuer: provider.issuer,
      audience: provider.audience
    });
  } catch (err) {
    logger.error('JWT verification failed', err.message);
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
        logger.warn(`🔐 Token rejected: JWT token not valid in ${currentAuthMode} mode`);
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
        logger.warn(`🔐 Token rejected: ${tokenPayload.authMode} authentication is disabled`);
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
          logger.warn(
            `🔐 Token rejected: OIDC provider '${tokenPayload.authProvider}' is no longer enabled`
          );
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
    logger.error('Proxy user validation error:', error.message);
    // Return a 403 Forbidden with a user-friendly error message
    res.status(403).json({
      error: 'Access Denied',
      message: error.message,
      code: 'USER_VALIDATION_FAILED'
    });
  }
}
