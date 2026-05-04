import expressNtlm from 'express-ntlm';
import configCache from '../configCache.js';
import { enhanceUserGroups, mapExternalGroups } from '../utils/authorization.js';
import { generateJwt } from '../utils/tokenService.js';
import { validateAndPersistExternalUser } from '../utils/userManager.js';
import { getLdapProviderByName, lookupLdapGroupsForUser } from './ldapAuth.js';
import logger from '../utils/logger.js';
import { getAuthCookieOptions } from '../utils/cookieSettings.js';

/**
 * NTLM/Windows Authentication middleware and utilities
 */

// Cache for the express-ntlm middleware instance
let ntlmMiddlewareInstance = null;
let ntlmMiddlewareConfig = null;

/**
 * Create NTLM middleware with configuration
 * @param {Object} ntlmConfig - NTLM configuration
 * @returns {Function} Express middleware
 */
function createNtlmMiddleware(ntlmConfig = {}) {
  // Support environment variables for LDAP credentials (more secure)
  const ldapUser = ntlmConfig.domainControllerUser || process.env.NTLM_LDAP_USER;
  const ldapPassword = ntlmConfig.domainControllerPassword || process.env.NTLM_LDAP_PASSWORD;

  // express-ntlm calls this for every internal step (negotiate, bind, parse).
  // When ntlmConfig.debug is true, forward each line to our logger so admins can
  // see exactly where the handshake is failing — particularly important for
  // diagnosing 403 responses from the AD SASL bind step.
  const debugFn = ntlmConfig.debug
    ? (...args) => {
        // First arg is the prefix ("[express-ntlm]"); strip it so we don't double-tag.
        const [, ...rest] = args;
        const msg = rest
          .map(a => {
            if (a instanceof Error) return a.stack || a.message;
            if (typeof a === 'object') {
              try {
                return JSON.stringify(a);
              } catch {
                return String(a);
              }
            }
            return String(a);
          })
          .join(' ');
        logger.info('[express-ntlm] ' + msg, { component: 'NtlmAuth' });
      }
    : () => {};

  const options = {
    domain: ntlmConfig.domain,
    domaincontroller: ntlmConfig.domainController,
    // Optional: specify which fields to return
    getUserInfo: ntlmConfig.getUserInfo !== false, // Default true
    // Optional: specify authentication type
    type: ntlmConfig.type || 'ntlm', // 'ntlm' or 'negotiate'
    // Optional: specify if we should get user groups
    getGroups: ntlmConfig.getGroups !== false, // Default true
    // LDAP bind credentials (required for group queries)
    domaincontrolleruser: ldapUser,
    domaincontrollerpassword: ldapPassword,
    // TLS options for ldaps:// connections with self-signed/internal CA certs
    ...(ntlmConfig.tlsOptions && { tlsOptions: ntlmConfig.tlsOptions }),
    // Pipe express-ntlm's internal debug output through our logger
    debug: debugFn,
    // Wrap the default response handlers so we see exactly which path fired and
    // what the request looked like when express-ntlm gave up. The 403 path is
    // the most useful: it means the AD SASL bind with the user's NTLM Type 3
    // token returned a non-success LDAP result code (commonly: channel binding
    // enforced, NTLM restricted at the DC, or invalid credentials).
    forbidden: (request, response /* , next */) => {
      const auth = request.headers.authorization || '';
      logger.warn('NTLM Auth: 403 Forbidden from express-ntlm', {
        component: 'NtlmAuth',
        url: request.originalUrl,
        ntlm: request.ntlm || null,
        authHeaderType: auth.split(' ')[0] || 'none',
        authHeaderLength: auth.length,
        hint: 'AD rejected the SASL bind carrying the NTLM Type 3 token. Likely causes: channel binding enforced (LdapEnforceChannelBinding=2), NTLM restricted at DC, or the browser sent invalid/empty credentials.'
      });
      response.sendStatus(403);
    },
    internalservererror: (request, response /* , next */) => {
      logger.error('NTLM Auth: 500 from express-ntlm', {
        component: 'NtlmAuth',
        url: request.originalUrl,
        ntlm: request.ntlm || null,
        hint: 'Usually means the connection cache lost the proxy between Type 1 and Type 3 (HTTP keep-alive broken by an intermediary), or the AD socket errored.'
      });
      response.sendStatus(500);
    },
    badrequest: (request, response /* , next */) => {
      logger.warn('NTLM Auth: 400 Bad Request from express-ntlm', {
        component: 'NtlmAuth',
        url: request.originalUrl,
        authHeader: request.headers.authorization ? 'present' : 'missing'
      });
      response.sendStatus(400);
    },
    unauthorized: (request, response /* , next */) => {
      // Send the NTLM/Negotiate challenge. Header scheme follows the configured
      // `type` so Negotiate deployments advertise correctly to the browser
      // (express-ntlm 2.7 itself hardcodes NTLM, but matching the config is the
      // forward-compatible behaviour). Logged at debug to avoid noise — this
      // fires on every initial request before the handshake completes.
      const scheme = ntlmConfig.type === 'negotiate' ? 'Negotiate' : 'NTLM';
      logger.debug('NTLM Auth: sending 401 challenge', {
        component: 'NtlmAuth',
        scheme,
        url: request.originalUrl,
        hadAuthHeader: !!request.headers.authorization
      });
      response.statusCode = 401;
      response.setHeader('WWW-Authenticate', scheme);
      response.end();
    },
    ...ntlmConfig.options
  };

  // Summarise tlsOptions so the log makes the *effective* TLS behaviour
  // visible. Logging only the keys hides whether `rejectUnauthorized` is true
  // or false — exactly the diagnostic we need for self-signed AD certs.
  // Sensitive material (ca/cert/key/pfx) is reported as a presence flag only.
  let tlsOptionsSummary = 'none';
  if (ntlmConfig.tlsOptions) {
    const tls = ntlmConfig.tlsOptions;
    tlsOptionsSummary = {
      rejectUnauthorized:
        typeof tls.rejectUnauthorized === 'boolean'
          ? tls.rejectUnauthorized
          : 'default(true)',
      hasCa: !!tls.ca,
      hasCert: !!tls.cert,
      hasKey: !!tls.key,
      hasPfx: !!tls.pfx,
      ...(tls.servername && { servername: tls.servername }),
      ...(tls.minVersion && { minVersion: tls.minVersion }),
      ...(tls.maxVersion && { maxVersion: tls.maxVersion }),
      otherKeys: Object.keys(tls).filter(
        k =>
          ![
            'rejectUnauthorized',
            'ca',
            'cert',
            'key',
            'pfx',
            'servername',
            'minVersion',
            'maxVersion'
          ].includes(k)
      )
    };
  }

  logger.info('NTLM Auth: configuring NTLM middleware', {
    component: 'NtlmAuth',
    domain: options.domain || 'default',
    domainController: options.domaincontroller || 'NOT CONFIGURED',
    getGroups: options.getGroups,
    ldapBindUserConfigured: !!options.domaincontrolleruser,
    ldapBindPasswordConfigured: !!options.domaincontrollerpassword,
    debugMode: !!ntlmConfig.debug,
    challengeScheme: ntlmConfig.type === 'negotiate' ? 'Negotiate' : 'NTLM',
    tlsOptions: tlsOptionsSummary
  });

  // Warn if getGroups is enabled but no domain controller is configured
  if (options.getGroups && !options.domaincontroller) {
    logger.warn(
      'NTLM Auth: getGroups is enabled but no domain controller is configured, users will be assigned default groups only',
      { component: 'NtlmAuth' }
    );
  }

  // Warn if getGroups is enabled but LDAP credentials are missing
  if (
    options.getGroups &&
    options.domaincontroller &&
    (!options.domaincontrolleruser || !options.domaincontrollerpassword)
  ) {
    logger.warn(
      'NTLM Auth: getGroups is enabled with domain controller but LDAP credentials are missing',
      { component: 'NtlmAuth' }
    );
  }

  return expressNtlm(options);
}

