import { loadGroupsConfiguration } from './authorization.js';
import { loadUsers, saveUsers } from './userManager.js';
import configCache from '../configCache.js';
import logger from './logger.js';

/**
 * Check if there is at least one admin user across all enabled authentication methods
 * @param {string} usersFilePath - Path to users.json file
 * @returns {boolean} True if at least one admin exists
 */
export function hasAnyAdmin(usersFilePath = 'contents/config/users.json') {
  try {
    const platform = configCache.getPlatform() || {};
    const groupsConfig = loadGroupsConfiguration();

    // Check persisted users (local, OIDC, proxy auth users)
    const usersConfig = loadUsers(usersFilePath);
    const users = usersConfig.users || {};

    // For each user, check if they:
    // 1. Are active
    // 2. Have admin access through their groups
    for (const userId in users) {
      const user = users[userId];

      // Skip inactive users
      if (user.active === false) {
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
          `[AdminRescue] Found admin user in persisted users: ${user.username} (${userId})`
        );
        return true;
      }
    }

    // Check if LDAP is enabled and has admin group mappings
    // LDAP users are not persisted, so we check if any LDAP groups map to admin groups
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
              `[AdminRescue] Found admin in LDAP provider default groups: ${ldapProvider.name}`
            );
            return true;
          }
        }
      }

      // Check if any external LDAP groups map to admin groups
      for (const [groupId, group] of Object.entries(groupsConfig.groups || {})) {
        if (group.permissions?.adminAccess === true && group.mappings?.length > 0) {
          logger.debug(
            `[AdminRescue] Found admin group mapping for LDAP: ${groupId} with mappings ${group.mappings.join(', ')}`
          );
          // If there are admin group mappings, we assume LDAP users can be admins
          return true;
        }
      }
    }

    // Check if NTLM is enabled and has admin group mappings
    if (platform.ntlmAuth?.enabled) {
      // Check if NTLM has default groups that include admin
      if (platform.ntlmAuth.defaultGroups?.length > 0) {
        const hasAdminGroup = platform.ntlmAuth.defaultGroups.some(groupName => {
          const group = groupsConfig.groups?.[groupName];
          return group?.permissions?.adminAccess === true;
        });

        if (hasAdminGroup) {
          logger.debug('[AdminRescue] Found admin in NTLM default groups');
          return true;
        }
      }

      // Check if any external NTLM groups map to admin groups
      for (const [groupId, group] of Object.entries(groupsConfig.groups || {})) {
        if (group.permissions?.adminAccess === true && group.mappings?.length > 0) {
          logger.debug(
            `[AdminRescue] Found admin group mapping for NTLM: ${groupId} with mappings ${group.mappings.join(', ')}`
          );
          // If there are admin group mappings, we assume NTLM users can be admins
          return true;
        }
      }
    }

    logger.debug('[AdminRescue] No admin found in any authentication method');
    return false;
  } catch (error) {
    logger.error('[AdminRescue] Error checking for admin:', error);
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
      logger.error(`[AdminRescue] User not found: ${userId}`);
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
      logger.debug(`[AdminRescue] User ${user.username} (${userId}) already has admin access`);
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
      logger.error('[AdminRescue] No admin group found in groups configuration');
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

    // Skip for LDAP and NTLM users (they don't get persisted, admin rights via group mapping)
    if (authMode === 'ldap' || authMode === 'ntlm') {
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
