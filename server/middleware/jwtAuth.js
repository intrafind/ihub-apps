import jwt from 'jsonwebtoken';
import config from '../config.js';
import configCache from '../configCache.js';

/**
 * Unified JWT token validation middleware
 * Validates JWT tokens issued by our system regardless of auth mode (local, oidc, etc.)
 */
export default function jwtAuthMiddleware(req, res, next) {
  // Skip if user is already authenticated by another middleware
  if (req.user && req.user.id !== 'anonymous') {
    return next();
  }

  // Check for Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(); // No token, continue as anonymous
  }

  console.debug('🔐 JWT Auth: Processing Bearer token for', req.url);

  const token = authHeader.substring(7);

  const platform = configCache.getPlatform() || {};
  const jwtSecret = config.JWT_SECRET || platform.auth?.jwtSecret;

  if (!jwtSecret || jwtSecret === '${JWT_SECRET}') {
    console.warn('🔐 JWT Auth: No JWT secret configured');
    return next(); // No JWT secret configured
  }

  try {
    // Verify and decode the JWT token
    const decoded = jwt.verify(token, jwtSecret, {
      issuer: 'ai-hub-apps',
      audience: 'ai-hub-apps'
    });

    // Check token expiration
    const now = Math.floor(Date.now() / 1000);
    if (decoded.exp && decoded.exp < now) {
      return next(); // Expired token, continue as anonymous
    }

    // Reconstruct user object from token based on auth mode
    let user;

    if (decoded.authMode === 'local') {
      // Local authentication token
      user = {
        id: decoded.sub || decoded.id,
        name: decoded.name,
        email: decoded.email,
        groups: decoded.groups || [],
        authMethod: 'local',
        authenticated: true
      };
    } else if (decoded.authMode === 'oidc') {
      // OIDC authentication token
      user = {
        id: decoded.sub, // OIDC uses 'sub' for user ID
        name: decoded.name,
        email: decoded.email,
        groups: decoded.groups || [],
        provider: decoded.provider || decoded.authProvider,
        authMethod: 'oidc',
        authProvider: decoded.authProvider,
        authenticated: true
      };
    } else {
      // Unknown auth mode, but valid token - use generic structure
      user = {
        id: decoded.sub || decoded.id,
        name: decoded.name,
        email: decoded.email,
        groups: decoded.groups || [],
        authMethod: decoded.authMode || 'unknown',
        authenticated: true
      };
    }

    req.user = user;
    console.debug('🔐 JWT Auth: Successfully authenticated user:', user.id, 'for', req.url);
    return next();
  } catch (error) {
    // Invalid token, continue as anonymous
    console.warn('🔐 JWT token validation failed:', error.message);
    return next();
  }
}
