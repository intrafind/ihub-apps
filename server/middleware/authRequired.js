/**
 * Authentication middleware to enforce authentication when required
 */
import { isAnonymousAccessAllowed } from '../utils/authorization.js';

/**
 * Middleware that requires authentication when anonymousAuth is disabled
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export function authRequired(req, res, next) {
  console.log('🔐 authRequired: Called for URL:', req.url, req.method);
  const platformConfig = req.app.get('platform') || {};

  // If anonymous access is allowed, proceed regardless of authentication
  if (isAnonymousAccessAllowed(platformConfig)) {
    console.log('🔐 authRequired: Anonymous access allowed, proceeding');
    return next();
  }

  // Add debugging
  console.log('🔐 authRequired: Anonymous access disabled, checking authentication');
  console.log('🔐 authRequired: req.user:', req.user);
  console.log('🔐 authRequired: Authorization header:', req.headers.authorization);

  // Anonymous access is disabled - require authentication
  if (!req.user || req.user.id === 'anonymous') {
    console.log('🔐 authRequired: Authentication failed - no valid user');
    return res.status(401).json({
      error: 'Authentication required',
      code: 'AUTH_REQUIRED',
      message: 'You must be logged in to access this resource'
    });
  }

  console.log('🔐 authRequired: Authentication successful for user:', req.user.id);
  next();
}

/**
 * Middleware that allows conditional authentication - always proceeds but with limited access for anonymous
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export function authOptional(req, res, next) {
  // Always proceed - the route handler will decide what to show based on req.user
  next();
}

/**
 * Higher-order function to create resource access middleware
 * Consolidates the identical logic from appAccessRequired and modelAccessRequired
 * @param {string} resourceType - The resource type (e.g., 'app', 'model')
 * @returns {Function} Express middleware function
 */
function resourceAccessRequired(resourceType) {
  return function (req, res, next) {
    const resourceId = req.params[`${resourceType}Id`]; // e.g., req.params.appId
    const permissionsKey = `${resourceType}s`; // e.g., 'apps'

    // If user is authenticated, check resource permissions
    if (req.user && req.user.permissions) {
      const allowedResources = req.user.permissions[permissionsKey] || new Set();

      // Check if user has wildcard access or specific resource access
      if (!allowedResources.has('*') && !allowedResources.has(resourceId)) {
        return res.status(403).json({
          error: 'Access denied',
          code: `${resourceType.toUpperCase()}_ACCESS_DENIED`,
          message: `You do not have permission to access ${resourceType}: ${resourceId}`
        });
      }
    }

    next();
  };
}

/**
 * Middleware to check if user has permission to access a specific app
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export const appAccessRequired = resourceAccessRequired('app');

/**
 * Middleware to check if user has permission to access a specific model
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export const modelAccessRequired = resourceAccessRequired('model');

/**
 * Combined middleware for chat endpoints that enforces authentication and app access
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export function chatAuthRequired(req, res, next) {
  console.log('🔐 chatAuthRequired: Called for URL:', req.url, req.method);

  // First check if authentication is required
  authRequired(req, res, err => {
    if (err) return next(err);

    // Then check app access permissions if user is authenticated
    if (req.user && req.user.id !== 'anonymous') {
      console.log('🔐 chatAuthRequired: User authenticated, checking app access');
      return appAccessRequired(req, res, next);
    }

    console.log('🔐 chatAuthRequired: Proceeding without app access check');
    next();
  });
}
