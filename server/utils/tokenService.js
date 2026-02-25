import jwt from 'jsonwebtoken';
import config from '../config.js';
import configCache from '../configCache.js';
import tokenStorageService from '../services/TokenStorageService.js';
import logger from './logger.js';

/**
 * Central JWT token service for all authentication methods
 * Consolidates token generation logic from all auth middleware
 */

/**
 * Get JWT signing algorithm from configuration
 * @returns {string} Algorithm (HS256 or RS256)
 */
export function getJwtAlgorithm() {
  const platform = configCache.getPlatform() || {};
  return platform.jwt?.algorithm || 'RS256';
}

/**
 * Get JWT signing key based on algorithm
 * For HS256: Returns secret key
 * For RS256: Returns private key
 * @returns {string|null} Signing key or null if not available
 */
export function getJwtSigningKey() {
  const algorithm = getJwtAlgorithm();

  if (algorithm === 'RS256') {
    return tokenStorageService.getRSAPrivateKey();
  }

  // Default to HS256
  return resolveJwtSecret();
}

/**
 * Get JWT verification key based on algorithm
 * For HS256: Returns secret key
 * For RS256: Returns public key
 * @returns {string|null} Verification key or null if not available
 */
export function getJwtVerificationKey() {
  const algorithm = getJwtAlgorithm();

  if (algorithm === 'RS256') {
    return tokenStorageService.getRSAPublicKey();
  }

  // Default to HS256
  return resolveJwtSecret();
}

/**
 * Resolve the JWT secret from available sources
 * Resolution chain: env var > platform config (non-placeholder) > TokenStorageService
 * @returns {string|null} The JWT secret or null if not available
 */
export function resolveJwtSecret() {
  // Priority 1: Environment variable
  if (config.JWT_SECRET && config.JWT_SECRET !== '${JWT_SECRET}') {
    return config.JWT_SECRET;
  }

  // Priority 2: Platform config (non-placeholder)
  const platform = configCache.getPlatform() || {};
  const configSecret = platform.auth?.jwtSecret;
  if (configSecret && configSecret !== '${JWT_SECRET}') {
    return configSecret;
  }

  // Priority 3: Auto-generated secret from TokenStorageService
  return tokenStorageService.getJwtSecret();
}

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
  const algorithm = getJwtAlgorithm();
  const signingKey = getJwtSigningKey();

  if (!signingKey) {
    throw new Error(
      `JWT signing key not configured for ${options.authMode || 'unknown'} authentication with ${algorithm}`
    );
  }

  // Default expiration: 8 hours
  const expiresInMinutes = options.expiresInMinutes || platform.auth?.sessionTimeoutMinutes || 480;
  const expiresIn = expiresInMinutes * 60; // Convert to seconds

  // Extract aud from additionalClaims if present — jsonwebtoken forbids setting both
  // the payload `aud` property and the `audience` option simultaneously.
  const { aud: audienceClaim, ...remainingClaims } = options.additionalClaims || {};

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
    // Include additional authentication-specific data (aud excluded, handled via jwt options)
    ...remainingClaims
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

  const token = jwt.sign(tokenPayload, signingKey, {
    expiresIn: `${expiresIn}s`,
    issuer: 'ihub-apps',
    audience: audienceClaim || 'ihub-apps',
    algorithm: algorithm
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
    const algorithm = getJwtAlgorithm();
    const verificationKey = getJwtVerificationKey();

    if (!verificationKey) {
      logger.warn(`JWT verification key not configured for ${algorithm}`);
      return null;
    }

    return jwt.verify(token, verificationKey, {
      issuer: 'ihub-apps',
      audience: 'ihub-apps',
      algorithms: [algorithm]
    });
  } catch (error) {
    logger.warn('JWT verification failed:', error.message);
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
    logger.warn('JWT decode failed:', error.message);
    return null;
  }
}
