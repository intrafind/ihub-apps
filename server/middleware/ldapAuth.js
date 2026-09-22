import { authenticate } from 'ldap-authentication';
import configCache from '../configCache.js';
import credentialService from '../services/CredentialService.js';
import { enhanceUserGroups, mapExternalGroups } from '../utils/authorization.js';
import { generateJwt } from '../utils/tokenService.js';
import { validateAndPersistExternalUser } from '../utils/userManager.js';
import logger from '../utils/logger.js';

/**
 * LDAP authentication configuration and utilities
 */

/**
 * Escape special characters in a string for use in LDAP search filters (RFC 4515).
 * Prevents LDAP filter injection when user-supplied values are used in queries.
 * @param {string} str - Raw string to escape
 * @returns {string} Escaped string safe for LDAP filter use
 */
function escapeLdapFilterValue(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[\\*()\x00]/g, c => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

/**
 * Extract a group name from an LDAP group entry.
 * Handles string values, objects with cn/name/displayName, and DN parsing.
 * @param {string|Object} group - LDAP group entry
 * @returns {string|null} Group name or null if not extractable
 */
function extractGroupName(group) {
  if (typeof group === 'string') {
    return group;
  }

  if (typeof group === 'object' && group !== null) {
    if (group.cn) {
      return Array.isArray(group.cn) ? group.cn[0] : group.cn;
    }
    if (group.name) {
      return Array.isArray(group.name) ? group.name[0] : group.name;
    }
    if (group.displayName) {
      return Array.isArray(group.displayName) ? group.displayName[0] : group.displayName;
    }
    if (group.dn) {
      const dnString = Array.isArray(group.dn) ? group.dn[0] : group.dn;
      const cnMatch = dnString.match(/^CN=([^,]+)/i);
      if (cnMatch) {
        return cnMatch[1];
      }
    }
  }

  return null;
}

/**
 * Extract group names from an LDAP groups response.
 * Handles both array and object formats.
 * @param {Array|Object} groups - Raw groups from LDAP response
 * @returns {string[]} Array of group name strings
 */
function extractGroupNames(groups) {
  if (!groups) {
    return [];
  }

  const groupsArray = Array.isArray(groups)
    ? groups
    : Object.values(groups).filter(g => g && typeof g === 'object');

  return groupsArray
    .map(group => {
      const name = extractGroupName(group);
      if (name === null && group != null) {
        logger.warn('LDAP: could not extract group name from group object', {
          component: 'LdapAuth',
          group
        });
      }
      return name;
    })
    .filter(g => g !== null);
}

/**
 * Attributes requested for the user entry.
 *
 * `*` is the RFC 4511 shorthand for "every user attribute", i.e. exactly what
 * the server returns when no attribute list is sent at all — so naming it keeps
 * the previous behaviour intact. `msDS-PrincipalName` has to be listed
 * explicitly next to it: it is an Active Directory *constructed* attribute, and
 * constructed attributes are never covered by `*`. It holds the account in
 * `DOMAIN\\sAMAccountName` form, which is the only per-user source for the
 * NetBIOS domain name. Directories that do not have it (OpenLDAP, and AD where
 * the bind account cannot read it) simply omit it from the entry.
 */
const USER_SEARCH_ATTRIBUTES = ['*', 'msDS-PrincipalName'];

/**
 * Read the first value of an LDAP attribute, which may come back as a scalar
 * or as a single-element array depending on the server.
 * @param {*} value - Raw attribute value
 * @returns {string|null} First value as a string, or null
 */
function firstAttributeValue(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

/**
 * Split an Active Directory `msDS-PrincipalName` (`DOMAIN\\account`) into its
 * parts. Returns nulls for anything that is not in that form, including the
 * bare-account form some directories return.
 * @param {*} value - Raw `msDS-PrincipalName` attribute value
 * @returns {{domain: string|null, account: string|null}}
 */
export function parsePrincipalName(value) {
  const principal = firstAttributeValue(value);
  if (!principal) return { domain: null, account: null };

  const separator = principal.indexOf('\\');
  if (separator <= 0 || separator === principal.length - 1) {
    return { domain: null, account: principal };
  }

  return {
    domain: principal.slice(0, separator),
    account: principal.slice(separator + 1)
  };
}

/**
 * Resolve the NetBIOS domain name for an authenticated LDAP user.
 *
 * Configuration wins over detection: an admin who typed a domain has stated
 * what iFinder expects to see, and a directory that disagrees does not get to
 * overrule that. Detection only covers the case where nothing was configured.
 *
 * @param {Object} ldapUser - Raw LDAP user entry
 * @param {Object} ldapConfig - LDAP provider configuration
 * @param {string} username - Login name, for logging
 * @returns {string|null} NetBIOS domain name, or null when neither source has one
 */
export function resolveLdapDomain(ldapUser, ldapConfig, username) {
  const configured = typeof ldapConfig?.domain === 'string' ? ldapConfig.domain.trim() : '';
  const { domain: detected, account } = parsePrincipalName(ldapUser?.['msDS-PrincipalName']);

  if (configured) {
    if (detected && detected.toLowerCase() !== configured.toLowerCase()) {
      logger.warn(
        'LDAP Auth: configured domain differs from the directory msDS-PrincipalName; using the configured value',
        { component: 'LdapAuth', username, configured, detected }
      );
    }
    return configured;
  }

  if (detected) {
    logger.debug('LDAP Auth: domain detected from msDS-PrincipalName', {
      component: 'LdapAuth',
      username,
      domain: detected,
      account
    });
    return detected;
  }

  return null;
}

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
      // Admin credentials for user search (if required). The admin password is
      // resolved from the central credential store via adminPasswordRef.
      ...(ldapConfig.adminDn && {
        adminDn: ldapConfig.adminDn,
        adminPassword: credentialService.resolveSecret(ldapConfig.adminPasswordRef)
      }),
      // User search configuration
      userDn: ldapConfig.userDn || 'uid={{username}},ou=people,dc=example,dc=org',
      userPassword: password,
      userSearchBase: ldapConfig.userSearchBase || 'ou=people,dc=example,dc=org',
      usernameAttribute: ldapConfig.usernameAttribute || 'uid',
      username: username,
      attributes: USER_SEARCH_ATTRIBUTES,
      // Group search configuration (optional)
      // Note: ldap-authentication library uses 'groupsSearchBase' (with 's')
      ...(ldapConfig.groupSearchBase && {
        groupsSearchBase: ldapConfig.groupSearchBase, // Library expects 'groupsSearchBase'
        groupClass: ldapConfig.groupClass || 'groupOfNames',
        groupMemberAttribute: ldapConfig.groupMemberAttribute || 'member',
        groupMemberUserAttribute: ldapConfig.groupMemberUserAttribute || 'dn'
      })
    };

    logger.info('LDAP Auth: attempting authentication for user', {
      component: 'LdapAuth',
      username
    });
    logger.info('LDAP Auth: LDAP server', { component: 'LdapAuth', url: ldapConfig.url });
    if (ldapConfig.groupSearchBase) {
      logger.info('LDAP Auth: group search enabled', {
        component: 'LdapAuth',
        groupSearchBase: ldapConfig.groupSearchBase,
        groupClass: ldapConfig.groupClass || 'groupOfNames'
      });
    } else {
      logger.warn('LDAP Auth: group search not configured, groupSearchBase is missing', {
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

    // NetBIOS domain, for the iFinder `domain\\username` JWT subject. Null when
    // neither configured nor present in the directory, which the subject
    // resolver reports rather than silently dropping.
    const domain = resolveLdapDomain(user, ldapConfig, username);

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
      ...(domain && { domain }),
      authenticated: true,
      authMethod: 'ldap',
      provider: ldapConfig.name || 'ldap',
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
    ...(user.domain && { domain: user.domain }),
    // Don't pass externalGroups - would cause duplicate mapExternalGroups() call
    ldapData: {
      subject: user.id,
      provider: ldapConfig.name || 'ldap',
      lastProvider: ldapConfig.name || 'ldap',
      username: username,
      ...(user.domain && { domain: user.domain }),
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
    expiresInMinutes: sessionTimeout,
    // Carried as a claim so it survives into `req.user` on every later request,
    // the way NTLM already carries it. Without this the domain would exist only
    // on the login request and the `domain\\username` subject would degrade
    // back to a bare account name for the rest of the session.
    ...(persistedUser.domain && { additionalClaims: { domain: persistedUser.domain } })
  });

  return {
    user: {
      id: persistedUser.id,
      username: persistedUser.username,
      name: persistedUser.name,
      email: persistedUser.email,
      groups: persistedUser.groups,
      ...(persistedUser.domain && { domain: persistedUser.domain }),
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

  if (!ldapProviderConfig.url || !ldapProviderConfig.userSearchBase) {
    throw new Error('LDAP provider must have url and userSearchBase configured');
  }

  // Resolve the admin bind password from the central credential store
  const adminPassword = credentialService.resolveSecret(ldapProviderConfig.adminPasswordRef);

  // Escape username for safe use in LDAP search filters (RFC 4515)
  const safeUsername = escapeLdapFilterValue(username);

  const options = {
    ldapOpts: {
      url: ldapProviderConfig.url,
      ...(ldapProviderConfig.tlsOptions && { tlsOptions: ldapProviderConfig.tlsOptions }),
      ...(ldapProviderConfig.timeout && { timeout: ldapProviderConfig.timeout }),
      ...(ldapProviderConfig.reconnect && { reconnect: ldapProviderConfig.reconnect })
    },
    adminDn: ldapProviderConfig.adminDn,
    adminPassword,
    userSearchBase: ldapProviderConfig.userSearchBase,
    usernameAttribute: ldapProviderConfig.usernameAttribute || 'uid',
    username: safeUsername,
    verifyUserExists: true,
    ...(ldapProviderConfig.groupSearchBase && {
      groupsSearchBase: ldapProviderConfig.groupSearchBase,
      groupClass: ldapProviderConfig.groupClass || 'groupOfNames',
      groupMemberAttribute: ldapProviderConfig.groupMemberAttribute || 'member',
      groupMemberUserAttribute: ldapProviderConfig.groupMemberUserAttribute || 'dn'
    })
  };

  logger.info('LDAP Group Lookup: searching groups for user', {
    component: 'LdapGroupLookup',
    username,
    url: ldapProviderConfig.url,
    groupSearchBase: ldapProviderConfig.groupSearchBase || 'NOT CONFIGURED'
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
