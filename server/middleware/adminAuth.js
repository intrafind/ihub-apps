import configCache from '../configCache.js';
import bcrypt from 'bcryptjs';
import { loadGroupsConfiguration } from '../utils/authorization.js';
import logger from '../utils/logger.js';

/**
 * Admin authentication middleware
 * Enforces secure admin access based on authentication mode:
 * - Anonymous mode: Admin secret required
 * - Local/OIDC/Proxy modes: Only authenticated users with admin groups allowed
 */
export function adminAuth(req, res, next) {
  try {
    const platform = configCache.getPlatform();
    const auth = platform?.auth || {};
    const authMode = auth.mode || 'anonymous';

    // First check if admin authentication is even required
    // This checks if user is already authenticated with admin permissions
    const authRequired = isAdminAuthRequired(req);

    if (!authRequired) {
      // User is already authenticated with admin permissions
      return next();
    }

    // Admin authentication is required

    if (authMode === 'anonymous') {
      // In anonymous mode, admin secret authentication is allowed
      const adminSecret = process.env.ADMIN_SECRET || platform?.admin?.secret;

      if (!adminSecret) {
        return res.status(401).json({
          error: 'Admin authentication required',
          message: 'Admin secret not configured'
        });
      }

      // Check for Authorization header
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
          error: 'Admin authentication required',
          message: 'Missing admin secret'
        });
      }

      // Extract token from header
      const token = authHeader.slice(7); // Remove 'Bearer ' prefix

      // Verify token matches admin secret
      const isValidToken = verifyAdminToken(token, adminSecret, platform?.admin?.encrypted);

      if (!isValidToken) {
        return res.status(403).json({
          error: 'Invalid admin credentials',
          message: 'Invalid admin secret'
        });
      }

      // Authentication successful
      return next();
    } else {
      // In local/OIDC/proxy modes, admin secret is NOT allowed
      // Only authenticated users with admin groups can access admin
      return res.status(403).json({
        error: 'Access denied',
        message: `Admin access in ${authMode} mode requires authentication with admin privileges. Admin secret is only available in anonymous mode.`
      });
    }
  } catch (error) {
    logger.error('Admin authentication error:', error);
    return res.status(500).json({
      error: 'Authentication system error',
      message: 'Internal server error during authentication'
    });
  }
}

/**
 * Verify admin token against stored secret
 * @param {string} token - Token from request
 * @param {string} adminSecret - Stored admin secret
 * @param {boolean} isEncrypted - Whether the stored secret is encrypted
 * @returns {boolean} - Whether the token is valid
 */
function verifyAdminToken(token, adminSecret, isEncrypted = false) {
  if (isEncrypted) {
    // For encrypted passwords, compare bcrypt hash
    return bcrypt.compareSync(token, adminSecret);
  } else {
    // For plain text passwords, direct comparison
    return token === adminSecret;
  }
}

/**
 * Hash a password using bcrypt
 * @param {string} password - Plain text password
 * @returns {string} - Hashed password
 */
export function hashPassword(password) {
  const saltRounds = 10;
  return bcrypt.hashSync(password, saltRounds);
}

/**
 * Check if admin authentication is required
 * @param {object} req - Request object (optional, for checking user auth)
 * @returns {boolean} - Whether admin authentication is required
 */
export function isAdminAuthRequired(req = null) {
  const platform = configCache.getPlatform();
  const auth = platform?.auth || {};
  const authMode = auth.mode || 'anonymous';

  // SECURITY MODEL:
  // - Anonymous mode: Admin secret is the only way to access admin
  // - Local/OIDC/Proxy modes: Only authenticated users with admin groups can access admin

  if (authMode === 'anonymous') {
    // In anonymous mode, admin secret is always required
    return true;
  }

  // In local/OIDC/proxy modes, only user groups determine admin access
  if (req && req.user && req.user.id !== 'anonymous') {
    // Check if authenticated user has admin privileges
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

  // In non-anonymous modes, if user is not authenticated or not admin, deny access
  // Admin secret will not work in these modes
  return true;
}
