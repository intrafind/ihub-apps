import jwt from 'jsonwebtoken';
import config from '../config.js';
import configCache from '../configCache.js';

/**
 * JWT authentication middleware
 * Validates JWT tokens issued by our system regardless of auth mode (local, oidc, etc.)
 */
export default function jwtAuthMiddleware(req, res, next) {
  console.log('🔐 jwtAuth: Called for URL:', req.url, req.method);
  
  if (req.user && req.user.id !== 'anonymous') {
    console.log('🔐 jwtAuth: User already set, skipping JWT validation');
    return next();
  }

  // Check for token in cookies first (preferred for SSE), then Authorization header
  let token = null;
  
  // Check HTTP-only cookie first
  if (req.cookies && req.cookies.authToken) {
    token = req.cookies.authToken;
    console.log('🔐 jwtAuth: Token found in cookie');
  }
  // Fallback to Authorization header for API calls
  else {
    const authHeader = req.headers.authorization;
    console.log('🔐 jwtAuth: Authorization header:', authHeader);
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
      console.log('🔐 jwtAuth: Token found in Authorization header');
    }
  }
  
  if (!token) {
    console.log('🔐 jwtAuth: No token found in cookies or headers, continuing as anonymous');
    return next(); // No token, continue as anonymous
  }

  console.log('🔐 jwtAuth: Extracted token:', token.substring(0, 20) + '...');

  const platform = configCache.getPlatform() || {};
  const jwtSecret = config.JWT_SECRET || platform.auth?.jwtSecret;

  if (!jwtSecret) {
    console.warn('🔐 JWT Auth: No JWT secret configured');
    return next(); // No JWT secret configured
  }

  try {
    const decoded = jwt.verify(token, jwtSecret, {
      issuer: 'ai-hub-apps',
      maxAge: '7d'
    });

    const now = Math.floor(Date.now() / 1000);
    if (decoded.exp && decoded.exp < now) {
      console.log('🔐 jwtAuth: Token expired');
      return res.status(401).json({
        error: 'Token expired',
        code: 'TOKEN_EXPIRED',
        message: 'Your session has expired. Please log in again.'
      });
    }

    // Create user object based on token payload
    let user;
    if (decoded.authMode === 'local') {
      user = {
        id: decoded.username,
        username: decoded.username,
        name: decoded.name || decoded.username,
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

    console.log('🔐 jwtAuth: Successfully decoded token for user:', user.id);
    req.user = user;

    return next();
  } catch (err) {
    console.warn('🔐 jwtAuth: Token validation failed:', err.message);
    return next();
  }
}
