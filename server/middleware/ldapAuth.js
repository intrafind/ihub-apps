import { authenticate } from 'ldap-authentication';
import configCache from '../configCache.js';
import { enhanceUserGroups, mapExternalGroups } from '../utils/authorization.js';
import { generateJwt } from '../utils/tokenService.js';
import logger from '../utils/logger.js';

/**
 * LDAP authentication configuration and utilities
 */

/**
 * Authenticate user against LDAP server
 * @param {string} username - Username
 * @param {string} password - Password
 * @param {Object} ldapConfig - LDAP configuration
 * @returns {Promise<Object>} User object or null
 */
async function authenticateLdapUser(username, password, ldapConfig) {
  try {
    // Prepare authentication options
    const options = {
      ldapOpts: {
        url: ldapConfig.url,
        // Optional: configure additional LDAP options
        ...(ldapConfig.tlsOptions && { tlsOptions: ldapConfig.tlsOptions }),
        ...(ldapConfig.timeout && { timeout: ldapConfig.timeout }),
        ...(ldapConfig.reconnect && { reconnect: ldapConfig.reconnect })
      },
      // Admin credentials for user search (if required)
      ...(ldapConfig.adminDn && {
        adminDn: ldapConfig.adminDn,
        adminPassword: ldapConfig.adminPassword
      }),
      // User search configuration
      userDn: ldapConfig.userDn || 'uid={{username}},ou=people,dc=example,dc=org',
      userPassword: password,
      userSearchBase: ldapConfig.userSearchBase || 'ou=people,dc=example,dc=org',
      usernameAttribute: ldapConfig.usernameAttribute || 'uid',
      username: username,
      // Group search configuration (optional)
      // Note: ldap-authentication library uses 'groupsSearchBase' (with 's')
      ...(ldapConfig.groupSearchBase && {
        groupsSearchBase: ldapConfig.groupSearchBase, // Library expects 'groupsSearchBase'
        groupClass: ldapConfig.groupClass || 'groupOfNames',
        groupMemberAttribute: ldapConfig.groupMemberAttribute || 'member',
        groupMemberUserAttribute: ldapConfig.groupMemberUserAttribute || 'dn'
      })
    };

    logger.info(`[LDAP Auth] Attempting authentication for user: ${username}`);
    logger.info(`[LDAP Auth] LDAP server: ${ldapConfig.url}`);
    if (ldapConfig.groupSearchBase) {
      logger.info(
        `[LDAP Auth] Group search enabled - groupSearchBase: ${ldapConfig.groupSearchBase}, groupClass: ${ldapConfig.groupClass || 'groupOfNames'}`
      );
    } else {
      logger.warn(`[LDAP Auth] Group search not configured - groupSearchBase is missing`);
    }

    // Perform LDAP authentication
    const user = await authenticate(options);

    if (!user) {
      logger.warn(`[LDAP Auth] Authentication failed for user: ${username}`);
      return null;
    }

    logger.info(`[LDAP Auth] Authentication successful for user: ${username}`);

    // Log raw user object for debugging (before group extraction)
    logger.debug(`[LDAP Auth] Raw LDAP user object:`, {
      hasGroups: !!user.groups,
      groupsType: user.groups ? typeof user.groups : 'undefined',
      groupsIsArray: Array.isArray(user.groups),
      groupsLength: user.groups ? user.groups.length : 0,
      userKeys: Object.keys(user),
      sampleGroup: user.groups && user.groups.length > 0 ? user.groups[0] : 'none'
    });

    // Extract groups from LDAP response
    let groups = [];
    if (user.groups && Array.isArray(user.groups)) {
      groups = user.groups.map(group => {
        if (typeof group === 'string') {
          return group;
        } else if (group.cn) {
          return group.cn;
        } else if (group.name) {
          return group.name;
        }
        return String(group);
      });
    }

    // Log extracted LDAP groups for troubleshooting
    if (groups.length > 0) {
      logger.info(
        `[LDAP Auth] Extracted ${groups.length} LDAP groups for user ${username}:`,
        groups
      );
    } else {
      logger.warn(`[LDAP Auth] No groups found in LDAP response for user ${username}`);
    }

    // Apply group mapping using centralized function
    const mappedGroups = mapExternalGroups(groups);
    logger.info(
      `[LDAP Auth] Mapped ${groups.length} LDAP groups to ${mappedGroups.length} internal groups for user ${username}:`,
      mappedGroups
    );

    // Add default groups if configured
    if (ldapConfig.defaultGroups && Array.isArray(ldapConfig.defaultGroups)) {
      ldapConfig.defaultGroups.forEach(g => mappedGroups.push(g));
    }

    // Normalize user data
    const normalizedUser = {
      id: user.uid || user.sAMAccountName || user.cn || username,
      name:
        user.displayName ||
        user.cn ||
        user.name ||
        `${user.givenName || ''} ${user.sn || ''}`.trim() ||
        username,
      email: user.mail || user.email || null,
      groups: mappedGroups,
      authenticated: true,
      authMethod: 'ldap',
      provider: ldapConfig.name || 'ldap',
      raw: user // Keep raw LDAP data for debugging
    };

    return normalizedUser;
  } catch (error) {
    logger.error(`[LDAP Auth] Authentication error for user ${username}:`, error.message);
    return null;
  }
}

