import jwt from 'jsonwebtoken';
import config from '../config.js';
import configCache from '../configCache.js';

/**
 * iFinder JWT utility for generating tokens based on authenticated users
 *
 * Expected JWT format for iFinder API:
 * {
 *   "sub": "user.email@example.com",
 *   "name": "User Name",
 *   "admin": true/false,
 *   "iat": 1516239022,
 *   "scope": "fa_index_read"
 * }
 */

/**
 * Get iFinder private key from configuration or environment
 * @returns {string} Private key for JWT signing
 */
function getIFinderPrivateKey() {
  let privateKey;

  // Try environment variable first
  if (config.IFINDER_PRIVATE_KEY) {
    privateKey = config.IFINDER_PRIVATE_KEY;
  } else {
    // Try platform configuration
    const platform = configCache.getPlatform() || {};
    if (platform.iFinder?.privateKey) {
      privateKey = platform.iFinder.privateKey;
    }
  }

  if (!privateKey) {
    throw new Error(
      'iFinder private key not configured. Set IFINDER_PRIVATE_KEY environment variable or configure in platform.json'
    );
  }

  // Format the private key properly - replace escaped newlines with actual newlines
  if (typeof privateKey === 'string') {
    privateKey = privateKey.replace(/\\n/g, '\n');

    // Ensure proper PEM format
    if (!privateKey.startsWith('-----BEGIN')) {
      throw new Error(
        'iFinder private key must be in PEM format (starting with -----BEGIN PRIVATE KEY-----)'
      );
    }
  }

  return privateKey;
}

/**
 * Get iFinder configuration from platform config
 * @returns {Object} iFinder configuration
 */
function getIFinderConfig() {
  const platform = configCache.getPlatform() || {};
  return platform.iFinder || {};
}

/**
 * Generate JWT token for iFinder API based on authenticated user
 * @param {Object} user - Authenticated user object
 * @param {Object} options - Additional options for token generation
 * @param {string} options.scope - JWT scope (default: '')
 * @param {number} options.expiresIn - Token expiration in seconds (default: 3600)
 * @returns {string} Generated JWT token
 */
export function generateIFinderJWT(user, options = {}) {
  if (!user || user.id === 'anonymous') {
    throw new Error('iFinder JWT requires authenticated user');
  }

  const privateKey = getIFinderPrivateKey();
  const config = getIFinderConfig();

  const { scope = config.defaultScope, expiresIn = config.tokenExpirationSeconds || 3600 } =
    options;

  // Create JWT payload matching iFinder expected format
  const payload = {
    sub: user.email || user.id,
    name: user.name || user.displayName || user.id,
    iat: Math.floor(Date.now() / 1000),
    scope: scope
  };

  console.log(
    `Generating iFinder JWT for user ${payload.sub} with scope '${scope}' and expiresIn ${expiresIn} seconds`
  );

  // Sign the JWT token with the private key
  const token = jwt.sign(payload, privateKey, {
    algorithm: config.algorithm || 'RS256', // Default to RS256 for private key signing
    expiresIn: expiresIn,
    issuer: config.issuer || 'ihub-apps',
    audience: config.audience || 'ifinder-api'
  });

  return token;
}

/**
 * Validate iFinder JWT token (for testing purposes)
 * @param {string} token - JWT token to validate
 * @returns {Object} Decoded token payload
 */
export function validateIFinderJWT(token) {
  const privateKey = getIFinderPrivateKey();
  const config = getIFinderConfig();

  try {
    const decoded = jwt.verify(token, privateKey, {
      algorithms: [config.algorithm || 'RS256'],
      issuer: config.issuer || 'ihub-apps',
      audience: config.audience || 'ifinder-api'
    });

    return decoded;
  } catch (error) {
    throw new Error(`iFinder JWT validation failed: ${error.message}`);
  }
}

/**
 * Generate Authorization header for iFinder API requests
 * @param {Object} user - Authenticated user object
 * @param {Object} options - Token generation options
 * @returns {string} Authorization header value
 */
export function getIFinderAuthorizationHeader(user, options = {}) {
  const token = generateIFinderJWT(user, options);
  return `Bearer ${token}`;
}

export default {
  generateIFinderJWT,
  validateIFinderJWT,
  getIFinderAuthorizationHeader
};
