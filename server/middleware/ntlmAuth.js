import expressNtlm from 'express-ntlm';
import configCache from '../configCache.js';
import { enhanceUserGroups, mapExternalGroups } from '../utils/authorization.js';
import { generateJwt } from '../utils/tokenService.js';

/**
 * NTLM/Windows Authentication middleware and utilities
 */

/**
 * Create NTLM middleware with configuration
 * @param {Object} ntlmConfig - NTLM configuration
 * @returns {Function} Express middleware
 */
export function createNtlmMiddleware(ntlmConfig = {}) {
  const options = {
    debug: ntlmConfig.debug || false,
    domain: ntlmConfig.domain,
    domaincontroller: ntlmConfig.domainController,
    // Optional: specify which fields to return
    getUserInfo: ntlmConfig.getUserInfo !== false, // Default true
    // Optional: specify authentication type
    type: ntlmConfig.type || 'ntlm', // 'ntlm' or 'negotiate'
    // Optional: specify if we should get user groups
    getGroups: ntlmConfig.getGroups !== false, // Default true
    ...ntlmConfig.options
  };

  console.log(
    `[NTLM Auth] Configuring NTLM middleware with domain: ${options.domain || 'default'}`
  );

  return expressNtlm(options);
}

/**
 * Process NTLM authentication result
 * @param {Object} req - Express request object
 * @param {Object} ntlmConfig - NTLM configuration
 * @returns {Object|null} Processed user object or null
 */
function processNtlmUser(req, ntlmConfig) {
  if (!req.ntlm) {
    return null;
  }

  const ntlmUser = req.ntlm;

  // Check if user is authenticated
  if (!ntlmUser.Authenticated) {
    console.warn(`[NTLM Auth] User not authenticated: ${ntlmUser.username || 'unknown'}`);
    return null;
  }

  console.log(`[NTLM Auth] Processing authenticated user: ${ntlmUser.username}`);

  // Extract user information
  const userId = ntlmUser.username || ntlmUser.UserName;
  const domain = ntlmUser.domain || ntlmUser.Domain;
  const fullUsername = domain ? `${domain}\\${userId}` : userId;

  // Extract groups
  let groups = [];
  if (ntlmUser.groups && Array.isArray(ntlmUser.groups)) {
    groups = ntlmUser.groups;
  } else if (ntlmUser.Groups && Array.isArray(ntlmUser.Groups)) {
    groups = ntlmUser.Groups;
  }

  // Apply group mapping using centralized function
  const mappedGroups = mapExternalGroups(groups);

  // Add default groups if configured
  if (ntlmConfig.defaultGroups && Array.isArray(ntlmConfig.defaultGroups)) {
    ntlmConfig.defaultGroups.forEach(g => mappedGroups.push(g));
  }

  // Create normalized user object
  const user = {
    id: fullUsername,
    name: ntlmUser.DisplayName || ntlmUser.displayName || fullUsername,
    email: ntlmUser.email || ntlmUser.Email || null,
    groups: mappedGroups,
    authenticated: true,
    authMethod: 'ntlm',
    provider: ntlmConfig.name || 'ntlm',
    domain: domain,
    workstation: ntlmUser.workstation || ntlmUser.Workstation,
    raw: ntlmUser // Keep raw NTLM data for debugging
  };

  return user;
}

/**
 * NTLM authentication middleware
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export function ntlmAuthMiddleware(req, res, next) {
  const platform = configCache.getPlatform() || {};
  const ntlmAuth = platform.ntlmAuth || {};

  if (!ntlmAuth.enabled) {
    return next();
  }

  // Check if NTLM data is available (should be set by express-ntlm middleware)
  if (!req.ntlm) {
    console.warn(
      '[NTLM Auth] No NTLM data found in request. Make sure express-ntlm middleware is configured.'
    );
    return next();
  }

  try {
    // Process NTLM user data
    let user = processNtlmUser(req, ntlmAuth);

    if (!user) {
      req.user = null;
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
        console.error('[NTLM Auth] JWT token generation failed:', tokenError.message);
        // Continue without token - NTLM auth still valid
      }
    }

    console.log(
      `[NTLM Auth] User authenticated: ${user.id} with groups: ${user.groups.join(', ')}`
    );
    next();
  } catch (error) {
    console.error('[NTLM Auth] Error processing NTLM authentication:', error);
    req.user = null;
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
