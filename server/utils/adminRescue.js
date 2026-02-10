import { loadGroupsConfiguration } from './authorization.js';
import { loadUsers, saveUsers } from './userManager.js';
import configCache from '../configCache.js';
import logger from './logger.js';

/**
 * Check if a user's authentication method is enabled in platform config
 * @param {Object} user - User object
 * @param {Object} platform - Platform configuration
 * @returns {boolean} True if user can login with at least one enabled auth method
 */
function isUserAuthMethodEnabled(user, platform) {
  const authMethods = user.authMethods || [];

  // If user has no authMethods array, they are a legacy local user
  if (authMethods.length === 0) {
    // Check if they have a passwordHash (local user)
    if (user.passwordHash) {
      return platform.localAuth?.enabled === true;
    }
    // Unknown auth method, assume enabled to be safe
    return true;
  }

  // Check if ANY of the user's auth methods is enabled
  return authMethods.some(method => {
    switch (method) {
      case 'local':
        return platform.localAuth?.enabled === true;
      case 'oidc':
        return platform.oidcAuth?.enabled === true;
      case 'proxy':
        return platform.proxyAuth?.enabled === true;
      case 'ntlm':
        return platform.ntlmAuth?.enabled === true;
      case 'ldap':
        return platform.ldapAuth?.enabled === true;
      case 'teams':
        return platform.teamsAuth?.enabled === true;
      default:
        // Unknown auth method, assume enabled to be safe
        return true;
    }
  });
}

/**
 * Check if there is at least one admin user across all enabled authentication methods
 * @param {string} usersFilePath - Path to users.json file
 * @returns {boolean} True if at least one admin exists who can actually login
 */
export function hasAnyAdmin(usersFilePath = 'contents/config/users.json') {
  try {
    const platform = configCache.getPlatform() || {};
    const groupsConfig = loadGroupsConfiguration();

    // Check persisted users (local, OIDC, proxy, NTLM auth users)
    const usersConfig = loadUsers(usersFilePath);
    const users = usersConfig.users || {};

    // For each user, check if they:
    // 1. Are active
    // 2. Have an enabled authentication method (can actually login)
    // 3. Have admin access through their groups
    for (const userId in users) {
      const user = users[userId];

      // Skip inactive users
      if (user.active === false) {
        continue;
      }

      // Skip users whose authentication method is disabled (they can't login)
      if (!isUserAuthMethodEnabled(user, platform)) {
        logger.debug(
          `[AdminRescue] Skipping user ${user.username} (${userId}) - auth method disabled`,
          { component: 'Utils' }
        );
        continue;
      }

      // Check if user has admin access through their internal groups
      const userGroups = user.internalGroups || [];
      const userHasAdminAccess = userGroups.some(groupName => {
        const group = groupsConfig.groups?.[groupName];
        return group?.permissions?.adminAccess === true;
      });

      if (userHasAdminAccess) {
        logger.debug(
          `[AdminRescue] Found admin user in persisted users: ${user.username} (${userId})`,
          { component: 'Utils' }
        );
        return true;
      }
    }

    // Check if LDAP is enabled and has default admin groups
    // LDAP users are not persisted, so we only check if LDAP default groups include admin
    // Note: We do NOT check hasAdminGroupMappings here because that would block the rescue
    // mechanism even when no actual LDAP user has the mapped external groups
    if (platform.ldapAuth?.enabled && platform.ldapAuth?.providers?.length > 0) {
      for (const ldapProvider of platform.ldapAuth.providers) {
        // Check if LDAP provider has default groups that include admin
        if (ldapProvider.defaultGroups?.length > 0) {
          const hasAdminGroup = ldapProvider.defaultGroups.some(groupName => {
            const group = groupsConfig.groups?.[groupName];
            return group?.permissions?.adminAccess === true;
          });

          if (hasAdminGroup) {
            logger.debug(
              `[AdminRescue] Found admin in LDAP provider default groups: ${ldapProvider.name}`,
              { component: 'Utils' }
            );
            return true;
          }
        }
      }
    }

    // Check if NTLM is enabled and has default admin groups
    // Note: We do NOT check hasAdminGroupMappings here because that would block the rescue
    // mechanism even when no actual NTLM user has the mapped external groups
    if (platform.ntlmAuth?.enabled) {
      // Check if NTLM has default groups that include admin
      if (platform.ntlmAuth.defaultGroups?.length > 0) {
        const hasAdminGroup = platform.ntlmAuth.defaultGroups.some(groupName => {
          const group = groupsConfig.groups?.[groupName];
          return group?.permissions?.adminAccess === true;
        });

        if (hasAdminGroup) {
          logger.debug('[AdminRescue] Found admin in NTLM default groups', { component: 'Utils' });
          return true;
        }
      }
    }

    logger.debug('[AdminRescue] No admin found in any authentication method', {
      component: 'Utils'
    });
    return false;
  } catch (error) {
    logger.error('[AdminRescue] Error checking for admin:', { component: 'Utils', error });
    // In case of error, assume there's an admin to avoid unintended changes
    return true;
  }
}

/**
 * Assign admin group to a user
 * @param {string} userId - User ID to make admin
 * @param {string} usersFilePath - Path to users.json file
 * @returns {Promise<boolean>} True if admin group was assigned
 */
