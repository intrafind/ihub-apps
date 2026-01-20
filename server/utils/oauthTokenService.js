import jwt from 'jsonwebtoken';
import config from '../config.js';
import configCache from '../configCache.js';

/**
 * OAuth-specific token service for Client Credentials flow
 * Extends the existing tokenService.js with OAuth-specific functionality
 */

/**
 * Generate JWT token for OAuth client credentials
 * @param {Object} client - OAuth client object
 * @param {string} client.clientId - Client ID
 * @param {string} client.name - Client name
 * @param {Array<string>} client.scopes - Allowed scopes
 * @param {Array<string>} client.allowedApps - Allowed app IDs
 * @param {Array<string>} client.allowedModels - Allowed model IDs
 * @param {number} client.tokenExpirationMinutes - Token expiration in minutes
 * @param {Object} options - Token generation options
 * @param {string} options.requestedScope - Specific scopes requested (space-separated)
 * @returns {Object} Object containing token, expiresIn, and scope
 */
export function generateOAuthToken(client, options = {}) {
  if (!client || !client.clientId) {
    throw new Error('Client object with clientId is required for OAuth token generation');
  }

  const platform = configCache.getPlatform() || {};
  const jwtSecret = config.JWT_SECRET || platform.auth?.jwtSecret;

  if (!jwtSecret || jwtSecret === '${JWT_SECRET}') {
    throw new Error('JWT secret not configured for OAuth authentication');
  }

  // Determine scopes for this token
  let tokenScopes = client.scopes || [];

  // If specific scopes requested, validate and use them
  if (options.requestedScope) {
    const requestedScopes = options.requestedScope.split(' ').filter(s => s.trim());

    // Validate requested scopes against client's allowed scopes
    const invalidScopes = requestedScopes.filter(s => !tokenScopes.includes(s));
    if (invalidScopes.length > 0) {
      throw new Error(`Invalid scopes requested: ${invalidScopes.join(', ')}`);
    }

    tokenScopes = requestedScopes;
  }

  // Token expiration
  const expiresInMinutes = client.tokenExpirationMinutes || 60;
  const expiresIn = expiresInMinutes * 60; // Convert to seconds

  // OAuth token payload
  // NOTE: allowedApps and allowedModels are NOT stored in the token
  // They are retrieved from the client configuration at runtime
  // This allows revoking access without invalidating tokens
  const tokenPayload = {
    sub: client.clientId, // Subject is the client ID
    client_id: client.clientId,
    client_name: client.name,
    scopes: tokenScopes,
    authMode: 'oauth_client_credentials',
    iat: Math.floor(Date.now() / 1000),
    // OAuth tokens are machine-to-machine, no user context
    groups: ['oauth_clients'] // Special group for OAuth clients
  };

  const token = jwt.sign(tokenPayload, jwtSecret, {
    expiresIn: `${expiresIn}s`,
    issuer: 'ihub-apps',
    audience: 'ihub-apps',
    algorithm: 'HS256'
  });

  return {
    access_token: token,
    token_type: 'Bearer',
    expires_in: expiresIn,
    scope: tokenScopes.join(' ')
  };
}

/**
 * Verify and decode OAuth JWT token
 * @param {string} token - JWT token to verify
 * @returns {Object|null} Decoded token payload or null if invalid
 */
export function verifyOAuthToken(token) {
  try {
    const platform = configCache.getPlatform() || {};
    const jwtSecret = config.JWT_SECRET || platform.auth?.jwtSecret;

    if (!jwtSecret || jwtSecret === '${JWT_SECRET}') {
      console.warn('[OAuth] JWT secret not configured for token verification');
      return null;
    }

    const decoded = jwt.verify(token, jwtSecret, {
      issuer: 'ihub-apps',
      audience: 'ihub-apps'
    });

    // Verify it's an OAuth token
    if (decoded.authMode !== 'oauth_client_credentials') {
      console.warn('[OAuth] Token is not an OAuth client credentials token');
      return null;
    }

    return decoded;
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      console.warn('[OAuth] Token expired');
      return { error: 'token_expired', expired: true };
    }
    console.warn('[OAuth] Token verification failed:', error.message);
    return null;
  }
}

/**
 * Introspect an OAuth token
 * Returns detailed information about the token's validity and claims
 * @param {string} token - JWT token to introspect
 * @returns {Object} Introspection result
 */
