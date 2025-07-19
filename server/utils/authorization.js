import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Load group permissions configuration
 * @returns {Object} Group permissions configuration
 */
export function loadGroupPermissions() {
  try {
    const configPath = path.join(__dirname, '../../contents/config/groupPermissions.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config;
  } catch (error) {
    console.warn('Could not load group permissions configuration:', error.message);
    return { groups: {} };
  }
}

/**
 * Load group mapping configuration
 * @returns {Object} Group mapping configuration
 */
export function loadGroupMapping() {
  try {
    const configPath = path.join(__dirname, '../../contents/config/groupMap.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config;
  } catch (error) {
    console.warn('Could not load group mapping configuration:', error.message);
    return {};
  }
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
export function filterResourcesByPermissions(resources, allowedResources, resourceType = 'apps') {
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
 * @param {Object} authConfig - Authorization configuration
 * @returns {boolean} True if user has admin access
 */
export function hasAdminAccess(userGroups, authConfig) {
  if (!Array.isArray(userGroups) || !authConfig?.adminGroups) {
    return false;
  }
  
  return userGroups.some(group => authConfig.adminGroups.includes(group));
}

/**
 * Check if anonymous access is allowed
 * @param {Object} authConfig - Authorization configuration
 * @returns {boolean} True if anonymous access is allowed
 */
export function isAnonymousAccessAllowed(authConfig) {
  return authConfig?.anonymousAccess === true;
}

/**
 * Get default group for anonymous users
 * @param {Object} authConfig - Authorization configuration
 * @returns {string} Default group name
 */
export function getDefaultAnonymousGroup(authConfig) {
  return authConfig?.defaultGroup || 'anonymous';
}

/**
 * Enhance user object with permissions
 * @param {Object} user - User object from request
 * @param {Object} authConfig - Authorization configuration
 * @returns {Object} Enhanced user object with permissions
 */
export function enhanceUserWithPermissions(user, authConfig) {
  if (!user) {
    // Anonymous user
    const defaultGroup = getDefaultAnonymousGroup(authConfig);
    user = {
      id: 'anonymous',
      name: 'Anonymous',
      email: null,
      groups: [defaultGroup]
    };
  }
  
  // Ensure user has groups array
  if (!Array.isArray(user.groups)) {
    user.groups = [getDefaultAnonymousGroup(authConfig)];
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
    
    // Enhance user with permissions if not already done
    if (req.user && !req.user.permissions) {
      req.user = enhanceUserWithPermissions(req.user, authConfig);
    }
    
    // Check if authentication is required
    if (requireAuth && (!req.user || req.user.id === 'anonymous')) {
      if (!isAnonymousAccessAllowed(authConfig)) {
        return res.status(401).json({ error: 'Authentication required' });
      }
    }
    
    // Check admin access
    if (requireAdmin && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    // Check group-based access
    if (allowedGroups.length > 0 && req.user?.groups) {
      const hasAllowedGroup = req.user.groups.some(group => allowedGroups.includes(group));
      if (!hasAllowedGroup) {
        return res.status(403).json({ error: 'Insufficient permissions' });
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