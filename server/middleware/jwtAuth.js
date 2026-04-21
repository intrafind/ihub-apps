import { loadOAuthClients, findClientById } from '../utils/oauthClientManager.js';
import { loadUsers, isUserActive } from '../utils/userManager.js';
import { verifyJwt, decodeJwt } from '../utils/tokenService.js';
import configCache from '../configCache.js';
import logger from '../utils/logger.js';

/**
 * JWT authentication middleware
 * Validates JWT tokens issued by our system regardless of auth mode (local, oidc, etc.)
 */
export default function jwtAuthMiddleware(req, res, next) {
  if (req.user && req.user.id !== 'anonymous') {
    return next();
  }

  // Check for token in Authorization header first, then fall back to cookie.
  // Explicit Bearer tokens (e.g. from the Office add-in OAuth flow) must take precedence
  // over the main-app session cookie so that the correct auth mode is used.
  // SSE connections cannot send custom headers and rely on the cookie, but they also
  // never send an Authorization header, so this order is safe for both.
  let token = null;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.cookies && req.cookies.authToken) {
    token = req.cookies.authToken;
  }

  if (!token) {
    return next(); // No token, continue as anonymous
  }

  const platform = configCache.getPlatform() || {};

  try {
    let decoded = verifyJwt(token);

    // If standard verification failed, check if it's an OAuth authorization code token
    // with a client-specific audience (aud: clientId instead of 'ihub-apps')
    if (!decoded) {
      const peeked = decodeJwt(token);
      if (
        peeked?.payload?.authMode === 'oauth_authorization_code' &&
        peeked?.payload?.aud &&
        peeked.payload.aud !== 'ihub-apps'
      ) {
        // Verify the audience against registered OAuth clients before using it
        // This prevents an attacker from using an arbitrary audience claim to influence verification
        const oauthConfig = platform.oauth || {};
        if (oauthConfig.enabled?.clients) {
          try {
            const clientsFilePath = oauthConfig.clientsFile || 'contents/config/oauth-clients.json';
            const clientsConfig = loadOAuthClients(clientsFilePath);
            if (clientsConfig.clients[peeked.payload.aud]) {
              decoded = verifyJwt(token, { audience: peeked.payload.aud });
            }
          } catch {
            // If we can't load clients, don't allow the alternative audience
          }
        }
      }
    }

    if (!decoded) {
      logger.warn('JWT Auth: Token verification failed', { component: 'JwtAuth' });
      return next(); // Invalid token, continue as anonymous
    }

    // Debug: Log JWT payload in development
    if (process.env.NODE_ENV === 'development') {
      logger.info('JWT user authenticated', {
        component: 'JwtAuth',
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
        logger.info('JWT Auth: Token expired, continuing to status endpoint', {
          component: 'JwtAuth'
        });
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
      if (oauthConfig.enabled?.clients) {
        try {
          const clientsFilePath = oauthConfig.clientsFile || 'contents/config/oauth-clients.json';
          const clientsConfig = loadOAuthClients(clientsFilePath);
          const client = findClientById(clientsConfig, decoded.client_id);

          if (!client) {
            logger.warn('OAuth token rejected: client not found', {
              component: 'JwtAuth',
              clientId: decoded.client_id
            });
            return res.status(401).json({
              error: 'invalid_token',
              error_description: 'OAuth client no longer exists'
            });
          }

          if (!client.active) {
            logger.warn('OAuth token rejected: client suspended', {
              component: 'JwtAuth',
              clientId: decoded.client_id
            });
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
              logger.warn('OAuth token rejected: issued before secret rotation', {
                component: 'JwtAuth',
                clientId: decoded.client_id,
                tokenIssuedAt: new Date(tokenIssuedAt).toISOString(),
                lastRotated: client.lastRotated
              });
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
          logger.error('OAuth failed to validate client status', {
            component: 'JwtAuth',
            error: loadError
          });
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
        // OAuth clients not enabled, but token is OAuth type - reject
        logger.warn('OAuth token rejected: OAuth clients not enabled', { component: 'JwtAuth' });
        res.clearCookie('authToken', {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax'
        });
        if (req.path === '/api/auth/status') {
          return next(); // Continue as anonymous — let status endpoint return available auth methods
        }
        return res.status(401).json({
          error: 'invalid_token',
          error_description: 'OAuth clients are not enabled'
        });
      }
    } else if (decoded.authMode === 'oauth_authorization_code') {
      // OAuth authorization code - this is a user-delegated token
      // The token carries user identity, validate the user is still active
      const oauthConfig = platform.oauth || {};
      if (oauthConfig.enabled?.authz) {
        try {
          const usersFilePath = platform.localAuth?.usersFile || 'contents/config/users.json';
          const usersConfig = loadUsers(usersFilePath);
          const userId = decoded.sub || decoded.username || decoded.id;
          const userRecord = usersConfig.users?.[userId];

          if (userRecord && !isUserActive(userRecord)) {
            logger.warn('OAuth token rejected: user account disabled', {
              component: 'JwtAuth',
              userId
            });
            return res.status(403).json({
              error: 'access_denied',
              error_description: 'User account has been disabled'
            });
          }

          // Load OAuth client to apply current per-client permission restrictions.
          // Client restrictions are looked up fresh on every request so that admin
          // changes take effect immediately without waiting for token refresh.
          let clientAllowedApps = [];
          let clientAllowedModels = [];
          let clientAllowedPrompts = [];
          if (decoded.client_id) {
            try {
              const clientsFilePath =
                oauthConfig.clientsFile || 'contents/config/oauth-clients.json';
              const clientsConfig = loadOAuthClients(clientsFilePath);
              const client = findClientById(clientsConfig, decoded.client_id);

              if (!client) {
                logger.warn('OAuth auth-code token rejected: client no longer exists', {
                  component: 'JwtAuth',
                  clientId: decoded.client_id
                });
                return res.status(401).json({
                  error: 'invalid_token',
                  error_description: 'OAuth client no longer exists'
                });
              }

              if (!client.active) {
                logger.warn('OAuth auth-code token rejected: client suspended', {
                  component: 'JwtAuth',
                  clientId: decoded.client_id
                });
                return res.status(403).json({
                  error: 'access_denied',
                  error_description: 'OAuth client has been suspended'
                });
              }

              clientAllowedApps = Array.isArray(client.allowedApps) ? client.allowedApps : [];
              clientAllowedModels = Array.isArray(client.allowedModels) ? client.allowedModels : [];
              clientAllowedPrompts = Array.isArray(client.allowedPrompts)
                ? client.allowedPrompts
                : [];
            } catch (clientLoadError) {
              logger.error('OAuth failed to load client for auth-code token', {
                component: 'JwtAuth',
                error: clientLoadError
              });
              // Fail closed: if we cannot verify client restrictions, reject the request
              return res.status(503).json({
                error: 'service_unavailable',
                error_description: 'Unable to validate OAuth client. Please try again later.'
              });
            }
          }

          user = {
            id: userId,
            username: decoded.username || decoded.preferred_username || userId,
            name: decoded.name || decoded.username || userId,
            email: decoded.email || '',
            groups: decoded.groups || [],
            authMode: 'oauth_authorization_code',
            timestamp: Date.now(),
            isOAuthAuthCode: true,
            clientId: decoded.client_id || null,
            scopes: decoded.scopes || [],
            // Per-client restrictions applied as a filter on top of the user's
            // group permissions (see enhanceUserWithPermissions).
            clientAllowedApps,
            clientAllowedModels,
            clientAllowedPrompts
          };
        } catch (loadError) {
          logger.error('OAuth failed to validate user for auth code token', {
            component: 'JwtAuth',
            error: loadError
          });
          return res.status(503).json({
            error: 'service_unavailable',
            error_description: 'Unable to validate user credentials. Please try again later.'
          });
        }
      } else {
        logger.warn('OAuth auth code token rejected: OAuth not enabled', { component: 'JwtAuth' });
        res.clearCookie('authToken', {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax'
        });
        if (req.path === '/api/auth/status') {
          return next();
        }
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
            logger.warn('JWT Auth token rejected: user not found', {
              component: 'JwtAuth',
              userId
            });
            return res.status(401).json({
              error: 'invalid_token',
              error_description: 'User account no longer exists'
            });
          }

          if (!isUserActive(userRecord)) {
            logger.warn('JWT Auth token rejected: user account disabled', {
              component: 'JwtAuth',
              userId
            });
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
          logger.error('JWT Auth failed to validate user status', {
            component: 'JwtAuth',
            error: loadError
          });
          // Return 503 error to prevent authentication bypass
          // We cannot safely validate the user, so we must reject the request
          return res.status(503).json({
            error: 'service_unavailable',
            error_description: 'Unable to validate user credentials. Please try again later.'
          });
        }
      } else {
        // Local auth not enabled, but token is local type - reject
        logger.warn('JWT Auth token rejected: local authentication is not enabled', {
          component: 'JwtAuth'
        });
        res.clearCookie('authToken', {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax'
        });
        if (req.path === '/api/auth/status') {
          return next(); // Continue as anonymous — let status endpoint return available auth methods
        }
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
          logger.warn('JWT Auth token rejected: OIDC user account disabled', {
            component: 'JwtAuth',
            userId: userRecord.id
          });
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
        logger.error('JWT Auth failed to validate OIDC user status', {
          component: 'JwtAuth',
          error: loadError
        });
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
          logger.warn('JWT Auth token rejected: LDAP user account disabled', {
            component: 'JwtAuth',
            userId: userRecord.id
          });
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
        logger.error('JWT Auth failed to validate LDAP user status', {
          component: 'JwtAuth',
          error: loadError
        });
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
          logger.warn('JWT Auth token rejected: Teams user account disabled', {
            component: 'JwtAuth',
            userId: userRecord.id
          });
          return res.status(403).json({
            error: 'access_denied',
            error_description: 'User account has been disabled'
          });
        }

        user = {
          id: decoded.id || decoded.sub,
          username: decoded.username || decoded.userPrincipalName,
          name: decoded.name || decoded.displayName || decoded.username,
          email: decoded.email || decoded.userPrincipalName,
          groups: decoded.groups || [],
          authMode: 'teams',
          timestamp: Date.now()
        };
      } catch (loadError) {
        logger.error('JWT Auth failed to validate Teams user status', {
          component: 'JwtAuth',
          error: loadError
        });
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
          logger.warn('JWT Auth token rejected: NTLM user account disabled', {
            component: 'JwtAuth',
            userId: userRecord.id
          });
          return res.status(403).json({
            error: 'access_denied',
            error_description: 'User account has been disabled'
          });
        }

        user = {
          id: decoded.id || decoded.sub,
          username: decoded.username || decoded.id,
          name: decoded.name || decoded.username || decoded.id,
          email: decoded.email || '',
          groups: decoded.groups || [],
          authMode: 'ntlm',
          domain: decoded.domain,
          timestamp: Date.now()
        };
      } catch (loadError) {
        logger.error('JWT Auth failed to validate NTLM user status', {
          component: 'JwtAuth',
          error: loadError
        });
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
  } catch (error) {
    // For /api/auth/status endpoint, allow expired/invalid tokens to pass through
    // so the endpoint can respond with proper auth status and auto-redirect info
    if (req.path === '/api/auth/status' && error.name === 'TokenExpiredError') {
      logger.info('JWT Auth: expired token on status endpoint, continuing', {
        component: 'JwtAuth'
      });
      return next();
    }

    logger.warn('JWT Auth token validation failed', { component: 'JwtAuth', error });
    return next();
  }
}
