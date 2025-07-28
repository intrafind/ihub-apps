import jwt from 'jsonwebtoken';
import config from '../config.js';
import configCache from '../configCache.js';

/**
 * Central JWT token service for all authentication methods
 * Consolidates token generation logic from all auth middleware
 */

/**
 * Generate JWT token for authenticated user
 * @param {Object} user - User object with id, name, email, groups, provider, authMethod
 * @param {Object} options - Token generation options
 * @param {number} options.expiresInMinutes - Token expiration in minutes (default: 480 = 8 hours)
 * @param {string} options.authMode - Authentication mode (local, oidc, ldap, ntlm, teams, proxy)
 * @param {string} options.authProvider - Specific auth provider name
 * @param {Object} options.additionalClaims - Additional claims to include in token
 * @returns {Object} Object containing token and expiresIn seconds
 */
export function generateJwt(user, options = {}) {
  if (!user || !user.id) {
    throw new Error('User object with id is required for token generation');
  }

  const platform = configCache.getPlatform() || {};
  const jwtSecret = config.JWT_SECRET || platform.auth?.jwtSecret;

  if (!jwtSecret || jwtSecret === '${JWT_SECRET}') {
    throw new Error(
      `JWT secret not configured for ${options.authMode || 'unknown'} authentication`
    );
  }

  // Default expiration: 8 hours
  const expiresInMinutes = options.expiresInMinutes || platform.auth?.sessionTimeoutMinutes || 480;
  const expiresIn = expiresInMinutes * 60; // Convert to seconds

  // Base token payload
  const tokenPayload = {
    sub: user.id,
    name: user.name,
    email: user.email,
    groups: user.groups || [],
    provider: user.provider,
    authMode: options.authMode || user.authMethod,
    authProvider: options.authProvider || user.provider,
    iat: Math.floor(Date.now() / 1000),
    // Include additional authentication-specific data
    ...options.additionalClaims
  };

  // Add auth method specific claims
  if (user.authMethods) {
    tokenPayload.authMethods = user.authMethods;
  }

  if (user.active !== undefined) {
    tokenPayload.active = user.active;
  }

  if (user.persistedUser !== undefined) {
    tokenPayload.persistedUser = user.persistedUser;
  }

  // Add provider-specific data
  if (user.teamsData && options.authMode === 'teams') {
    tokenPayload.teamsData = user.teamsData;
  }

  if (user.domain && (options.authMode === 'ntlm' || options.authMode === 'ldap')) {
    tokenPayload.domain = user.domain;
  }

  const token = jwt.sign(tokenPayload, jwtSecret, {
    expiresIn: `${expiresIn}s`,
    issuer: 'ai-hub-apps',
    audience: 'ai-hub-apps',
    algorithm: 'HS256'
  });

  return { token, expiresIn };
}

/**
 * Verify JWT token
 * @param {string} token - JWT token to verify
 * @returns {Object|null} Decoded token payload or null if invalid
 */
export function verifyJwt(token) {
  try {
    const platform = configCache.getPlatform() || {};
    const jwtSecret = config.JWT_SECRET || platform.localAuth?.jwtSecret;

    if (!jwtSecret || jwtSecret === '${JWT_SECRET}') {
      console.warn('JWT secret not configured for token verification');
      return null;
    }

    return jwt.verify(token, jwtSecret, {
      issuer: 'ai-hub-apps',
      audience: 'ai-hub-apps'
    });
  } catch (error) {
    console.warn('JWT verification failed:', error.message);
    return null;
  }
}

/**
 * Decode JWT token without verification (for inspection)
 * @param {string} token - JWT token to decode
 * @returns {Object|null} Decoded token or null if invalid format
 */
export function decodeJwt(token) {
  try {
    return jwt.decode(token, { complete: true });
  } catch (error) {
    console.warn('JWT decode failed:', error.message);
    return null;
  }
}
