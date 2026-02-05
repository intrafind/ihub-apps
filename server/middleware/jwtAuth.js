import jwt from 'jsonwebtoken';
import config from '../config.js';
import configCache from '../configCache.js';
import { loadOAuthClients, findClientById } from '../utils/oauthClientManager.js';
import { loadUsers, isUserActive } from '../utils/userManager.js';
import logger from '../utils/logger.js';

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

  // Check HTTP-only cookie first
  if (req.cookies && req.cookies.authToken) {
    token = req.cookies.authToken;
  }
  // Fallback to Authorization header for API calls
  else {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    }
  }

  if (!token) {
    return next(); // No token, continue as anonymous
  }

  const platform = configCache.getPlatform() || {};
  const jwtSecret = config.JWT_SECRET || platform.auth?.jwtSecret;

  if (!jwtSecret) {
    logger.warn('🔐 JWT Auth: No JWT secret configured');
    return next(); // No JWT secret configured
  }

  try {
    const decoded = jwt.verify(token, jwtSecret, {
      issuer: 'ihub-apps',
      maxAge: '7d'
    });

    // Debug: Log JWT payload in development
    if (process.env.NODE_ENV === 'development') {
      logger.info('🔐 JWT User authenticated:', {
        userId: decoded.sub || decoded.username || decoded.id,
        name: decoded.name,
        authMode: decoded.authMode
      });
    }

    const now = Math.floor(Date.now() / 1000);
    if (decoded.exp && decoded.exp < now) {
      // For /api/auth/status endpoint, don't return 401 on expired token
      // Allow the endpoint to respond with proper auth status and auto-redirect info
      if (req.path === '/api/auth/status') {
        logger.info('🔐 JWT Auth: Token expired, continuing to status endpoint');
        return next();
      }

      return res.status(401).json({
        error: 'Token expired',
        code: 'TOKEN_EXPIRED',
        message: 'Your session has expired. Please log in again.'
      });
    }

    // Create user object based on token payload
    let user;
    if (
      decoded.authMode === 'oauth_client_credentials' ||
      decoded.authMode === 'oauth_static_api_key'
    ) {
      // OAuth client credentials - this is a machine-to-machine token
      // Validate that the client is still active and token was issued after last rotation
      const oauthConfig = platform.oauth || {};
      if (oauthConfig.enabled) {
        try {
          const clientsFilePath = oauthConfig.clientsFile || 'contents/config/oauth-clients.json';
          const clientsConfig = loadOAuthClients(clientsFilePath);
          const client = findClientById(clientsConfig, decoded.client_id);

          if (!client) {
            logger.warn(
              `[OAuth] Token rejected: client not found | client_id=${decoded.client_id}`
            );
            return res.status(401).json({
              error: 'invalid_token',
              error_description: 'OAuth client no longer exists'
            });
          }

          if (!client.active) {
            logger.warn(
              `[OAuth] Token rejected: client suspended | client_id=${decoded.client_id}`
            );
            return res.status(403).json({
              error: 'access_denied',
              error_description: 'OAuth client has been suspended'
            });
          }

          // Check if token was issued before the last secret rotation
          if (client.lastRotated) {
            const tokenIssuedAt = decoded.iat * 1000; // Convert to milliseconds
            const lastRotatedAt = new Date(client.lastRotated).getTime();

            if (tokenIssuedAt < lastRotatedAt) {
              logger.warn(
                `[OAuth] Token rejected: issued before secret rotation | client_id=${decoded.client_id} | token_iat=${new Date(tokenIssuedAt).toISOString()} | last_rotated=${client.lastRotated}`
              );
              return res.status(401).json({
                error: 'invalid_token',
                error_description: 'Token was issued before the last secret rotation'
              });
            }
          }

          // Permissions are retrieved from the client config, not the token
          // This allows revoking access without invalidating tokens
          user = {
            id: decoded.client_id,
            username: decoded.client_name || decoded.client_id,
            name: decoded.client_name || decoded.client_id,
            email: '', // OAuth clients don't have email
            groups: decoded.groups || ['oauth_clients'],
            authMode: decoded.authMode,
            timestamp: Date.now(),
            // OAuth-specific fields
            isOAuthClient: true,
            scopes: decoded.scopes || [],
            allowedApps: client.allowedApps || [],
            allowedModels: client.allowedModels || [],
            staticKey: decoded.static_key || false
          };
        } catch (loadError) {
          logger.error('[OAuth] Failed to validate client status:', loadError);
          // Continue anyway to avoid breaking on config errors
          user = {
            id: decoded.client_id,
            username: decoded.client_name || decoded.client_id,
            name: decoded.client_name || decoded.client_id,
            email: '',
            groups: decoded.groups || ['oauth_clients'],
            authMode: decoded.authMode,
            timestamp: Date.now(),
            isOAuthClient: true,
            scopes: decoded.scopes || [],
            allowedApps: [],
            allowedModels: [],
            staticKey: decoded.static_key || false
          };
        }
      } else {
        // OAuth not enabled, but token is OAuth type - reject
        logger.warn('[OAuth] Token rejected: OAuth not enabled');
        return res.status(401).json({
          error: 'invalid_token',
          error_description: 'OAuth authentication is not enabled'
        });
      }
    } else if (decoded.authMode === 'local') {
      // For local auth, validate that user still exists and is active
      const localAuthConfig = platform.localAuth || {};
      if (localAuthConfig.enabled) {
        try {
          const usersFilePath = localAuthConfig.usersFile || 'contents/config/users.json';
          const usersConfig = loadUsers(usersFilePath);
          const userId = decoded.sub || decoded.username || decoded.id;

          // Find the user in the database
          const userRecord = usersConfig.users?.[userId];

          if (!userRecord) {
            logger.warn(`[JWT Auth] Token rejected: user not found | user_id=${userId}`);
            return res.status(401).json({
              error: 'invalid_token',
              error_description: 'User account no longer exists'
            });
          }

          if (!isUserActive(userRecord)) {
            logger.warn(`[JWT Auth] Token rejected: user account disabled | user_id=${userId}`);
            return res.status(403).json({
              error: 'access_denied',
              error_description: 'User account has been disabled'
            });
          }

          // User exists and is active, create user object from token
          user = {
            id: userId,
            username: decoded.username || userId,
            name: decoded.name || decoded.username || userId,
            email: decoded.email || '',
            groups: decoded.groups || [],
            authMode: 'local',
            timestamp: Date.now()
          };
        } catch (loadError) {
          logger.error('[JWT Auth] Failed to validate user status:', loadError);
          // Return 503 error to prevent authentication bypass
          // We cannot safely validate the user, so we must reject the request
          return res.status(503).json({
            error: 'service_unavailable',
            error_description: 'Unable to validate user credentials. Please try again later.'
          });
        }
      } else {
        // Local auth not enabled, but token is local type - reject
        logger.warn('[JWT Auth] Token rejected: Local authentication is not enabled');
        return res.status(401).json({
          error: 'invalid_token',
          error_description: 'Local authentication is not enabled'
        });
      }
    } else if (decoded.authMode === 'oidc') {
      // For OIDC auth, validate that user still exists and is active
      // OIDC users are persisted to users.json via validateAndPersistExternalUser
      try {
        const usersFilePath = platform.localAuth?.usersFile || 'contents/config/users.json';
        const usersConfig = loadUsers(usersFilePath);

        // OIDC users can be identified by their subject ID or email
        const userId = decoded.sub || decoded.username;
        let userRecord = usersConfig.users?.[userId];

        // If not found by ID, try to find by email (OIDC users may have different IDs)
        if (!userRecord && decoded.email) {
          userRecord = Object.values(usersConfig.users || {}).find(
            u => u.email === decoded.email && u.authMethods?.includes('oidc')
          );
        }

        if (userRecord && !isUserActive(userRecord)) {
          logger.warn(
            `[JWT Auth] Token rejected: OIDC user account disabled | user_id=${userRecord.id}`
          );
          return res.status(403).json({
            error: 'access_denied',
            error_description: 'User account has been disabled'
          });
        }

        // User either doesn't exist (not yet persisted) or is active
        user = {
          id: decoded.sub || decoded.username,
          username: decoded.username || decoded.preferred_username || decoded.sub,
          name: decoded.name || decoded.given_name || decoded.username,
          email: decoded.email || '',
          groups: decoded.groups || [],
          authMode: 'oidc',
          timestamp: Date.now()
        };
      } catch (loadError) {
        logger.error('[JWT Auth] Failed to validate OIDC user status:', loadError);
        // Return 503 error to prevent authentication bypass
        return res.status(503).json({
          error: 'service_unavailable',
          error_description: 'Unable to validate user credentials. Please try again later.'
        });
      }
    } else if (decoded.authMode === 'ldap') {
      // For LDAP auth, validate that user still exists and is active
      // LDAP users may be persisted to users.json
      try {
        const usersFilePath = platform.localAuth?.usersFile || 'contents/config/users.json';
        const usersConfig = loadUsers(usersFilePath);

        const userId = decoded.username;
        let userRecord = usersConfig.users?.[userId];

        // If not found by username, try to find by email
        if (!userRecord && decoded.email) {
          userRecord = Object.values(usersConfig.users || {}).find(
            u => u.email === decoded.email && u.authMethods?.includes('ldap')
          );
        }

        if (userRecord && !isUserActive(userRecord)) {
          logger.warn(
            `[JWT Auth] Token rejected: LDAP user account disabled | user_id=${userRecord.id}`
          );
          return res.status(403).json({
            error: 'access_denied',
            error_description: 'User account has been disabled'
          });
        }

        user = {
          id: decoded.username,
          username: decoded.username,
          name: decoded.name || decoded.displayName || decoded.username,
          email: decoded.email || decoded.mail || '',
          groups: decoded.groups || [],
          authMode: 'ldap',
          timestamp: Date.now()
        };
      } catch (loadError) {
        logger.error('[JWT Auth] Failed to validate LDAP user status:', loadError);
        return res.status(503).json({
          error: 'service_unavailable',
          error_description: 'Unable to validate user credentials. Please try again later.'
        });
      }
    } else if (decoded.authMode === 'teams') {
      // For Teams auth, validate that user still exists and is active
      // Teams users are persisted to users.json via validateAndPersistExternalUser
      try {
        const usersFilePath = platform.localAuth?.usersFile || 'contents/config/users.json';
        const usersConfig = loadUsers(usersFilePath);

        const userId = decoded.id || decoded.sub;
        let userRecord = usersConfig.users?.[userId];

        // If not found by ID, try to find by email
        if (!userRecord && decoded.email) {
          userRecord = Object.values(usersConfig.users || {}).find(
            u => u.email === decoded.email && u.authMethods?.includes('teams')
          );
        }

        if (userRecord && !isUserActive(userRecord)) {
          logger.warn(
            `[JWT Auth] Token rejected: Teams user account disabled | user_id=${userRecord.id}`
          );
          return res.status(403).json({
            error: 'access_denied',
            error_description: 'User account has been disabled'
          });
        }

        user = {
          id: decoded.id || decoded.sub,
          username: decoded.username || decoded.userPrincipalName,
          name: decoded.name || decoded.displayName,
          email: decoded.email || decoded.userPrincipalName,
          groups: decoded.groups || [],
          authMode: 'teams',
          timestamp: Date.now()
        };
      } catch (loadError) {
        logger.error('[JWT Auth] Failed to validate Teams user status:', loadError);
        return res.status(503).json({
          error: 'service_unavailable',
          error_description: 'Unable to validate user credentials. Please try again later.'
        });
      }
    } else if (decoded.authMode === 'ntlm') {
      // For NTLM auth, validate that user still exists and is active
      // NTLM users are persisted to users.json via validateAndPersistExternalUser
      try {
        const usersFilePath = platform.localAuth?.usersFile || 'contents/config/users.json';
        const usersConfig = loadUsers(usersFilePath);

        const userId = decoded.id || decoded.sub;
        let userRecord = usersConfig.users?.[userId];

        // If not found by ID, try to find by ntlmData.subject or email
        if (!userRecord) {
          userRecord = Object.values(usersConfig.users || {}).find(
            u =>
              (u.ntlmData?.subject === userId && u.authMethods?.includes('ntlm')) ||
              (decoded.email && u.email === decoded.email && u.authMethods?.includes('ntlm'))
          );
        }

        if (userRecord && !isUserActive(userRecord)) {
          logger.warn(
            `[JWT Auth] Token rejected: NTLM user account disabled | user_id=${userRecord.id}`
          );
          return res.status(403).json({
            error: 'access_denied',
            error_description: 'User account has been disabled'
          });
        }

        user = {
          id: decoded.id || decoded.sub,
          username: decoded.username || decoded.id,
          name: decoded.name || decoded.id,
          email: decoded.email || '',
          groups: decoded.groups || [],
          authMode: 'ntlm',
          domain: decoded.domain,
          timestamp: Date.now()
        };
      } catch (loadError) {
        logger.error('[JWT Auth] Failed to validate NTLM user status:', loadError);
        return res.status(503).json({
          error: 'service_unavailable',
          error_description: 'Unable to validate user credentials. Please try again later.'
        });
      }
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
    // For /api/auth/status endpoint, allow expired/invalid tokens to pass through
    // so the endpoint can respond with proper auth status and auto-redirect info
    if (req.path === '/api/auth/status' && err.name === 'TokenExpiredError') {
      logger.info('🔐 JWT Auth: Expired token on status endpoint, continuing');
      return next();
    }

    logger.warn('🔐 jwtAuth: Token validation failed:', err.message);
    return next();
  }
}
