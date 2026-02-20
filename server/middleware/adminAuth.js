import configCache from '../configCache.js';
import { loadGroupsConfiguration } from '../utils/authorization.js';
import logger from '../utils/logger.js';

/**
 * Admin authentication middleware
 * Enforces secure admin access based on user group permissions:
 * - Only authenticated users with admin groups (adminAccess: true) can access admin
 */
export function adminAuth(req, res, next) {
  try {
    // Check if user has admin privileges
    const authRequired = isAdminAuthRequired(req);

    if (!authRequired) {
      // User is authenticated with admin permissions
      return next();
    }

    // User is not authenticated or does not have admin privileges
    return res.status(403).json({
      error: 'Access denied',
      message: 'Admin access requires authentication with admin privileges.'
    });
  } catch (error) {
    logger.error('Admin authentication error:', error);
    return res.status(500).json({
      error: 'Authentication system error',
      message: 'Internal server error during authentication'
    });
  }
}

/**
 * Check if admin authentication is required
 * @param {object} req - Request object (optional, for checking user auth)
 * @returns {boolean} - Whether admin authentication is required
 */
export function isAdminAuthRequired(req = null) {
  // Check if authenticated user has admin privileges
  if (req && req.user && req.user.id !== 'anonymous') {
    const userGroups = req.user.groups || [];

    try {
      const groupsConfig = loadGroupsConfiguration();
      const hasAdminAccess = userGroups.some(groupName => {
        const group = groupsConfig.groups?.[groupName];
        return group?.permissions?.adminAccess === true;
      });

      if (hasAdminAccess) {
        return false; // Allow access for authenticated admin users
      }
    } catch (error) {
      logger.warn('Failed to load groups configuration for admin check:', error);
      // Fallback to default admin groups if groups config fails
      const defaultAdminGroups = ['admin', 'admins'];
      const isAdmin = userGroups.some(group => defaultAdminGroups.includes(group));
      if (isAdmin) {
        return false; // Allow access for authenticated admin users
      }
    }
  }

  // User is not authenticated or does not have admin privileges
  return true;
}