export function introspectOAuthToken(token) {
  try {
    const decoded = verifyOAuthToken(token);

    if (!decoded) {
      return {
        active: false
      };
    }

    // Check if token is expired
    if (decoded.error === 'token_expired') {
      return {
        active: false,
        error: 'token_expired'
      };
    }

    // Check expiration manually as well
    const now = Math.floor(Date.now() / 1000);
    if (decoded.exp && decoded.exp < now) {
      return {
        active: false,
        error: 'token_expired'
      };
    }

    return {
      active: true,
      client_id: decoded.client_id,
      client_name: decoded.client_name,
      scopes: decoded.scopes,
      allowedApps: decoded.allowedApps,
      allowedModels: decoded.allowedModels,
      exp: decoded.exp,
      iat: decoded.iat,
      iss: decoded.iss,
      aud: decoded.aud
    };
  } catch (error) {
    console.error('[OAuth] Token introspection error:', error.message);
    return {
      active: false,
      error: 'invalid_token'
    };
  }
}

/**
 * Generate a static API key (long-lived token) for OAuth client
 * This is useful for clients that don't support OAuth flow
 * @param {Object} client - OAuth client object
 * @param {number} expirationDays - Expiration in days (default: 365)
 * @returns {Object} Object containing token and expiration
 */
export function generateStaticApiKey(client, expirationDays = 365) {
  if (!client || !client.clientId) {
    throw new Error('Client object with clientId is required for API key generation');
  }

  const platform = configCache.getPlatform() || {};
  const jwtSecret = config.JWT_SECRET || platform.auth?.jwtSecret;

  if (!jwtSecret || jwtSecret === '${JWT_SECRET}') {
    throw new Error('JWT secret not configured for API key generation');
  }

  // Static API key has longer expiration
  const expiresInSeconds = expirationDays * 24 * 60 * 60;

  // API key payload (similar to OAuth token but with longer expiration)
  // NOTE: allowedApps and allowedModels are NOT stored in the token
  // They are retrieved from the client configuration at runtime
  // This allows revoking access without invalidating tokens
  const tokenPayload = {
    sub: client.clientId,
    client_id: client.clientId,
    client_name: client.name,
    scopes: client.scopes || [],
    authMode: 'oauth_static_api_key',
    iat: Math.floor(Date.now() / 1000),
    groups: ['oauth_clients'],
    // Mark as static API key
    static_key: true
  };

  const token = jwt.sign(tokenPayload, jwtSecret, {
    expiresIn: `${expiresInSeconds}s`,
    issuer: 'ihub-apps',
    audience: 'ihub-apps',
    algorithm: 'HS256'
  });

  console.log(
    `[OAuth] Static API key generated | client_id=${client.clientId} | expires_in_days=${expirationDays}`
  );

  return {
    api_key: token,
    token_type: 'Bearer',
    expires_in: expiresInSeconds,
    expires_at: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    scope: (client.scopes || []).join(' ')
  };
}

/**
 * Validate OAuth token scopes against required scopes
 * @param {Array<string>} tokenScopes - Scopes from the token
 * @param {Array<string>} requiredScopes - Required scopes for the operation
 * @returns {boolean} True if token has all required scopes
 */
export function validateScopes(tokenScopes, requiredScopes) {
  if (!requiredScopes || requiredScopes.length === 0) {
    return true; // No specific scopes required
  }

  if (!tokenScopes || tokenScopes.length === 0) {
    return false; // Token has no scopes but scopes are required
  }

  // Check if token has all required scopes
  return requiredScopes.every(scope => tokenScopes.includes(scope));
}

/**
 * Validate OAuth token app access
 * @param {Array<string>} allowedApps - Apps the client can access
 * @param {string} appId - App ID to check
 * @returns {boolean} True if client can access the app
 */
export function validateAppAccess(allowedApps, appId) {
  if (!allowedApps || allowedApps.length === 0) {
    return true; // No app restrictions
  }

  return allowedApps.includes(appId);
}

/**
 * Validate OAuth token model access
 * @param {Array<string>} allowedModels - Models the client can access
 * @param {string} modelId - Model ID to check
 * @returns {boolean} True if client can access the model
 */
export function validateModelAccess(allowedModels, modelId) {
  if (!allowedModels || allowedModels.length === 0) {
    return true; // No model restrictions
  }

  return allowedModels.includes(modelId);
}