export async function assignAdminGroup(userId, usersFilePath = 'contents/config/users.json') {
  try {
    const usersConfig = loadUsers(usersFilePath);
    const users = usersConfig.users || {};

    if (!users[userId]) {
      logger.error(`[AdminRescue] User not found: ${userId}`, { component: 'Utils' });
      return false;
    }

    const user = users[userId];

    // Initialize internalGroups if it doesn't exist
    if (!user.internalGroups) {
      user.internalGroups = [];
    }

    // Check if user already has an admin group
    const groupsConfig = loadGroupsConfiguration();
    const hasAdminGroup = user.internalGroups.some(groupName => {
      const group = groupsConfig.groups?.[groupName];
      return group?.permissions?.adminAccess === true;
    });

    if (hasAdminGroup) {
      logger.debug(`[AdminRescue] User ${user.username} (${userId}) already has admin access`, {
        component: 'Utils'
      });
      return false;
    }

    // Find an admin group to assign (prefer 'admins' or 'admin')
    const adminGroupId =
      groupsConfig.groups?.admins?.id ||
      groupsConfig.groups?.admin?.id ||
      Object.keys(groupsConfig.groups || {}).find(groupId => {
        return groupsConfig.groups[groupId]?.permissions?.adminAccess === true;
      });

    if (!adminGroupId) {
      logger.error('[AdminRescue] No admin group found in groups configuration', {
        component: 'Utils'
      });
      return false;
    }

    // Add admin group to user's internal groups
    user.internalGroups.push(adminGroupId);
    user.updatedAt = new Date().toISOString();

    // Save users configuration
    await saveUsers(usersConfig, usersFilePath);

    logger.info(
      `✅ [AdminRescue] Assigned admin group '${adminGroupId}' to user ${user.username} (${userId})`
    );
    return true;
  } catch (error) {
    logger.error(`[AdminRescue] Error assigning admin group to user ${userId}:`, error);
    return false;
  }
}

/**
 * Ensure first user gets admin rights if no admin exists
 * This is called after user authentication/creation
 * @param {Object} user - User object
 * @param {string} authMode - Authentication mode
 * @param {string} usersFilePath - Path to users.json file
 * @returns {Promise<Object>} User object (potentially with admin group added)
 */
export async function ensureFirstUserIsAdmin(
  user,
  authMode,
  usersFilePath = 'contents/config/users.json'
) {
  try {
    // Skip for anonymous users
    if (!user || user.id === 'anonymous') {
      return user;
    }

    // Skip if anonymous mode (admin access via admin secret)
    if (authMode === 'anonymous') {
      return user;
    }

    // Skip for LDAP users (they don't get persisted, admin rights via group mapping only)
    // Note: NTLM users ARE persisted since PR #867, so they can receive admin rights
    if (authMode === 'ldap') {
      return user;
    }

    // Check if there's already an admin across all auth methods
    const hasAdmin = hasAnyAdmin(usersFilePath);

    if (hasAdmin) {
      logger.debug(`[AdminRescue] Admin exists in system, no action needed for user ${user.id}`);
      return user;
    }

    // No admin exists in the system, make this user an admin
    logger.warn(
      `⚠️ [AdminRescue] No admin found in system. Assigning admin rights to first user: ${user.username || user.name || user.id}`
    );

    const assigned = await assignAdminGroup(user.id, usersFilePath);

    if (assigned) {
      // Reload user to get updated groups
      const usersConfig = loadUsers(usersFilePath);
      const updatedUser = usersConfig.users[user.id];

      if (updatedUser) {
        // Merge updated internal groups into the user object
        user.internalGroups = updatedUser.internalGroups;

        // Update groups array if it exists
        if (user.groups) {
          // Add admin group to groups array
          const groupsConfig = loadGroupsConfiguration();
          const adminGroupId = updatedUser.internalGroups.find(groupName => {
            const group = groupsConfig.groups?.[groupName];
            return group?.permissions?.adminAccess === true;
          });

          if (adminGroupId && !user.groups.includes(adminGroupId)) {
            user.groups.push(adminGroupId);
          }
        }
      }
    }

    return user;
  } catch (error) {
    logger.error(`[AdminRescue] Error ensuring first user is admin:`, error);
    return user;
  }
}

/**
 * Check if a user is the last admin
 * @param {string} userId - User ID to check
 * @param {string} usersFilePath - Path to users.json file
 * @returns {boolean} True if user is the last admin
 */
export function isLastAdmin(userId, usersFilePath = 'contents/config/users.json') {
  try {
    const usersConfig = loadUsers(usersFilePath);
    const users = usersConfig.users || {};
    const groupsConfig = loadGroupsConfiguration();

    let adminCount = 0;
    let isUserAdmin = false;

    for (const uid in users) {
      const user = users[uid];

      // Skip inactive users
      if (user.active === false) {
        continue;
      }

      // Check if user has admin access through their internal groups
      const userGroups = user.internalGroups || [];
      const hasAdmin = userGroups.some(groupName => {
        const group = groupsConfig.groups?.[groupName];
        return group?.permissions?.adminAccess === true;
      });

      if (hasAdmin) {
        adminCount++;
        if (uid === userId) {
          isUserAdmin = true;
        }
      }
    }

    // User is the last admin if:
    // 1. They are an admin
    // 2. There's only one admin total
    const result = isUserAdmin && adminCount === 1;

    if (result) {
      logger.debug(`[AdminRescue] User ${userId} is the last admin (total admins: ${adminCount})`);
    }

    return result;
  } catch (error) {
    logger.error(`[AdminRescue] Error checking if user is last admin:`, error);
    // In case of error, assume user is NOT the last admin to allow deletion
    // This is safer than blocking all deletions
    return false;
  }
}