/**
 * Get or create the NTLM middleware instance
 * @param {Object} ntlmConfig - NTLM configuration
 * @returns {Function} Express middleware instance
 */
function getNtlmMiddleware(ntlmConfig) {
  // Check if config changed, if so, recreate middleware
  const configHash = JSON.stringify(ntlmConfig);
  if (!ntlmMiddlewareInstance || ntlmMiddlewareConfig !== configHash) {
    ntlmMiddlewareInstance = createNtlmMiddleware(ntlmConfig);
    ntlmMiddlewareConfig = configHash;
  }
  return ntlmMiddlewareInstance;
}

/**
 * Process NTLM authentication result
 * @param {Object} req - Express request object
 * @param {Object} ntlmConfig - NTLM configuration
 * @returns {Object|null} Processed user object or null
 */
function processNtlmUser(req, ntlmConfig) {
  if (!req.ntlm) {
    logger.debug('NTLM Auth: no NTLM data in request', { component: 'NtlmAuth' });
    return null;
  }

  const ntlmUser = req.ntlm;

  logger.debug('NTLM Auth: raw NTLM data', {
    component: 'NtlmAuth',
    ntlmUser: JSON.stringify(ntlmUser, null, 2)
  });

  // Check if user is authenticated
  if (!ntlmUser.Authenticated) {
    logger.warn('NTLM Auth: user not authenticated', {
      component: 'NtlmAuth',
      username: ntlmUser.UserName || ntlmUser.username || 'unknown'
    });
    return null;
  }

  logger.info('NTLM Auth: processing authenticated user', {
    component: 'NtlmAuth',
    username: ntlmUser.UserName || ntlmUser.username
  });

  // Extract user information
  const userId = ntlmUser.username || ntlmUser.UserName;
  const domain = ntlmUser.domain || ntlmUser.Domain;
  const fullUsername = domain ? `${domain}\\${userId}` : userId;

  // Extract groups - check all possible field names
  let groups = [];
  if (ntlmUser.groups && Array.isArray(ntlmUser.groups)) {
    groups = ntlmUser.groups;
    logger.debug('NTLM Auth: found groups in ntlmUser.groups', { component: 'NtlmAuth', groups });
  } else if (ntlmUser.Groups && Array.isArray(ntlmUser.Groups)) {
    groups = ntlmUser.Groups;
    logger.debug('NTLM Auth: found groups in ntlmUser.Groups', { component: 'NtlmAuth', groups });
  } else {
    logger.debug('NTLM Auth: no groups found in NTLM data', {
      component: 'NtlmAuth',
      availableFields: Object.keys(ntlmUser),
      getGroups: ntlmConfig.getGroups,
      domainController: ntlmConfig.domainController || 'NOT CONFIGURED'
    });

    if (ntlmConfig.getGroups && !ntlmConfig.domainController) {
      logger.warn(
        'NTLM Auth: groups cannot be retrieved without a domain controller configuration',
        {
          component: 'NtlmAuth'
        }
      );
    }
  }

  logger.debug('NTLM Auth: extracted groups before mapping', { component: 'NtlmAuth', groups });

  // Apply group mapping using centralized function
  const mappedGroups = mapExternalGroups(groups);

  logger.debug('NTLM Auth: groups after mapping', { component: 'NtlmAuth', mappedGroups });

  // Add default groups if configured
  if (ntlmConfig.defaultGroups && Array.isArray(ntlmConfig.defaultGroups)) {
    logger.debug('NTLM Auth: adding default groups', {
      component: 'NtlmAuth',
      defaultGroups: ntlmConfig.defaultGroups
    });
    ntlmConfig.defaultGroups.forEach(g => {
      if (!mappedGroups.includes(g)) {
        mappedGroups.push(g);
      }
    });
  }

  logger.debug('NTLM Auth: final groups for user', { component: 'NtlmAuth', mappedGroups });

  // Create normalized user object
  const user = {
    id: fullUsername,
    username: userId,
    name: ntlmUser.DisplayName || ntlmUser.displayName || fullUsername,
    email: ntlmUser.email || ntlmUser.Email || null,
    groups: mappedGroups,
    externalGroups: groups, // Store original external groups for debugging
    authenticated: true,
    authMethod: 'ntlm',
    provider: ntlmConfig.name || 'ntlm',
    domain: domain,
    workstation: ntlmUser.workstation || ntlmUser.Workstation,
    raw: ntlmUser // Keep raw NTLM data for debugging
  };

  logger.debug('NTLM Auth: created user object', {
    component: 'NtlmAuth',
    id: user.id,
    name: user.name,
    groups: user.groups,
    externalGroups: user.externalGroups
  });

  return user;
}