/**
 * Login function for LDAP authentication
 * @param {string} username - Username
 * @param {string} password - Password
 * @param {Object} ldapConfig - LDAP configuration
 * @returns {Object} Login result with user and token
 */
export async function loginLdapUser(username, password, ldapConfig) {
  if (!username || !password) {
    throw new Error('Username and password are required');
  }

  if (!ldapConfig || !ldapConfig.url) {
    throw new Error('LDAP configuration missing or incomplete');
  }

  // Authenticate user
  let user = await authenticateLdapUser(username, password, ldapConfig);

  if (!user) {
    throw new Error('Invalid credentials');
  }

  // Enhance user with authenticated group and provider-specific groups
  const platform = configCache.getPlatform() || {};
  const authConfig = platform.auth || {};

  user = enhanceUserGroups(user, authConfig, ldapConfig);

  // Generate JWT token using centralized token service
  const sessionTimeout =
    ldapConfig.sessionTimeoutMinutes || platform.localAuth?.sessionTimeoutMinutes || 480;
  const { token, expiresIn } = generateJwt(user, {
    authMode: 'ldap',
    authProvider: user.provider,
    expiresInMinutes: sessionTimeout
  });

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      groups: user.groups,
      authenticated: user.authenticated,
      authMethod: user.authMethod,
      provider: user.provider
    },
    token,
    expiresIn
  };
}

/**
 * LDAP authentication middleware (placeholder - actual JWT validation handled by jwtAuthMiddleware)
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export default function ldapAuthMiddleware(req, res, next) {
  // LDAP auth middleware is primarily a placeholder for any LDAP-specific logic
  // The actual JWT validation happens in jwtAuthMiddleware
  next();
}

/**
 * Get LDAP configuration for a specific provider
 * @param {string} providerName - LDAP provider name
 * @returns {Object|null} LDAP provider configuration
 */
export function getLdapConfig(providerName) {
  const platform = configCache.getPlatform() || {};
  const ldapAuth = platform.ldapAuth || {};

  if (!ldapAuth.enabled || !ldapAuth.providers) {
    return null;
  }

  return ldapAuth.providers.find(provider => provider.name === providerName) || null;
}

/**
 * Get list of configured LDAP providers
 * @returns {Array} Array of LDAP provider configurations
 */
export function getConfiguredLdapProviders() {
  const platform = configCache.getPlatform() || {};
  const ldapAuth = platform.ldapAuth || {};

  if (!ldapAuth.enabled || !ldapAuth.providers) {
    return [];
  }

  return ldapAuth.providers.map(provider => ({
    name: provider.name,
    displayName: provider.displayName || provider.name,
    url: provider.url
  }));
}
