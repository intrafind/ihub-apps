import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendAuthRequired, sendInsufficientPermissions } from './responseHelpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolve group inheritance by merging permissions from parent groups
 * @param {Object} groupsConfig - Groups configuration object
 * @returns {Object} Groups configuration with resolved inheritance
 */
export function resolveGroupInheritance(groupsConfig) {
  if (!groupsConfig || !groupsConfig.groups) {
    return groupsConfig;
  }

  const groups = { ...groupsConfig.groups };
  const visited = new Set();
  const resolving = new Set();

  function resolveGroup(groupId) {
    // Prevent circular dependencies
    if (resolving.has(groupId)) {
      throw new Error(`Circular dependency detected in group inheritance: ${groupId}`);
    }

    // Skip if already resolved
    if (visited.has(groupId)) {
      return groups[groupId];
    }

    const group = groups[groupId];
    if (!group) {
      throw new Error(`Group not found: ${groupId}`);
    }

    // Mark as currently resolving to detect circular dependencies
    resolving.add(groupId);

    try {
      // If no inheritance, mark as resolved and return
      if (!group.inherits || !Array.isArray(group.inherits) || group.inherits.length === 0) {
        visited.add(groupId);
        resolving.delete(groupId);
        return group;
      }

      // Recursively resolve parent groups first
      const parentGroups = group.inherits.map(parentId => {
        if (!groups[parentId]) {
          throw new Error(`Parent group not found: ${parentId} (referenced by ${groupId})`);
        }
        return resolveGroup(parentId);
      });

      // Merge permissions from parent groups
      const mergedPermissions = {
        apps: new Set(),
        prompts: new Set(),
        models: new Set(),
        adminAccess: false
      };

      // Merge from parent groups first (in order)
      for (const parentGroup of parentGroups) {
        const parentPerms = parentGroup.permissions || {};

        // Merge apps
        if (Array.isArray(parentPerms.apps)) {
          parentPerms.apps.forEach(app => mergedPermissions.apps.add(app));
        }

        // Merge prompts
        if (Array.isArray(parentPerms.prompts)) {
          parentPerms.prompts.forEach(prompt => mergedPermissions.prompts.add(prompt));
        }

        // Merge models
        if (Array.isArray(parentPerms.models)) {
          parentPerms.models.forEach(model => mergedPermissions.models.add(model));
        }

        // Admin access: if any parent has admin access, inherit it
        if (parentPerms.adminAccess === true) {
          mergedPermissions.adminAccess = true;
        }
      }

      // Merge own permissions on top (overrides parents)
      const ownPerms = group.permissions || {};
      if (Array.isArray(ownPerms.apps)) {
        ownPerms.apps.forEach(app => mergedPermissions.apps.add(app));
      }
      if (Array.isArray(ownPerms.prompts)) {
        ownPerms.prompts.forEach(prompt => mergedPermissions.prompts.add(prompt));
      }
      if (Array.isArray(ownPerms.models)) {
        ownPerms.models.forEach(model => mergedPermissions.models.add(model));
      }
      if (ownPerms.adminAccess === true) {
        mergedPermissions.adminAccess = true;
      }

      // Update the group with resolved permissions
      groups[groupId] = {
        ...group,
        permissions: {
          apps: Array.from(mergedPermissions.apps),
          prompts: Array.from(mergedPermissions.prompts),
          models: Array.from(mergedPermissions.models),
          adminAccess: mergedPermissions.adminAccess
        }
      };

      visited.add(groupId);
      resolving.delete(groupId);
      return groups[groupId];
    } catch (error) {
      resolving.delete(groupId);
      throw error;
    }
  }

  // Resolve all groups
  for (const groupId of Object.keys(groups)) {
    try {
      resolveGroup(groupId);
    } catch (error) {
      console.error(`Error resolving group inheritance for ${groupId}:`, error.message);
      throw error;
    }
  }

  return {
    ...groupsConfig,
    groups
  };
}

