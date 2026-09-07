/**
 * Authentication middleware to enforce authentication when required
 */
import { isAnonymousAccessAllowed, enhanceUserWithPermissions } from '../utils/authorization.js';
import authDebugService from '../utils/authDebugService.js';
import configCache from '../configCache.js';

/**
 * Middleware that requires authentication when anonymousAuth is disabled
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export function authRequired(req, res, next) {
  // Initial auth check logging
  authDebugService.log('auth-required', 'debug', 'Authentication middleware called', {
    url: req.url,
    method: req.method
  });
  const platformConfig = configCache.getPlatform() || {};

  // If anonymous access is allowed, proceed regardless of authentication
  if (isAnonymousAccessAllowed(platformConfig)) {
    authDebugService.log(
      'auth-required',
      'info',
      'Anonymous access allowed - proceeding without authentication check',
      { url: req.url, method: req.method }
    );
    return next();
  }

  // Log authentication check with proper token masking
  authDebugService.log(
    'auth-required',
    'info',
    'Authentication check - anonymous access disabled',
    {
      url: req.url,
      method: req.method,
      hasUser: !!req.user,
      userId: req.user?.id,
      userName: req.user?.name,
      userGroups: req.user?.groups,
      authHeader: req.headers.authorization,
      userAgent: req.headers['user-agent']
    }
  );

  // Anonymous access is disabled - require authentication
  if (!req.user || req.user.id === 'anonymous') {
    authDebugService.log('auth-required', 'warn', 'Authentication failed - no valid user found', {
      url: req.url,
      method: req.method,
      hasUser: !!req.user,
      userId: req.user?.id
    });
    return res.status(401).json({
      error: 'Authentication required',
      code: 'AUTH_REQUIRED',
      message: 'You must be logged in to access this resource'
    });
  }

  authDebugService.log('auth-required', 'info', 'Authentication successful', {
    url: req.url,
    method: req.method,
    userId: req.user.id,
    userName: req.user.name,
    userGroups: req.user.groups
  });
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
 * Stricter guard than `authRequired`: rejects anonymous principals even
 * when `anonymousAuth.enabled === true`. Use for endpoints that surface
 * run data, artifacts, or anything not safe to leak to drive-by traffic.
 *
 * Behavior:
 *  - Passes through if there is an authenticated user with a non-anonymous id.
 *  - Otherwise responds 401 with a clear message.
 */
export function authenticatedOnly(req, res, next) {
  if (req.user && req.user.id && req.user.id !== 'anonymous') {
    return next();
  }
  authDebugService.log(
    'authenticated-only',
    'info',
    'Rejecting anonymous request — endpoint requires a signed-in user',
    { url: req.url, method: req.method, userId: req.user?.id }
  );
  // Generic message — do NOT leak which endpoints are reachable anonymously.
  // That hint would help an attacker map the platform's allowed surface.
  return res.status(401).json({
    error: 'authentication required'
  });
}

/**
 * Combined middleware for chat endpoints that enforces authentication and app access
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export function chatAuthRequired(req, res, next) {
  authDebugService.log('chat-auth-required', 'debug', 'Chat authentication middleware called', {
    url: req.url,
    method: req.method
  });

  // First check if authentication is required
  authRequired(req, res, err => {
    if (err) return next(err);

    // Tokenless requests reach here with req.user still undefined whenever
    // anonymousAuth is enabled (authRequired only enforces auth, it never
    // materializes a principal). Without a principal, appAccessRequired's
    // permission check silently no-ops, so anonymous callers could reach any
    // app id, including ones not allowlisted for the anonymous group. Build
    // the same resolved-permissions anonymous principal here that the apps
    // list endpoint already builds for itself, scoped to chat endpoints only.
    if (!req.user) {
      const platformConfig = configCache.getPlatform() || {};
      if (isAnonymousAccessAllowed(platformConfig)) {
        req.user = enhanceUserWithPermissions(null, platformConfig.auth || {}, platformConfig);
      }
    }

    // Check app access permissions whenever a principal exists.
    // resourceAccessRequired() is a safe no-op if req.user.permissions is
    // somehow still missing.
    if (req.user) {
      authDebugService.log('chat-auth-required', 'info', 'Checking app access', {
        url: req.url,
        method: req.method,
        userId: req.user?.id,
        appId: req.params.appId
      });
      return appAccessRequired(req, res, next);
    }

    authDebugService.log(
      'chat-auth-required',
      'info',
      'Proceeding without app access check (no user principal)',
      {
        url: req.url,
        method: req.method,
        hasUser: !!req.user
      }
    );
    next();
  });
}
