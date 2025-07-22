import jwt from 'jsonwebtoken';
import { authenticate } from 'ldap-authentication';
import config from '../config.js';
import configCache from '../configCache.js';
import { enhanceUserGroups } from '../utils/authorization.js';

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
      ...(ldapConfig.groupSearchBase && {
        groupSearchBase: ldapConfig.groupSearchBase,
        groupClass: ldapConfig.groupClass || 'groupOfNames'
      })
    };

    console.log(`[LDAP Auth] Attempting authentication for user: ${username}`);
    console.log(`[LDAP Auth] LDAP server: ${ldapConfig.url}`);

    // Perform LDAP authentication
    const user = await authenticate(options);

    if (!user) {
      console.warn(`[LDAP Auth] Authentication failed for user: ${username}`);
      return null;
    }

    console.log(`[LDAP Auth] Authentication successful for user: ${username}`);

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

    // Apply group mapping
    const groupMap = configCache.getGroupMap();
    const mappedGroups = new Set();

    for (const group of groups) {
      const mapped = groupMap[group] || group;
      if (Array.isArray(mapped)) {
        mapped.forEach(g => mappedGroups.add(g));
      } else {
        mappedGroups.add(mapped);
      }
    }

    // Add default groups if configured
    if (ldapConfig.defaultGroups && Array.isArray(ldapConfig.defaultGroups)) {
      ldapConfig.defaultGroups.forEach(g => mappedGroups.add(g));
    }

    // Normalize user data
    const normalizedUser = {
      id: user.uid || user.sAMAccountName || user.cn || username,
      name: user.displayName || user.cn || user.name || `${user.givenName || ''} ${user.sn || ''}`.trim() || username,
      email: user.mail || user.email || null,
      groups: Array.from(mappedGroups),
      authenticated: true,
      authMethod: 'ldap',
      provider: ldapConfig.name || 'ldap',
      raw: user // Keep raw LDAP data for debugging
    };

    return normalizedUser;
  } catch (error) {
    console.error(`[LDAP Auth] Authentication error for user ${username}:`, error.message);
    return null;
  }
}

/**
 * Generate JWT token for authenticated LDAP user
 */
function generateJwtToken(user, ldapConfig) {
  const platform = configCache.getPlatform() || {};
  const jwtSecret = config.JWT_SECRET || platform.localAuth?.jwtSecret || ldapConfig.jwtSecret;

  if (!jwtSecret || jwtSecret === '${JWT_SECRET}') {
    throw new Error('JWT secret not configured for LDAP authentication');
  }

  const tokenPayload = {
    sub: user.id,
    name: user.name,
    email: user.email,
    groups: user.groups,
    provider: user.provider,
    authMode: 'ldap',
    authProvider: user.provider,
    iat: Math.floor(Date.now() / 1000)
  };

  const sessionTimeout = ldapConfig.sessionTimeoutMinutes || platform.localAuth?.sessionTimeoutMinutes || 480; // 8 hours default
  const expiresIn = sessionTimeout * 60; // Convert to seconds

  const token = jwt.sign(tokenPayload, jwtSecret, {
    expiresIn: `${expiresIn}s`,
    issuer: 'ai-hub-apps',
    audience: 'ai-hub-apps'
  });

  return { token, expiresIn };
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

  // Generate JWT token
  const { token, expiresIn } = generateJwtToken(user, ldapConfig);

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