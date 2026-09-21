import { authenticate } from 'ldap-authentication';
import configCache from '../configCache.js';
import credentialService from '../services/CredentialService.js';
import { enhanceUserGroups, mapExternalGroups } from '../utils/authorization.js';
import {
  buildLdapAuthOptions,
  escapeLdapFilterValue,
  extractGroupNames,
  mapLdapUserAttributes,
  resolveLdapProvider
} from '../utils/ldapProviderConfig.js';
import { generateJwt } from '../utils/tokenService.js';
import { validateAndPersistExternalUser } from '../utils/userManager.js';
import logger from '../utils/logger.js';

/**
 * LDAP authentication configuration and utilities.
 *
 * Provider configuration is resolved through `utils/ldapProviderConfig.js`, so
 * a provider that only sets `url`, `baseDn` and `preset` gets the same search
 * bases, DN template and attribute mapping here as it does in the admin
 * connection test.
 */

/**
 * Authenticate user against LDAP server
 * @param {string} username - Username
 * @param {string} password - Password
 * @param {Object} ldapConfig - LDAP configuration
 * @returns {Promise<Object>} User object or null
 */
async function authenticateLdapUser(username, password, ldapConfig) {
  const resolved = resolveLdapProvider(ldapConfig);

  try {
    // The bind-account password is resolved from the central credential store
    // via adminPasswordRef; without it the user is bound directly as userDn.
    const options = buildLdapAuthOptions(resolved, {
      username,
      password,
      adminPassword: resolved.adminDn
        ? credentialService.resolveSecret(resolved.adminPasswordRef)
        : undefined
    });

    logger.info('LDAP Auth: attempting authentication for user', {
      component: 'LdapAuth',
      username
    });
    logger.info('LDAP Auth: LDAP server', { component: 'LdapAuth', url: resolved.url });
    if (resolved.groupSearchBase) {
      logger.info('LDAP Auth: group search enabled', {
        component: 'LdapAuth',
        groupSearchBase: resolved.groupSearchBase,
        groupClass: resolved.groupClass
      });
    } else {
      logger.warn('LDAP Auth: group search not configured, no baseDn or groupSearchBase is set', {
        component: 'LdapAuth'
      });
    }

    // Perform LDAP authentication
    const user = await authenticate(options);

    if (!user) {
      logger.warn('LDAP Auth: authentication failed for user', { component: 'LdapAuth', username });
      return null;
    }

    logger.info('LDAP Auth: authentication successful for user', {
      component: 'LdapAuth',
      username
    });

    // Log raw user object for debugging (before group extraction)
    logger.debug('LDAP Auth: raw LDAP user object', {
      component: 'LdapAuth',
      hasGroups: !!user.groups,
      groupsType: user.groups ? typeof user.groups : 'undefined',
      groupsIsArray: Array.isArray(user.groups),
      groupsLength: user.groups ? user.groups.length : 0,
      userKeys: Object.keys(user),
      sampleGroup: user.groups && user.groups.length > 0 ? user.groups[0] : 'none'
    });

    // Extract groups from LDAP response
    const groups = extractGroupNames(user.groups);

    // Log extracted LDAP groups for troubleshooting
    if (groups.length > 0) {
      logger.info('LDAP Auth: extracted LDAP groups for user', {
        component: 'LdapAuth',
        username,
        groupCount: groups.length,
        groups: groups.join(', ')
      });
    } else {
      logger.warn('LDAP Auth: no groups found in LDAP response for user', {
        component: 'LdapAuth',
        username
      });
    }

    // Apply group mapping using centralized function
    const mappedGroups = mapExternalGroups(groups);
    logger.info('LDAP Auth: mapped LDAP groups to internal groups', {
      component: 'LdapAuth',
      username,
      ldapGroupCount: groups.length,
      internalGroupCount: mappedGroups.length,
      internalGroups: mappedGroups.join(', ')
    });

    // Add default groups if configured
    if (ldapConfig.defaultGroups && Array.isArray(ldapConfig.defaultGroups)) {
      ldapConfig.defaultGroups.forEach(g => mappedGroups.push(g));
    }

    // Map LDAP attributes onto iHub's user fields using the provider's
    // (preset-derived or explicit) attribute mapping.
    const mapped = mapLdapUserAttributes(user, resolved, username);
    logger.debug('LDAP Auth: mapped LDAP attributes to user fields', {
      component: 'LdapAuth',
      username,
      usedAttributes: mapped.usedAttributes
    });

    const normalizedUser = {
      id: mapped.id,
      name: mapped.name,
      email: mapped.email,
      groups: mappedGroups,
      authenticated: true,
      authMethod: 'ldap',
      provider: resolved.name || 'ldap',
      raw: user, // Keep raw LDAP data for debugging
      extractedGroups: groups // Store extracted LDAP group names (strings) for user persistence
    };

    return normalizedUser;
  } catch (error) {
    logger.error('LDAP Auth: authentication error for user', {
      component: 'LdapAuth',
      username,
      error
    });
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

  // Persist LDAP user in users.json (similar to OIDC/Proxy/NTLM)
  // Note: We don't pass externalGroups here because LDAP groups are already mapped
  // in authenticateLdapUser(). Passing externalGroups would cause duplicate mapping.
  const externalUser = {
    id: user.id,
    username: username, // Original LDAP login (sAMAccountName), needed for the JWT username claim
    name: user.name,
    email: user.email,
    authMethod: 'ldap',
    provider: ldapConfig.name || 'ldap',
    groups: user.groups, // Already mapped groups (with authenticated, defaults)
    // Don't pass externalGroups - would cause duplicate mapExternalGroups() call
    ldapData: {
      subject: user.id,
      provider: ldapConfig.name || 'ldap',
      lastProvider: ldapConfig.name || 'ldap',
      username: username,
      // Store extracted LDAP groups for reference/debugging
      ldapGroups: user.extractedGroups || []
    }
  };

  // Validate and persist user in users.json
  const persistedUser = await validateAndPersistExternalUser(externalUser, platform);

  logger.info('LDAP Auth: user persisted in users.json', {
    component: 'LdapAuth',
    userId: persistedUser.id
  });

  // Generate JWT token using centralized token service
  const sessionTimeout =
    ldapConfig.sessionTimeoutMinutes || platform.localAuth?.sessionTimeoutMinutes || 480;
  const { token, expiresIn } = generateJwt(persistedUser, {
    authMode: 'ldap',
    authProvider: persistedUser.provider,
    expiresInMinutes: sessionTimeout
  });

  return {
    user: {
      id: persistedUser.id,
      name: persistedUser.name,
      email: persistedUser.email,
      groups: persistedUser.groups,
      authenticated: true,
      authMethod: 'ldap',
      provider: persistedUser.provider
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

/**
 * Get LDAP provider by name regardless of whether ldapAuth is enabled.
 * Used for NTLM LDAP group lookup where LDAP auth itself may be disabled
 * but providers are configured for group queries.
 * @param {string} providerName - LDAP provider name
 * @returns {Object|null} LDAP provider configuration
 */
export function getLdapProviderByName(providerName) {
  const platform = configCache.getPlatform() || {};
  const ldapAuth = platform.ldapAuth || {};

  if (!ldapAuth.providers || !Array.isArray(ldapAuth.providers)) {
    return null;
  }

  return ldapAuth.providers.find(provider => provider.name === providerName) || null;
}

/**
 * Look up a user's LDAP group memberships without authenticating them.
 * Uses admin bind credentials and verifyUserExists mode to search for the user
 * and retrieve their group memberships. Designed for use with NTLM auth where
 * the user's password is not available.
 * @param {string} username - Username to look up
 * @param {Object} ldapProviderConfig - LDAP provider configuration with admin credentials
 * @returns {Promise<string[]>} Array of LDAP group name strings
 */
export async function lookupLdapGroupsForUser(username, ldapProviderConfig) {
  if (!username || typeof username !== 'string') {
    throw new Error('Username is required for LDAP group lookup');
  }

  if (!ldapProviderConfig.adminDn || !ldapProviderConfig.adminPasswordRef) {
    throw new Error(
      'LDAP provider must have adminDn and adminPasswordRef configured for group lookup'
    );
  }

  const resolved = resolveLdapProvider(ldapProviderConfig);

  if (!resolved.url || !resolved.userSearchBase) {
    throw new Error('LDAP provider must have url and a baseDn or userSearchBase configured');
  }

  const options = buildLdapAuthOptions(resolved, {
    // Escaped for safe use in LDAP search filters (RFC 4515)
    username: escapeLdapFilterValue(username),
    adminPassword: credentialService.resolveSecret(resolved.adminPasswordRef),
    verifyUserExists: true
  });

  logger.info('LDAP Group Lookup: searching groups for user', {
    component: 'LdapGroupLookup',
    username,
    url: resolved.url,
    groupSearchBase: resolved.groupSearchBase || 'NOT CONFIGURED'
  });

  const user = await authenticate(options);

  if (!user) {
    logger.warn('LDAP Group Lookup: user not found in LDAP', {
      component: 'LdapGroupLookup',
      username
    });
    return [];
  }

  const groups = extractGroupNames(user.groups);

  logger.info('LDAP Group Lookup: found groups for user', {
    component: 'LdapGroupLookup',
    username,
    groupCount: groups.length,
    groups: groups.join(', ')
  });

  return groups;
}
