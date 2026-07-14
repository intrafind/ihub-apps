import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import { promisify } from 'util';
import config from '../config.js';
import configCache from '../configCache.js';
import { enhanceUserGroups } from '../utils/authorization.js';
import { validateAndPersistExternalUser } from '../utils/userManager.js';
import logger from '../utils/logger.js';

// JWKS clients per provider jwkUrl, each with its own TTL'd key cache so
// rotated IdP signing keys are picked up instead of being cached forever.
const jwksClients = new Map();

function getJwksClient(jwkUrl) {
  if (!jwksClients.has(jwkUrl)) {
    jwksClients.set(
      jwkUrl,
      jwksRsa({
        jwksUri: jwkUrl,
        cache: true,
        cacheMaxEntries: 5,
        cacheMaxAge: 10 * 60 * 60 * 1000 // 10 hours
      })
    );
  }
  return jwksClients.get(jwkUrl);
}

async function verifyJwt(token, provider) {
  try {
    const decoded = jwt.decode(token, { complete: true });
    const kid = decoded?.header?.kid;

    const client = getJwksClient(provider.jwkUrl);
    const getSigningKey = promisify(client.getSigningKey);
    const key = await getSigningKey(kid);
    const signingKey = key.publicKey || key.rsaPublicKey;

    const payload = jwt.verify(token, signingKey, {
      algorithms: ['RS256'],
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