/**
 * Perform LDAP group lookup for an NTLM-authenticated user and merge groups.
 * Only called during login/session start, not on every request.
 * @param {Object} user - Processed NTLM user object
 * @param {Object} ntlmConfig - NTLM configuration
 * @returns {Promise<Object>} User with merged LDAP groups
 */
async function enhanceUserWithLdapGroups(user, ntlmConfig) {
  if (!ntlmConfig.ldapGroupLookupProvider) {
    return user;
  }

  try {
    const ldapProvider = getLdapProviderByName(ntlmConfig.ldapGroupLookupProvider);

    if (!ldapProvider) {
      logger.error('NTLM Auth: ldapGroupLookupProvider references non-existent LDAP provider', {
        component: 'NtlmAuth',
        ldapGroupLookupProvider: ntlmConfig.ldapGroupLookupProvider
      });
      return user;
    }

    if (!ldapProvider.adminDn || !ldapProvider.adminPassword) {
      logger.error(
        'NTLM Auth: LDAP provider for group lookup is missing adminDn or adminPassword',
        {
          component: 'NtlmAuth',
          ldapProvider: ntlmConfig.ldapGroupLookupProvider
        }
      );
      return user;
    }

    logger.info('NTLM Auth: performing LDAP group lookup for user', {
      component: 'NtlmAuth',
      username: user.username,
      ldapProvider: ntlmConfig.ldapGroupLookupProvider
    });

    const ldapGroups = await lookupLdapGroupsForUser(user.username, ldapProvider);

    if (ldapGroups.length > 0) {
      // Merge LDAP groups with any existing external groups (deduplicate)
      const mergedExternalGroups = [...new Set([...user.externalGroups, ...ldapGroups])];
      user.externalGroups = mergedExternalGroups;

      // Re-map all external groups to internal groups
      const mappedGroups = mapExternalGroups(mergedExternalGroups);

      // Re-add default groups
      if (ntlmConfig.defaultGroups && Array.isArray(ntlmConfig.defaultGroups)) {
        ntlmConfig.defaultGroups.forEach(g => {
          if (!mappedGroups.includes(g)) {
            mappedGroups.push(g);
          }
        });
      }

      user.groups = mappedGroups;

      logger.info('NTLM Auth: merged LDAP groups into user', {
        component: 'NtlmAuth',
        username: user.username,
        ldapGroupCount: ldapGroups.length,
        totalExternalGroups: mergedExternalGroups.length,
        mappedGroups: mappedGroups.join(', ')
      });
    } else {
      logger.info('NTLM Auth: LDAP group lookup returned no groups', {
        component: 'NtlmAuth',
        username: user.username
      });
    }
  } catch (error) {
    logger.error('NTLM Auth: LDAP group lookup failed, continuing with NTLM groups only', {
      component: 'NtlmAuth',
      username: user.username,
      ldapGroupLookupProvider: ntlmConfig.ldapGroupLookupProvider,
      error
    });
  }

  return user;
}

