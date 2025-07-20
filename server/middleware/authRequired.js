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
  const platformConfig = req.app.get('platform') || {};

  // If anonymous access is allowed, proceed regardless of authentication
  if (isAnonymousAccessAllowed(platformConfig)) {
    return next();
  }

  // Anonymous access is disabled - require authentication
  if (!req.user || req.user.id === 'anonymous') {
    return res.status(401).json({
      error: 'Authentication required',
      code: 'AUTH_REQUIRED',
      message: 'You must be logged in to access this resource'
    });
  }

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
 * Middleware to check if user has permission to access a specific app
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export function appAccessRequired(req, res, next) {
  const { appId } = req.params;

  // If user is authenticated, check app permissions
  if (req.user && req.user.permissions) {
    const allowedApps = req.user.permissions.apps || new Set();

    // Check if user has wildcard access or specific app access
    if (!allowedApps.has('*') && !allowedApps.has(appId)) {
      return res.status(403).json({
        error: 'Access denied',
        code: 'APP_ACCESS_DENIED',
        message: `You do not have permission to access app: ${appId}`
      });
    }
  }

  next();
}

/**
 * Middleware to check if user has permission to access a specific model
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export function modelAccessRequired(req, res, next) {
  const { modelId } = req.params;

  // If user is authenticated, check model permissions
  if (req.user && req.user.permissions) {
    const allowedModels = req.user.permissions.models || new Set();

    // Check if user has wildcard access or specific model access
    if (!allowedModels.has('*') && !allowedModels.has(modelId)) {
      return res.status(403).json({
        error: 'Access denied',
        code: 'MODEL_ACCESS_DENIED',
        message: `You do not have permission to access model: ${modelId}`
      });
    }
  }

  next();
}

/**
 * Combined middleware for chat endpoints that enforces authentication and app access
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export function chatAuthRequired(req, res, next) {
  // First check if authentication is required
  authRequired(req, res, err => {
    if (err) return next(err);

    // Then check app access permissions if user is authenticated
    if (req.user && req.user.id !== 'anonymous') {
      return appAccessRequired(req, res, next);
    }

    next();
  });
}