/**
 * Load unified groups configuration
 * @returns {Object} Groups configuration with permissions and mappings
 */
export function loadGroupsConfiguration() {
  try {
    const configPath = path.join(__dirname, '../../contents/config/groups.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    // Resolve group inheritance
    const resolvedConfig = resolveGroupInheritance(config);

    return resolvedConfig;
  } catch (error) {
    console.warn(
      'Could not load groups configuration, falling back to legacy files:',
      error.message
    );
    throw new Error('Groups configuration not found.', { cause: error });
  }
}

/**
 * Load group permissions configuration (backwards compatibility)
 * @returns {Object} Group permissions configuration
 */
export function loadGroupPermissions() {
  const config = loadGroupsConfiguration();

  // Convert new format to legacy format for backwards compatibility
  const legacyFormat = { groups: {} };
  for (const [groupId, group] of Object.entries(config.groups || {})) {
    legacyFormat.groups[groupId] = {
      apps: group.permissions?.apps || [],
      prompts: group.permissions?.prompts || [],
      models: group.permissions?.models || [],
      adminAccess: group.permissions?.adminAccess || false,
      description: group.description || ''
    };
  }

  return legacyFormat;
}

/**
 * Load group mapping configuration (backwards compatibility)
 * @returns {Object} Group mapping configuration
 */
export function loadGroupMapping() {
  const config = loadGroupsConfiguration();

  // Convert new format to legacy mapping format
  const mapping = {};
  for (const [groupId, group] of Object.entries(config.groups || {})) {
    if (group.mappings && Array.isArray(group.mappings)) {
      for (const externalGroup of group.mappings) {
        if (!mapping[externalGroup]) {
          mapping[externalGroup] = [];
        }
        mapping[externalGroup].push(groupId);
      }
    }
  }

  return mapping;
}

/**
 * Map external groups to internal groups
 * @param {string[]} externalGroups - Groups from external auth provider
 * @returns {string[]} Internal group names
 */
export function mapExternalGroups(externalGroups) {
  if (!Array.isArray(externalGroups)) return ['anonymous'];

  const groupMapping = loadGroupMapping();
  const internalGroups = new Set();

  for (const externalGroup of externalGroups) {
    const mappedGroups = groupMapping[externalGroup];
    if (Array.isArray(mappedGroups)) {
      mappedGroups.forEach(group => internalGroups.add(group));
    }
  }

  // If no groups mapped, assign default anonymous group
  if (internalGroups.size === 0) {
    internalGroups.add('anonymous');
  }

  return Array.from(internalGroups);
}

/**
 * Get permissions for a user based on their groups
 * @param {string[]} userGroups - User's internal group names
 * @param {Object} groupPermissions - Group permissions configuration
 * @returns {Object} User permissions object
 */
export function getPermissionsForUser(userGroups, groupPermissions = null) {
  if (!groupPermissions) {
    groupPermissions = loadGroupPermissions();
  }

  const permissions = {
    apps: new Set(),
    prompts: new Set(),
    models: new Set(),
    adminAccess: false
  };

  if (!Array.isArray(userGroups)) {
    userGroups = ['anonymous'];
  }

  for (const group of userGroups) {
    const groupPerms = groupPermissions.groups[group];
    if (!groupPerms) continue;

    // Handle wildcards and specific permissions for apps
    if (groupPerms.apps?.includes('*')) {
      permissions.apps.add('*');
    } else if (Array.isArray(groupPerms.apps)) {
      groupPerms.apps.forEach(app => permissions.apps.add(app));
    }

    // Handle wildcards and specific permissions for prompts
    if (groupPerms.prompts?.includes('*')) {
      permissions.prompts.add('*');
    } else if (Array.isArray(groupPerms.prompts)) {
      groupPerms.prompts.forEach(prompt => permissions.prompts.add(prompt));
    }

    // Handle wildcards and specific permissions for models
    if (groupPerms.models?.includes('*')) {
      permissions.models.add('*');
    } else if (Array.isArray(groupPerms.models)) {
      groupPerms.models.forEach(model => permissions.models.add(model));
    }

    // Admin access
    if (groupPerms.adminAccess) {
      permissions.adminAccess = true;
    }
  }

  return permissions;
}

/**
 * Filter resources based on user permissions
 * @param {Array} resources - Array of resources to filter
 * @param {Set} allowedResources - Set of allowed resource IDs
 * @param {string} resourceType - Type of resource (apps, models, prompts)
 * @returns {Array} Filtered resources
 */
export function filterResourcesByPermissions(resources, allowedResources) {
  if (!Array.isArray(resources)) return [];

  // If user has wildcard access, return all resources
  if (allowedResources.has('*')) {
    return resources;
  }

  // Filter resources based on allowed IDs
  return resources.filter(resource => {
    const resourceId = resource.id || resource.modelId || resource.name;
    return allowedResources.has(resourceId);
  });
}

/**
 * Check if user has admin access
 * @param {string[]} userGroups - User's internal group names
 * @returns {boolean} True if user has admin access
 */
export function hasAdminAccess(userGroups) {
  if (!Array.isArray(userGroups)) {
    return false;
  }

  try {
    const groupsConfig = loadGroupsConfiguration();
    return userGroups.some(groupName => {
      const group = groupsConfig.groups?.[groupName];
      return group?.permissions?.adminAccess === true;
    });
  } catch (error) {
    console.warn('Failed to load groups configuration for admin check:', error);
    // Fallback to default admin groups if groups config fails
    const defaultAdminGroups = ['admin', 'admins'];
    return userGroups.some(group => defaultAdminGroups.includes(group));
  }
}

/**
 * Check if anonymous access is allowed
 * @param {Object} platform - Platform configuration
 * @returns {boolean} True if anonymous access is allowed
 */
export function isAnonymousAccessAllowed(platform) {
  return platform?.anonymousAuth?.enabled === true;
}

/**
 * Get default groups for anonymous users
 * @param {Object} platform - Platform configuration
 * @returns {string[]} Default group names
 */
export function getDefaultAnonymousGroups(platform) {
  // Support both old defaultGroup and new defaultGroups format
  const anonymousAuth = platform?.anonymousAuth;
  if (!anonymousAuth) return ['anonymous'];

  if (Array.isArray(anonymousAuth.defaultGroups)) {
    return anonymousAuth.defaultGroups;
  }

  // Backward compatibility with defaultGroup
  if (anonymousAuth.defaultGroup) {
    return [anonymousAuth.defaultGroup];
  }

  return ['anonymous'];
}

/**
 * Enhance user object with permissions
 * @param {Object} user - User object from request
 * @param {Object} authConfig - Authorization configuration
 * @param {Object} platform - Platform configuration
 * @returns {Object} Enhanced user object with permissions
 */
export function enhanceUserWithPermissions(user, authConfig, platform) {
  if (!user) {
    // Anonymous user
    const defaultGroups = getDefaultAnonymousGroups(platform);
    user = {
      id: 'anonymous',
      name: 'Anonymous',
      email: null,
      groups: defaultGroups
    };
  }

  // Ensure user has groups array
  if (!Array.isArray(user.groups)) {
    user.groups = getDefaultAnonymousGroups(platform);
  }

  // Map external groups to internal groups if needed
  if (user.externalGroups && Array.isArray(user.externalGroups)) {
    user.groups = mapExternalGroups(user.externalGroups);
  }

  // Get permissions for user
  user.permissions = getPermissionsForUser(user.groups);

  // Check admin access
  user.isAdmin = hasAdminAccess(user.groups, authConfig) || user.permissions.adminAccess;

  return user;
}

/**
 * Create authorization middleware
 * @param {Object} options - Middleware options
 * @returns {Function} Express middleware function
 */
export function createAuthorizationMiddleware(options = {}) {
  const { requireAuth = false, requireAdmin = false, allowedGroups = [] } = options;

  return (req, res, next) => {
    const authConfig = req.app.get('authConfig') || {};
    const platform = req.app.get('platform') || {};

    // Enhance user with permissions if not already done
    if (req.user && !req.user.permissions) {
      req.user = enhanceUserWithPermissions(req.user, authConfig, platform);
    }

    // Check if authentication is required
    if (requireAuth && (!req.user || req.user.id === 'anonymous')) {
      if (!isAnonymousAccessAllowed(platform)) {
        return sendAuthRequired(res);
      }
    }

    // Check admin access
    if (requireAdmin && !req.user?.isAdmin) {
      return sendInsufficientPermissions(res, 'Admin access');
    }

    // Check group-based access
    if (allowedGroups.length > 0 && req.user?.groups) {
      const hasAllowedGroup = req.user.groups.some(group => allowedGroups.includes(group));
      if (!hasAllowedGroup) {
        return sendInsufficientPermissions(res);
      }
    }

    next();
  };
}

/**
 * Utility to check if user can access a specific resource
 * @param {Object} user - User object with permissions
 * @param {string} resourceType - Type of resource (apps, models, prompts)
 * @param {string} resourceId - ID of the resource
 * @returns {boolean} True if user can access the resource
 */
export function canUserAccessResource(user, resourceType, resourceId) {
  if (!user?.permissions) return false;

  const allowedResources = user.permissions[resourceType];
  if (!allowedResources) return false;

  return allowedResources.has('*') || allowedResources.has(resourceId);
}

/**
 * Add authenticated group to user groups
 * @param {string[]} userGroups - Current user groups
 * @param {Object} authConfig - Authentication configuration
 * @returns {string[]} User groups with authenticated group added
 */
export function addAuthenticatedGroup(userGroups, authConfig) {
  if (!Array.isArray(userGroups)) {
    userGroups = [];
  }

  const authenticatedGroup = authConfig?.authenticatedGroup || 'authenticated';

  // Add authenticated group if not already present
  if (!userGroups.includes(authenticatedGroup)) {
    userGroups.push(authenticatedGroup);
  }

  return userGroups;
}

/**
 * Add provider-specific default groups to user groups
 * @param {string[]} userGroups - Current user groups
 * @param {string} providerName - Name of the authentication provider
 * @param {Object} providerConfig - Provider configuration
 * @returns {string[]} User groups with provider groups added
 */
export function addProviderGroups(userGroups, providerName, providerConfig) {
  if (!Array.isArray(userGroups)) {
    userGroups = [];
  }

  // Add provider-specific default groups
  if (providerConfig?.defaultGroups && Array.isArray(providerConfig.defaultGroups)) {
    for (const group of providerConfig.defaultGroups) {
      if (!userGroups.includes(group)) {
        userGroups.push(group);
      }
    }
  }

  return userGroups;
}

/**
 * Enhance user groups with authentication and provider-specific groups
 * @param {Object} user - User object
 * @param {Object} authConfig - Authentication configuration
 * @param {Object} providerConfig - Provider configuration (optional)
 * @returns {Object} User object with enhanced groups
 */
export function enhanceUserGroups(user, authConfig, providerConfig = null) {
  if (!user || user.id === 'anonymous') {
    return user; // Don't modify anonymous users
  }

  // Start with existing groups or empty array
  let groups = Array.isArray(user.groups) ? [...user.groups] : [];

  // Add authenticated group to all logged-in users
  groups = addAuthenticatedGroup(groups, authConfig);

  // Add provider-specific groups if provider config is provided
  if (providerConfig && user.provider) {
    groups = addProviderGroups(groups, user.provider, providerConfig);
  }

  // Update user groups
  user.groups = groups;

  return user;
}

/**
 * Get authenticated group name from configuration
 * @param {Object} authConfig - Authentication configuration
 * @returns {string} Authenticated group name
 */
export function getAuthenticatedGroup(authConfig) {
  return authConfig?.authenticatedGroup || 'authenticated';
}
