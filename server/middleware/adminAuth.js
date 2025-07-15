import configCache from '../configCache.js';

/**
 * Admin authentication middleware
 * Checks for admin secret in platform config and validates Bearer token
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
    if (token !== adminSecret) {
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
 * Check if admin authentication is required
 */
export function isAdminAuthRequired() {
  const platform = configCache.getPlatform();
  const adminSecret = process.env.ADMIN_SECRET || platform?.admin?.secret;
  return !!adminSecret;
}
