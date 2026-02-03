/**
 * Authentication Debug Utility
 * Provides centralized debug logging for authentication flows
 */
import configCache from '../configCache.js';
import logger from './logger.js';

/**
 * Check if authentication debug logging is enabled
 * @returns {boolean} True if debug logging is enabled
 */
function isAuthDebugEnabled() {
  const platform = configCache.getPlatform() || {};
  const enabled = platform.auth?.debug === true;
  // Temporary debug log to verify this function is being called
  if (enabled) {
    logger.info('🔍 AUTH DEBUG CHECK: Debug is enabled');
  }
  return enabled;
}

/**
 * Log authentication debug information
 * @param {string} context - The context/location of the debug log
 * @param {string} message - The debug message
 * @param {Object} data - Additional data to include in the log
 * @param {Object} req - Express request object (optional)
 */
function authDebugLog(context, message, data = {}, req = null) {
  if (!isAuthDebugEnabled()) {
    return;
  }

  const timestamp = new Date().toISOString();
  const requestInfo = req
    ? {
        url: req.url,
        method: req.method,
        userAgent: req.headers['user-agent'],
        ip: req.ip || req.connection.remoteAddress
      }
    : {};

  const logEntry = {
    timestamp,
    context,
    message,
    ...requestInfo,
    ...data
  };

  logger.debug(`🔐 AUTH DEBUG [${context}]:`, message);
  if (Object.keys(data).length > 0 || Object.keys(requestInfo).length > 0) {
    logger.debug(`🔐 AUTH DEBUG [${context}] Data:`, JSON.stringify(logEntry, null, 2));
  }
}

/**
 * Log authentication success with user information
 * @param {string} context - The authentication context
 * @param {Object} user - The authenticated user object
 * @param {Object} req - Express request object
 */
function authDebugSuccess(context, user, req) {
  if (!isAuthDebugEnabled()) {
    return;
  }

  const userData = {
    id: user.id,
    name: user.name,
    email: user.email,
    groups: user.groups,
    authMethod: user.authMethod,
    provider: user.provider || user.authProvider,
    authenticated: user.authenticated
  };

  authDebugLog(
    context,
    `Authentication successful for user: ${user.id}`,
    {
      user: userData,
      hasPermissions: !!user.permissions
    },
    req
  );
}

/**
 * Log authentication failure
 * @param {string} context - The authentication context
 * @param {string} reason - The failure reason
 * @param {Object} details - Additional failure details
 * @param {Object} req - Express request object
 */
function authDebugFailure(context, reason, details = {}, req) {
  if (!isAuthDebugEnabled()) {
    return;
  }

  authDebugLog(
    context,
    `Authentication failed: ${reason}`,
    {
      reason,
      ...details
    },
    req
  );
}

/**
 * Log OIDC specific debug information
 * @param {string} context - The OIDC context
 * @param {string} message - The debug message
 * @param {Object} data - OIDC specific data (tokens, userinfo, etc.)
 * @param {Object} req - Express request object
 */
function authDebugOIDC(context, message, data = {}, req = null) {
  if (!isAuthDebugEnabled()) {
    return;
  }

  // Sanitize sensitive data for logging
  const sanitizedData = { ...data };

  // Log token presence but not full content for security
  if (sanitizedData.tokens) {
    sanitizedData.tokens = {
      hasAccessToken: !!sanitizedData.tokens.access_token,
      hasIdToken: !!sanitizedData.tokens.id_token,
      hasRefreshToken: !!sanitizedData.tokens.refresh_token,
      tokenType: sanitizedData.tokens.token_type,
      expiresIn: sanitizedData.tokens.expires_in
    };
  }

  // Log partial token content for debugging (first/last 10 chars)
  if (data.accessToken) {
    const token = data.accessToken;
    sanitizedData.accessTokenInfo = {
      length: token.length,
      preview:
        token.length > 20
          ? `${token.substring(0, 10)}...${token.substring(token.length - 10)}`
          : '[short token]'
    };
    delete sanitizedData.accessToken;
  }

  authDebugLog(`OIDC-${context}`, message, sanitizedData, req);
}

/**
 * Log JWT token validation debug information
 * @param {string} message - The debug message
 * @param {Object} data - JWT validation data
 * @param {Object} req - Express request object
 */
function authDebugJWT(message, data = {}, req = null) {
  if (!isAuthDebugEnabled()) {
    return;
  }

  // Sanitize JWT data
  const sanitizedData = { ...data };

  if (sanitizedData.token) {
    const token = sanitizedData.token;
    sanitizedData.tokenInfo = {
      length: token.length,
      preview:
        token.length > 20
          ? `${token.substring(0, 10)}...${token.substring(token.length - 10)}`
          : '[short token]'
    };
    delete sanitizedData.token;
  }

  if (sanitizedData.decoded) {
    sanitizedData.decodedInfo = {
      sub: sanitizedData.decoded.sub,
      iss: sanitizedData.decoded.iss,
      aud: sanitizedData.decoded.aud,
      exp: sanitizedData.decoded.exp,
      authMode: sanitizedData.decoded.authMode,
      groups: sanitizedData.decoded.groups
    };
    delete sanitizedData.decoded;
  }

  authDebugLog('JWT', message, sanitizedData, req);
}

/**
 * Log permission resolution debug information
 * @param {string} message - The debug message
 * @param {Object} user - The user object
 * @param {Object} permissions - The resolved permissions
 * @param {Object} req - Express request object
 */
function authDebugPermissions(message, user, permissions = {}, req = null) {
  if (!isAuthDebugEnabled()) {
    return;
  }

  const permissionData = {
    userId: user.id,
    userGroups: user.groups,
    resolvedPermissions: {
      apps: permissions.apps ? Array.from(permissions.apps) : [],
      models: permissions.models ? Array.from(permissions.models) : [],
      prompts: permissions.prompts ? Array.from(permissions.prompts) : [],
      adminAccess: permissions.adminAccess
    }
  };

  authDebugLog('PERMISSIONS', message, permissionData, req);
}

export {
  isAuthDebugEnabled,
  authDebugLog,
  authDebugSuccess,
  authDebugFailure,
  authDebugOIDC,
  authDebugJWT,
  authDebugPermissions
};
