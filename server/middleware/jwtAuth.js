import jwt from 'jsonwebtoken';
import config from '../config.js';
import configCache from '../configCache.js';

/**
 * JWT authentication middleware
 * Validates JWT tokens issued by our system regardless of auth mode (local, oidc, etc.)
 */
export default function jwtAuthMiddleware(req, res, next) {
  if (req.user && req.user.id !== 'anonymous') {
    return next();
  }

  // Check for token in cookies first (preferred for SSE), then Authorization header
  let token = null;
  let tokenSource = 'none';

  // Check HTTP-only cookie first
  if (req.cookies && req.cookies.authToken) {
    token = req.cookies.authToken;
    tokenSource = 'cookie';
  }
  // Fallback to Authorization header for API calls
  else {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
      tokenSource = 'header';
    }
  }

  if (!token) {
    return next(); // No token, continue as anonymous
  }

  const platform = configCache.getPlatform() || {};
  const jwtSecret = config.JWT_SECRET || platform.auth?.jwtSecret;

  if (!jwtSecret) {
    console.warn('🔐 JWT Auth: No JWT secret configured');
    return next(); // No JWT secret configured
  }

  try {
    const decoded = jwt.verify(token, jwtSecret, {
      issuer: 'ihub-apps',
      maxAge: '7d'
    });

    // Debug: Log JWT payload in development
    if (process.env.NODE_ENV === 'development') {
      console.log('🔐 JWT User authenticated:', {
        userId: decoded.sub || decoded.username || decoded.id,
        name: decoded.name,
        authMode: decoded.authMode
      });
    }

    const now = Math.floor(Date.now() / 1000);
    if (decoded.exp && decoded.exp < now) {
      return res.status(401).json({
        error: 'Token expired',
        code: 'TOKEN_EXPIRED',
        message: 'Your session has expired. Please log in again.'
      });
    }

    // Create user object based on token payload
    let user;
    if (decoded.authMode === 'local') {
      // For local auth, the user ID is stored in the 'sub' field
      const userId = decoded.sub || decoded.username || decoded.id;
      user = {
        id: userId,
        username: decoded.username || userId,
        name: decoded.name || decoded.username || userId,
        email: decoded.email || '',
        groups: decoded.groups || [],
        authMode: 'local',
        timestamp: Date.now()
      };
    } else if (decoded.authMode === 'oidc') {
      user = {
        id: decoded.sub || decoded.username,
        username: decoded.username || decoded.preferred_username || decoded.sub,
        name: decoded.name || decoded.given_name || decoded.username,
        email: decoded.email || '',
        groups: decoded.groups || [],
        authMode: 'oidc',
        timestamp: Date.now()
      };
    } else if (decoded.authMode === 'ldap') {
      user = {
        id: decoded.username,
        username: decoded.username,
        name: decoded.name || decoded.displayName || decoded.username,
        email: decoded.email || decoded.mail || '',
        groups: decoded.groups || [],
        authMode: 'ldap',
        timestamp: Date.now()
      };
    } else if (decoded.authMode === 'teams') {
      user = {
        id: decoded.id || decoded.sub,
        username: decoded.username || decoded.userPrincipalName,
        name: decoded.name || decoded.displayName,
        email: decoded.email || decoded.userPrincipalName,
        groups: decoded.groups || [],
        authMode: 'teams',
        timestamp: Date.now()
      };
    } else {
      // Fallback for unknown auth modes
      user = {
        id: decoded.sub || decoded.username || decoded.id,
        username: decoded.username || decoded.preferred_username || decoded.sub,
        name: decoded.name || decoded.username,
        email: decoded.email || '',
        groups: decoded.groups || [],
        authMode: decoded.authMode || 'unknown',
        timestamp: Date.now()
      };
    }

    req.user = user;
    return next();
  } catch (err) {
    console.warn('🔐 jwtAuth: Token validation failed:', err.message);
    return next();
  }
}
