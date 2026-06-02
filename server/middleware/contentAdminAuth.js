import { loadGroupsConfiguration } from '../utils/authorization.js';
import logger from '../utils/logger.js';

/**
 * Content admin authentication middleware
 * Allows access for users with either adminAccess or contentAdmin permissions.
 * Used on apps, prompts, and sources routes.
 */
export function contentAdminAuth(req, res, next) {
  try {
    if (!req.user || req.user.id === 'anonymous') {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'You must be logged in to access this resource.'
      });
    }

    const userGroups = req.user.groups || [];

    try {
      const groupsConfig = loadGroupsConfiguration();
      const hasAccess = userGroups.some(groupName => {
        const group = groupsConfig.groups?.[groupName];
        return (
          group?.permissions?.adminAccess === true || group?.permissions?.contentAdmin === true
        );
      });

      if (hasAccess) {
        return next();
      }
    } catch (error) {
      logger.warn('Failed to load groups configuration for content admin check', {
        component: 'ContentAdminAuth',
        error
      });
      // Fallback to default admin groups
      const defaultAdminGroups = ['admin', 'admins'];
      if (userGroups.some(group => defaultAdminGroups.includes(group))) {
        return next();
      }
    }

    return res.status(403).json({
      error: 'Access denied',
      message: 'Content admin access required.'
    });
  } catch (error) {
    logger.error('Content admin authentication error', { component: 'ContentAdminAuth', error });
    return res.status(500).json({
      error: 'Authentication system error',
      message: 'Internal server error during authentication'
    });
  }
}

/**
 * Check if content admin authentication is required (used by auth status endpoint).
 * Returns true if user lacks both adminAccess and contentAdmin.
 * @param {object} req - Request object
 * @returns {boolean} Whether authentication is still required
 */
export function isContentAdminAuthRequired(req) {
  if (!req || !req.user || req.user.id === 'anonymous') {
    return true;
  }

  const userGroups = req.user.groups || [];

  try {
    const groupsConfig = loadGroupsConfiguration();
    return !userGroups.some(groupName => {
      const group = groupsConfig.groups?.[groupName];
      return group?.permissions?.contentAdmin === true;
    });
  } catch {
    return true;
  }
}
