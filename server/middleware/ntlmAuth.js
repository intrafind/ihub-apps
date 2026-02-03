import expressNtlm from 'express-ntlm';
import configCache from '../configCache.js';
import { enhanceUserGroups, mapExternalGroups } from '../utils/authorization.js';
import { generateJwt } from '../utils/tokenService.js';
import logger from '../utils/logger.js';

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
    ...ntlmConfig.options
  };

  logger.info(
    `[NTLM Auth] Configuring NTLM middleware with domain: ${options.domain || 'default'}`
  );
  logger.info(`[NTLM Auth] Domain controller: ${options.domaincontroller || 'NOT CONFIGURED'}`);
  logger.info(`[NTLM Auth] Get groups enabled: ${options.getGroups}`);
  logger.info(
    `[NTLM Auth] LDAP bind user: ${options.domaincontrolleruser ? '✓ Configured' : '✗ NOT CONFIGURED'}`
  );
  logger.info(
    `[NTLM Auth] LDAP bind password: ${options.domaincontrollerpassword ? '✓ Configured' : '✗ NOT CONFIGURED'}`
  );
  logger.info(`[NTLM Auth] Debug mode: ${options.debug}`);

  // Warn if getGroups is enabled but no domain controller is configured
  if (options.getGroups && !options.domaincontroller) {
    logger.warn(
      '⚠️  [NTLM Auth] WARNING: getGroups is enabled but no domain controller is configured.'
    );
    logger.warn('⚠️  [NTLM Auth] Group retrieval requires a domain controller for LDAP queries.');
    logger.warn('⚠️  [NTLM Auth] Users will be assigned default groups only.');
    logger.warn(
      '⚠️  [NTLM Auth] To fix: Configure "domainController" in platform.json ntlmAuth section'
    );
    logger.warn('⚠️  [NTLM Auth] Example: "domainController": "ldap://dc.yourdomain.com"');
  }

  // Warn if getGroups is enabled but LDAP credentials are missing
  if (
    options.getGroups &&
    options.domaincontroller &&
    (!options.domaincontrolleruser || !options.domaincontrollerpassword)
  ) {
    logger.warn(
      '⚠️  [NTLM Auth] WARNING: getGroups is enabled with domain controller, but LDAP credentials are missing.'
    );
    logger.warn(
      '⚠️  [NTLM Auth] Group retrieval requires LDAP bind credentials to query Active Directory.'
    );
    logger.warn(
      '⚠️  [NTLM Auth] Configure "domainControllerUser" and "domainControllerPassword" in platform.json'
    );
    logger.warn(
      '⚠️  [NTLM Auth] Example: "domainControllerUser": "CN=Service Account,OU=Users,DC=muc,DC=intrafind,DC=de"'
    );
    logger.warn(
      '⚠️  [NTLM Auth] Or use environment variables: NTLM_LDAP_USER and NTLM_LDAP_PASSWORD'
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
    logger.debug('[NTLM Auth] No NTLM data in request');
    return null;
  }

  const ntlmUser = req.ntlm;

  logger.debug('[NTLM Auth] Raw NTLM data:', JSON.stringify(ntlmUser, null, 2));

  // Check if user is authenticated
  if (!ntlmUser.Authenticated) {
    logger.warn(
      `[NTLM Auth] User not authenticated: ${ntlmUser.UserName || ntlmUser.username || 'unknown'}`
    );
    return null;
  }

  logger.info(
    `[NTLM Auth] Processing authenticated user: ${ntlmUser.UserName || ntlmUser.username}`
  );

  // Extract user information
  const userId = ntlmUser.username || ntlmUser.UserName;
  const domain = ntlmUser.domain || ntlmUser.Domain;
  const fullUsername = domain ? `${domain}\\${userId}` : userId;

  // Extract groups - check all possible field names
  let groups = [];
  if (ntlmUser.groups && Array.isArray(ntlmUser.groups)) {
    groups = ntlmUser.groups;
    logger.debug('[NTLM Auth] Found groups in ntlmUser.groups:', groups);
  } else if (ntlmUser.Groups && Array.isArray(ntlmUser.Groups)) {
    groups = ntlmUser.Groups;
    logger.debug('[NTLM Auth] Found groups in ntlmUser.Groups:', groups);
  } else {
    logger.debug(
      '[NTLM Auth] No groups found in NTLM data. Available fields:',
      Object.keys(ntlmUser)
    );
    logger.debug('[NTLM Auth] NTLM config getGroups setting:', ntlmConfig.getGroups);
    logger.debug(
      '[NTLM Auth] NTLM config domainController:',
      ntlmConfig.domainController || 'NOT CONFIGURED'
    );

    if (ntlmConfig.getGroups && !ntlmConfig.domainController) {
      logger.warn(
        '⚠️  [NTLM Auth] Groups cannot be retrieved without a domain controller configuration'
      );
    }
  }

  logger.debug('[NTLM Auth] Extracted groups before mapping:', groups);

  // Apply group mapping using centralized function
  const mappedGroups = mapExternalGroups(groups);

  logger.debug('[NTLM Auth] Groups after mapping:', mappedGroups);

  // Add default groups if configured
  if (ntlmConfig.defaultGroups && Array.isArray(ntlmConfig.defaultGroups)) {
    logger.debug('[NTLM Auth] Adding default groups:', ntlmConfig.defaultGroups);
    ntlmConfig.defaultGroups.forEach(g => {
      if (!mappedGroups.includes(g)) {
        mappedGroups.push(g);
      }
    });
  }

  logger.debug('[NTLM Auth] Final groups for user:', mappedGroups);

  // Create normalized user object
  const user = {
    id: fullUsername,
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

  logger.debug('[NTLM Auth] Created user object:', {
    id: user.id,
    name: user.name,
    groups: user.groups,
    externalGroups: user.externalGroups
  });

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
      logger.debug('[NTLM Debug] Skipping NTLM - user already authenticated:', {
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
    logger.debug('[NTLM Debug] Request:', {
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
      logger.info(
        '[NTLM Debug] Skipping NTLM for Vite proxy (set SKIP_NTLM_VITE_PROXY=false to test NTLM through Vite)'
      );
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
      logger.info(
        '[NTLM Debug] Multiple providers configured, skipping auto-NTLM (not explicitly requested)'
      );
    }
    return next();
  }

  if (isDev) {
    logger.debug('[NTLM Debug] Applying NTLM middleware');
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
      logger.debug('[NTLM Debug] Response sent by express-ntlm, status:', res.statusCode);
      if (res.statusCode === 401) {
        logger.debug('[NTLM Debug] NTLM challenge sent, headers:', res.getHeaders());
      }
    }
    return originalEnd.apply(this, args);
  };

  res.send = function (...args) {
    responseSent = true;
    if (isDev) {
      logger.debug('[NTLM Debug] Response sent by express-ntlm (via send), status:', res.statusCode);
      if (res.statusCode === 500 && args.length > 0) {
        logger.error('[NTLM Debug] 500 Error body:', args[0]);
      }
    }
    return originalSend.apply(this, args);
  };

  // Set a timeout to prevent hanging
  const timeout = setTimeout(() => {
    if (!responseSent) {
      logger.error('[NTLM Auth] express-ntlm middleware timed out after 5 seconds');
      res.end = originalEnd;
      res.send = originalSend;
      if (!res.headersSent) {
        return next();
      }
    }
  }, 5000);

  // Apply express-ntlm middleware first to populate req.ntlm
  try {
    ntlmMiddleware(req, res, err => {
      clearTimeout(timeout);
      res.end = originalEnd;
      res.send = originalSend;

      if (responseSent) {
        if (isDev) {
          logger.debug('[NTLM Debug] express-ntlm sent response directly, not calling next()');
        }
        return; // Don't call next() if response was already sent
      }

      if (err) {
        logger.error('[NTLM Auth] Error in express-ntlm middleware:', err.message);
        logger.error('[NTLM Auth] Error stack:', err.stack);
        logger.error('[NTLM Auth] Request details:', {
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
          logger.debug('[NTLM Debug] After express-ntlm, req.ntlm:', req.ntlm);
        }

        // Check if NTLM data is available (should be set by express-ntlm middleware)
        if (!req.ntlm) {
          // This is normal for public endpoints - just continue without authentication
          if (isDev) {
            logger.debug('[NTLM Debug] No NTLM data, continuing without auth');
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
            res.cookie('authToken', token, {
              httpOnly: true,
              secure: process.env.NODE_ENV === 'production',
              sameSite: 'lax',
              maxAge: expiresIn * 1000
            });
          } catch (tokenError) {
            logger.error('[NTLM Auth] JWT token generation failed:', tokenError.message);
            // Continue without token - NTLM auth still valid
          }
        }

        logger.info(
          `[NTLM Auth] User authenticated: ${user.id} with groups: ${user.groups.join(', ')}`
        );
        next();
      } catch (error) {
        logger.error('[NTLM Auth] Error processing NTLM authentication:', error);
        logger.error('[NTLM Auth] Stack trace:', error.stack);
        // Don't block the request - continue without authentication
        next();
      }
    });
  } catch (error) {
    clearTimeout(timeout);
    res.end = originalEnd;
    res.send = originalSend;
    logger.error('[NTLM Auth] Unexpected error in NTLM middleware:', error.message);
    logger.error('[NTLM Auth] Stack trace:', error.stack);
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
 * @returns {Object} Login result with user and token
 */
export function processNtlmLogin(req, ntlmConfig) {
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
