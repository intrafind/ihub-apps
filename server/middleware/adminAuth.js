import configCache from '../configCache.js';
import bcrypt from 'bcrypt';

/**
 * Admin authentication middleware
 * Checks for admin secret in platform config and validates Bearer token
 * Supports both encrypted (bcrypt) and plain text passwords
 */
export function adminAuth(req, res, next) {
  try {
    // Get admin secret from platform config
    const platform = configCache.getPlatform();

    // Check if admin secret is configured (either in config or ENV)
    const adminSecret = process.env.ADMIN_SECRET || platform?.admin?.secret;

    // If no admin secret is configured, allow access (backward compatibility)
    if (!adminSecret) {
      return next();
    }

    // Check for Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Admin authentication required',
        message: 'Missing or invalid authorization header'
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
    next();
  } catch (error) {
    console.error('Admin authentication error:', error);
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
 */
export function isAdminAuthRequired(req = null) {
  const platform = configCache.getPlatform();
  const adminSecret = process.env.ADMIN_SECRET || platform?.admin?.secret;
  
  // If no admin secret is configured, no auth required
  if (!adminSecret) {
    return false;
  }
  
  // Check if regular authentication is enabled and user is authenticated
  const auth = platform?.auth || {};
  const authMode = auth.mode || 'anonymous';
  
  // If auth mode is not anonymous and user is authenticated via regular auth,
  // skip admin password requirement
  if (authMode !== 'anonymous' && req && req.user && req.user.id !== 'anonymous') {
    // Check if user has admin privileges
    const userGroups = req.user.groups || [];
    const adminGroups = platform?.authorization?.adminGroups || ['admin', 'IT-Admin', 'Platform-Admin'];
    
    const isAdmin = userGroups.some(group => adminGroups.includes(group));
    if (isAdmin) {
      return false; // Skip admin auth for authenticated admin users
    }
  }
  
  return true; // Require admin auth
}
