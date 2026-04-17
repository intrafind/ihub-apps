import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import config from '../config.js';
import configCache from '../configCache.js';
import tokenStorageService from '../services/TokenStorageService.js';
import logger from './logger.js';

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
 * Get iFinder configuration from platform config
 * @returns {Object} iFinder configuration
 */
function getIFinderConfig() {
  const platform = configCache.getPlatform() || {};
  return platform.iFinder || {};
}

/**
 * Compute the kid (Key ID) matching /.well-known/jwks.json
 * @returns {string|undefined} Key ID or undefined if OIDC key pair not available
 */
function computeOidcKid() {
  const publicKey = tokenStorageService.getRSAPublicKey();
  if (!publicKey) return undefined;
  return crypto.createHash('sha256').update(publicKey).digest('hex').substring(0, 16);
}

/**
 * Get the effective issuer for iFinder JWTs.
 * When useOidcKeyPair is true, uses the OIDC server issuer (platform.oauth.issuer)
 * so that iFinder can validate via JWKS Discovery.
 * @param {Object} iFinderConfig - iFinder configuration
 * @returns {string} Issuer string
 */
function getEffectiveIssuer(iFinderConfig) {
  if (iFinderConfig.useOidcKeyPair) {
    const platform = configCache.getPlatform() || {};
    const oauthIssuer = platform.oauth?.issuer;
    if (oauthIssuer && oauthIssuer.startsWith('http')) {
      return oauthIssuer;
    }
    logger.warn(
      'iFinder useOidcKeyPair is enabled but platform.oauth.issuer is not a URL. ' +
        'iFinder JWT issuer will not match OIDC Discovery. ' +
        'Configure the OAuth Issuer URL in Admin > Authentication > OAuth Server.',
      { component: 'iFinderJwt' }
    );
    return iFinderConfig.issuer || 'ihub-apps';
  }
  return iFinderConfig.issuer || 'ihub-apps';
}

/**
 * Get iFinder private key from configuration or environment.
 * When useOidcKeyPair is true, uses the iHub OIDC RSA key pair directly.
 * @param {Object} iFinderConfig - iFinder configuration
 * @returns {string} Private key for JWT signing
 */
function getIFinderPrivateKey(iFinderConfig) {
  if (iFinderConfig.useOidcKeyPair) {
    const keyPair = tokenStorageService.getRSAKeyPair();
    if (!keyPair?.privateKey) {
      throw new Error(
        'iHub OIDC RSA key pair not initialized. Cannot sign iFinder JWT with OIDC key pair.'
      );
    }
    return keyPair.privateKey;
  }

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
 * Resolve the JWT subject claim based on the configured jwtSubjectField
 * @param {Object} user - Authenticated user object
 * @param {Object} config - iFinder configuration
 * @returns {string} Resolved subject value
 */
function resolveJwtSubject(user, config) {
  const field = config.jwtSubjectField || 'email';

  switch (field) {
    case 'email':
      return user.email || user.username || user.id;
    case 'username':
      return user.username || user.email || user.id;
    case 'domain\\username':
      return user.domain ? `${user.domain}\\${user.username || user.id}` : user.username || user.id;
    default:
      // Custom template: replace ${field} placeholders
      return field.replace(/\$\{(\w+)\}/g, (_, key) => user[key] || '');
  }
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

  const iFinderConfig = getIFinderConfig();
  const privateKey = getIFinderPrivateKey(iFinderConfig);

  const {
    scope = iFinderConfig.defaultScope,
    expiresIn = iFinderConfig.tokenExpirationSeconds || 3600
  } = options;

  // Create JWT payload matching iFinder expected format
  const payload = {
    sub: resolveJwtSubject(user, iFinderConfig),
    name: user.name || user.displayName || user.username || user.id,
    iat: Math.floor(Date.now() / 1000),
    scope: scope
  };

  const algorithm = iFinderConfig.useOidcKeyPair ? 'RS256' : iFinderConfig.algorithm || 'RS256';
  const issuer = getEffectiveIssuer(iFinderConfig);

  logger.info(
    `Generating iFinder JWT for user ${payload.sub} with scope '${scope}', issuer '${issuer}', expiresIn ${expiresIn}s`,
    { component: 'iFinderJwt', useOidcKeyPair: iFinderConfig.useOidcKeyPair }
  );

  const signOptions = {
    algorithm,
    expiresIn: expiresIn,
    issuer,
    audience: iFinderConfig.audience || 'ifinder-api'
  };

  // When using the OIDC key pair, include the kid so iFinder can match against JWKS
  if (iFinderConfig.useOidcKeyPair) {
    const kid = computeOidcKid();
    if (kid) signOptions.keyid = kid;
  }

  return jwt.sign(payload, privateKey, signOptions);
}

/**
 * Validate iFinder JWT token (for testing purposes)
 * @param {string} token - JWT token to validate
 * @returns {Object} Decoded token payload
 */
export function validateIFinderJWT(token) {
  const iFinderConfig = getIFinderConfig();

  let verificationKey;
  if (iFinderConfig.useOidcKeyPair) {
    verificationKey = tokenStorageService.getRSAPublicKey();
    if (!verificationKey) {
      throw new Error('iHub OIDC RSA public key not available for iFinder JWT validation');
    }
  } else {
    verificationKey = getIFinderPrivateKey(iFinderConfig);
  }

  try {
    const decoded = jwt.verify(token, verificationKey, {
      algorithms: [iFinderConfig.useOidcKeyPair ? 'RS256' : iFinderConfig.algorithm || 'RS256'],
      issuer: getEffectiveIssuer(iFinderConfig),
      audience: iFinderConfig.audience || 'ifinder-api'
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
  if (!options.scope) {
    const config = getIFinderConfig();
    options.scope = config.defaultScope || 'fi_index_read';
  }
  const token = generateIFinderJWT(user, options);
  return `Bearer ${token}`;
}

export default {
  generateIFinderJWT,
  validateIFinderJWT,
  getIFinderAuthorizationHeader
};
