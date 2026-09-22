import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import config from '../config.js';
import configCache from '../configCache.js';
import tokenStorageService from '../services/TokenStorageService.js';
import credentialService from '../services/CredentialService.js';
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
  } else if (iFinderConfig.privateKeyRef) {
    // Resolve the private key from the central credential store
    privateKey = credentialService.tryResolveSecret(iFinderConfig.privateKeyRef);
  }

  if (!privateKey) {
    throw new Error(
      'iFinder private key not configured. Select or create a credential under Admin > Integrations > iFinder, or set the IFINDER_PRIVATE_KEY environment variable in PEM format.'
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
 * Is this user field usable as (part of) a JWT subject?
 * @param {*} value - Field value from the authenticated user
 * @returns {boolean} True when it is a non-blank string
 */
function hasSubjectValue(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Build the error thrown when the configured subject field has no value.
 * @param {string} field - Configured `jwtSubjectField`
 * @param {string[]} missing - User fields that are missing or blank
 * @param {Object} user - Authenticated user object
 * @returns {Error} Error naming the setting, the gap and the user
 */
function subjectFieldMissingError(field, missing, user) {
  const who = user.id || user.username || user.email || '<unknown>';
  return new Error(
    `iFinder JWT subject could not be resolved: "JWT Subject Field" is set to ` +
      `"${field}" but the authenticated user (${who}) has no ${missing.join(' and ')}. ` +
      `Set a subject field the user actually carries in Admin > Integrations > iFinder, ` +
      `or supply the missing value${missing.length > 1 ? 's' : ''} from the auth provider ` +
      `(for LDAP, the NetBIOS domain is the "Domain" field on the provider).`
  );
}

/**
 * Resolve the JWT subject claim based on the configured jwtSubjectField.
 *
 * Resolution is strict: the configured field is the only one consulted. It used
 * to fall through to whatever else the user had — `email` to username to id,
 * and `domain\\username` all the way down to a bare account name when no domain
 * was set. That never failed, it just signed a token identifying a *different*
 * principal than the setting named, and iFinder built its user mapping against
 * that. A refused token an admin can read is worth far more than a valid token
 * for the wrong subject, so a gap now raises instead.
 *
 * @param {Object} user - Authenticated user object
 * @param {Object} config - iFinder configuration
 * @returns {string} Resolved subject value
 * @throws {Error} When the configured field has no value on this user
 */
export function resolveJwtSubject(user, config) {
  const field = config.jwtSubjectField || 'email';

  let resolved;
  switch (field) {
    case 'email':
      if (!hasSubjectValue(user.email)) {
        throw subjectFieldMissingError(field, ['email address'], user);
      }
      resolved = user.email;
      break;
    case 'username':
      if (!hasSubjectValue(user.username)) {
        throw subjectFieldMissingError(field, ['username'], user);
      }
      resolved = user.username;
      break;
    case 'domain\\username': {
      const missing = [];
      if (!hasSubjectValue(user.domain)) missing.push('NetBIOS domain');
      if (!hasSubjectValue(user.username)) missing.push('username');
      if (missing.length > 0) {
        throw subjectFieldMissingError(field, missing, user);
      }
      resolved = `${user.domain}\\${user.username}`;
      break;
    }
    default: {
      // Custom template. Placeholders ALWAYS resolve from the authenticated
      // user object (`user[field]`), never from environment variables.
      //
      // Two accepted forms:
      //   ${user.field}  — preferred, self-documenting.
      //   ${field}       — legacy. configCache opts this path out of env var
      //                    resolution via the `ENV_VAR_SKIP_PATHS_BY_KEY`
      //                    entry for `config/platform.json`, so this form
      //                    is now safe; before that skip was added it could
      //                    collide with `process.env.field` (notably
      //                    `process.env.username` on Windows = the OS
      //                    service account running the server), leaking
      //                    that account into every JWT subject. We still
      //                    warn so admins migrate to the explicit
      //                    `${user.field}` form.
      if (/\$\{(?!user\.)\w+\}/.test(field)) {
        logger.warn(
          'iFinder jwtSubjectField uses legacy ${field} placeholder syntax. ' +
            'Use ${user.field} instead (e.g. "BMG\\\\${user.username}") to ' +
            'avoid collision with environment variable names.',
          { component: 'iFinderJwt', jwtSubjectField: field }
        );
      }
      // A placeholder with no value leaves a hole in the subject (`ROCHUS\\`),
      // which is just as wrong as the fallbacks above and equally invisible.
      const unresolved = [];
      resolved = field.replace(/\$\{(?:user\.)?(\w+)\}/g, (_, key) => {
        const value = user[key];
        if (!hasSubjectValue(value)) {
          unresolved.push(`user.${key}`);
          return '';
        }
        return value;
      });
      if (unresolved.length > 0) {
        throw subjectFieldMissingError(field, unresolved, user);
      }
      break;
    }
  }

  if (typeof resolved !== 'string' || resolved.trim() === '') {
    throw new Error(
      `iFinder JWT subject could not be resolved (jwtSubjectField="${field}"). ` +
        `User is missing the required field(s). ` +
        `Check the "JWT Subject Field" setting in Admin > iFinder Integration and ensure ` +
        `the authenticated user has a non-empty value for it.`
    );
  }

  return resolved;
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

  logger.debug('iFinder JWT payload and sign options', {
    component: 'iFinderJwt',
    payload,
    signOptions: {
      algorithm: signOptions.algorithm,
      expiresIn: signOptions.expiresIn,
      issuer: signOptions.issuer,
      audience: signOptions.audience,
      keyid: signOptions.keyid
    },
    jwtSubjectField: iFinderConfig.jwtSubjectField
  });

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