/**
 * Check if multiple authentication providers are enabled
 * @param {Object} platform - Platform configuration
 * @returns {boolean} True if more than one auth provider is enabled
 */
function hasMultipleAuthProviders(platform) {
  const enabledProviders = [
    platform.localAuth?.enabled,
    platform.ldapAuth?.enabled,
    platform.oidcAuth?.enabled,
    platform.proxyAuth?.enabled
  ].filter(Boolean).length;

  return enabledProviders > 0; // NTLM + at least one other provider
}

/**
 * NTLM authentication middleware - self-contained like other auth middlewares
 * Handles both express-ntlm initialization and user processing
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export function ntlmAuthMiddleware(req, res, next) {
  const platform = configCache.getPlatform() || {};
  const ntlmAuth = platform.ntlmAuth || {};

  // Not enabled - skip
  if (!ntlmAuth.enabled) {
    return next();
  }

  // Skip if user is already authenticated by a previous middleware (JWT, OAuth, etc.)
  if (req.user && req.user.id && req.user.id !== 'anonymous') {
    // Debug logging in development
    if (process.env.NODE_ENV === 'development') {
      logger.debug('NTLM Debug: skipping NTLM - user already authenticated', {
        component: 'NtlmAuth',
        userId: req.user.id,
        authMode: req.user.authMode,
        url: req.url
      });
    }
    return next();
  }

  // Debug logging in development
  const isDev = process.env.NODE_ENV === 'development';
  if (isDev) {
    logger.debug('NTLM Debug: request', {
      component: 'NtlmAuth',
      url: req.url,
      hostname: req.hostname,
      origin: req.headers.origin,
      referer: req.headers.referer,
      userAgent: req.headers['user-agent']
    });
  }

  // Skip NTLM for Vite proxy in development to avoid authentication loops
  // NTLM requires multiple round trips with specific headers that Vite proxy doesn't handle well
  // Set SKIP_NTLM_VITE_PROXY=false to test NTLM through Vite (may cause issues)
  const skipNtlmForVite = process.env.SKIP_NTLM_VITE_PROXY !== 'false';
  const isViteProxy =
    skipNtlmForVite &&
    process.env.NODE_ENV === 'development' &&
    (req.hostname === 'localhost' || req.hostname === '127.0.0.1') &&
    (req.headers.origin?.includes('5173') || req.headers.referer?.includes('5173'));

  if (isViteProxy) {
    if (isDev) {
      logger.info('NTLM Debug: skipping NTLM for Vite proxy', { component: 'NtlmAuth' });
    }
    return next();
  }

  // When multiple auth providers are configured, NTLM should only activate when explicitly requested
  // This prevents automatic NTLM SSO from blocking access to local/LDAP login
  const multipleProviders = hasMultipleAuthProviders(platform);
  const ntlmRequested = req.query.ntlm === 'true' || req.session?.ntlmRequested === true;

  // Check if this is the NTLM login endpoint - use exact path matching for security
  const isNtlmLoginEndpoint =
    req.path === '/api/auth/ntlm/login' || req.path.startsWith('/api/auth/ntlm/login?');

  if (multipleProviders && !ntlmRequested && !isNtlmLoginEndpoint) {
    if (isDev) {
      logger.info('NTLM Debug: multiple providers configured, skipping auto-NTLM', {
        component: 'NtlmAuth'
      });
    }
    return next();
  }

  if (isDev) {
    logger.debug('NTLM Debug: applying NTLM middleware', { component: 'NtlmAuth' });
  }

  // Get or create the express-ntlm middleware instance
  const ntlmMiddleware = getNtlmMiddleware(ntlmAuth);

  // Track if response was sent by express-ntlm
  let responseSent = false;
  const originalEnd = res.end;
  const originalSend = res.send;

  // Intercept response to detect if express-ntlm sent it
  res.end = function (...args) {
    responseSent = true;
    if (isDev) {
      logger.debug('NTLM Debug: response sent by express-ntlm', {
        component: 'NtlmAuth',
        status: res.statusCode
      });
      if (res.statusCode === 401) {
        logger.debug('NTLM Debug: NTLM challenge sent', {
          component: 'NtlmAuth',
          headers: res.getHeaders()
        });
      }
    }
    return originalEnd.apply(this, args);
  };

  res.send = function (...args) {
    responseSent = true;
    if (isDev) {
      logger.debug('NTLM Debug: response sent by express-ntlm via send', {
        component: 'NtlmAuth',
        status: res.statusCode
      });
      if (res.statusCode === 500 && args.length > 0) {
        logger.error('NTLM Debug: 500 error body', { component: 'NtlmAuth', body: args[0] });
      }
    }
    return originalSend.apply(this, args);
  };

  // Set a timeout to prevent hanging
  const timeout = setTimeout(() => {
    if (!responseSent) {
      logger.error('NTLM Auth: express-ntlm middleware timed out after 5 seconds', {
        component: 'NtlmAuth'
      });
      res.end = originalEnd;
      res.send = originalSend;
      if (!res.headersSent) {
        return next();
      }
    }
  }, 5000);

  // Apply express-ntlm middleware first to populate req.ntlm
  try {
    ntlmMiddleware(req, res, async err => {
      clearTimeout(timeout);
      res.end = originalEnd;
      res.send = originalSend;

      if (responseSent) {
        if (isDev) {
          logger.debug('NTLM Debug: express-ntlm sent response directly, not calling next', {
            component: 'NtlmAuth'
          });
        }
        return; // Don't call next() if response was already sent
      }

      if (err) {
        logger.error('NTLM Auth: error in express-ntlm middleware', {
          component: 'NtlmAuth',
          error: err,
          url: req.url,
          method: req.method,
          headers: req.headers
        });
        // Continue without NTLM authentication on error
        return next();
      }

      // Now process the NTLM data if available
      try {
        if (isDev) {
          logger.debug('NTLM Debug: after express-ntlm', { component: 'NtlmAuth', ntlm: req.ntlm });
        }

        // Check if NTLM data is available (should be set by express-ntlm middleware)
        if (!req.ntlm) {
          // This is normal for public endpoints - just continue without authentication
          if (isDev) {
            logger.debug('NTLM Debug: no NTLM data, continuing without auth', {
              component: 'NtlmAuth'
            });
          }
          return next();
        }

        // Process NTLM user data
        let user = processNtlmUser(req, ntlmAuth);

        if (!user) {
          // User not authenticated via NTLM - continue without setting req.user
          return next();
        }

        // Enhance user with authenticated group
        const authConfig = platform.auth || {};
        user = enhanceUserGroups(user, authConfig, ntlmAuth);

        // LDAP group lookup - only when generating JWT (session start).
        // When generateJwtToken is false, NTLM re-authenticates every request
        // and LDAP lookup would be too expensive.
        // Skip for login endpoints — processNtlmLogin() handles LDAP lookup
        // separately to avoid duplicate LDAP queries on the same request.
        if (ntlmAuth.ldapGroupLookupProvider && ntlmAuth.generateJwtToken && !isNtlmLoginEndpoint) {
          user = await enhanceUserWithLdapGroups(user, ntlmAuth);
          // Re-apply: enhanceUserWithLdapGroups replaces user.groups with freshly
          // mapped groups, so we need to re-add authenticated/provider default groups.
          user = enhanceUserGroups(user, authConfig, ntlmAuth);
        }

        // Validate and persist NTLM user (similar to OIDC/Proxy)
        // User must be persisted - if this fails, authentication fails
        user = await validateAndPersistExternalUser(user, platform);
        logger.info('NTLM Auth: user persisted', {
          component: 'NtlmAuth',
          userId: user.id,
          groups: user.groups.join(', ')
        });

        // Set user in request
        req.user = user;

        // Optional: Generate JWT token for stateless operation
        if (ntlmAuth.generateJwtToken) {
          try {
            const sessionTimeout =
              ntlmAuth.sessionTimeoutMinutes || platform.localAuth?.sessionTimeoutMinutes || 480;
            const { token, expiresIn } = generateJwt(user, {
              authMode: 'ntlm',
              authProvider: user.provider,
              expiresInMinutes: sessionTimeout,
              additionalClaims: {
                domain: user.domain
              }
            });
            req.jwtToken = token;
            req.jwtExpiresIn = expiresIn;

            // Set HTTP-only cookie for authentication
            res.cookie('authToken', token, getAuthCookieOptions(expiresIn * 1000));
          } catch (tokenError) {
            logger.error('NTLM Auth: JWT token generation failed', {
              component: 'NtlmAuth',
              error: tokenError
            });
            // Continue without token - NTLM auth still valid
          }
        }

        logger.info('NTLM Auth: user authenticated', {
          component: 'NtlmAuth',
          userId: user.id,
          groups: user.groups.join(', ')
        });
        next();
      } catch (error) {
        logger.error('NTLM Auth: error processing NTLM authentication', {
          component: 'NtlmAuth',
          error
        });
        // Don't block the request - continue without authentication
        next();
      }
    });
  } catch (error) {
    clearTimeout(timeout);
    res.end = originalEnd;
    res.send = originalSend;
    logger.error('NTLM Auth: unexpected error in NTLM middleware', {
      component: 'NtlmAuth',
      error
    });
    // Continue without NTLM authentication on error
    next();
  }
}

/**
 * Get NTLM configuration
 * @returns {Object|null} NTLM configuration
 */
