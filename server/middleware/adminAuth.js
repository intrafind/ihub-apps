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
 */
export function isAdminAuthRequired() {
  const platform = configCache.getPlatform();
  const adminSecret = process.env.ADMIN_SECRET || platform?.admin?.secret;
  return !!adminSecret;
}