export function getNtlmConfig() {
  const platform = configCache.getPlatform() || {};
  return platform.ntlmAuth || null;
}

/**
 * Login function for NTLM authentication (for API endpoints)
 * @param {Object} req - Express request object with NTLM data
 * @param {Object} ntlmConfig - NTLM configuration
 * @returns {Promise<Object>} Login result with user and token
 */
export async function processNtlmLogin(req, ntlmConfig) {
  if (!req.ntlm || !req.ntlm.Authenticated) {
    throw new Error('NTLM authentication required');
  }

  // Process NTLM user data
  let user = processNtlmUser(req, ntlmConfig);

  if (!user) {
    throw new Error('Failed to process NTLM user data');
  }

  // Enhance user with authenticated group
  const platform = configCache.getPlatform() || {};
  const authConfig = platform.auth || {};

  user = enhanceUserGroups(user, authConfig, ntlmConfig);

  // LDAP group lookup (only during login/session start)
  if (ntlmConfig.ldapGroupLookupProvider) {
    user = await enhanceUserWithLdapGroups(user, ntlmConfig);
    // Re-apply: enhanceUserWithLdapGroups replaces user.groups with freshly
    // mapped groups, so we need to re-add authenticated/provider default groups.
    user = enhanceUserGroups(user, authConfig, ntlmConfig);
  }

  // Validate and persist NTLM user (similar to OIDC/Proxy)
  try {
    user = await validateAndPersistExternalUser(user, platform);
    logger.info('NTLM Auth: user persisted via login', { component: 'NtlmAuth', userId: user.id });
  } catch (userError) {
    logger.error('NTLM Auth: user persistence error during login', {
      component: 'NtlmAuth',
      error: userError
    });
    // Continue with authentication even if persistence fails
  }

  // Generate JWT token using centralized token service
  const sessionTimeout =
    ntlmConfig.sessionTimeoutMinutes || platform.localAuth?.sessionTimeoutMinutes || 480;
  const { token, expiresIn } = generateJwt(user, {
    authMode: 'ntlm',
    authProvider: user.provider,
    expiresInMinutes: sessionTimeout,
    additionalClaims: {
      domain: user.domain
    }
  });

  return {
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      groups: user.groups,
      authenticated: user.authenticated,
      authMethod: user.authMethod,
      provider: user.provider,
      domain: user.domain
    },
    token,
    expiresIn
  };
}

export default ntlmAuthMiddleware;
