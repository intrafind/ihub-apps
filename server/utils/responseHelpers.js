/**
 * Centralized response helper functions to reduce duplication
 */

/**
 * Send a standardized error response
 * @param {Object} res - Express response object
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {Object} options - Additional options
 * @param {Error} options.error - Error object for logging
 * @param {string} options.logPrefix - Prefix for console logging
 * @param {Object} options.details - Additional error details
 */
export function sendErrorResponse(res, statusCode, message, options = {}) {
  const { error, logPrefix, details } = options;

  if (error && logPrefix) {
    console.error(`${logPrefix}:`, error);
  }

  const response = { error: message };
  if (details) {
    response.details = details;
  }

  return res.status(statusCode).json(response);
}

/**
 * Send a generic internal server error
 * @param {Object} res - Express response object
 * @param {Error} error - Error object for logging
 * @param {string} context - Context for logging
 */
export function sendInternalError(res, error, context) {
  return sendErrorResponse(res, 500, 'Internal server error', {
    error,
    logPrefix: `Error in ${context}`
  });
}

/**
 * Send a failed operation error
 * @param {Object} res - Express response object
 * @param {string} operation - Operation that failed
 * @param {Error} error - Error object for logging
 */
export function sendFailedOperationError(res, operation, error) {
  return sendErrorResponse(res, 500, `Failed to ${operation}`, {
    error,
    logPrefix: `Failed to ${operation}`
  });
}

/**
 * Send an authentication required error
 * @param {Object} res - Express response object
 */
export function sendAuthRequired(res) {
  return res.status(401).json({ error: 'Authentication required' });
}

/**
 * Send an insufficient permissions error
 * @param {Object} res - Express response object
 * @param {string} requiredPermission - Optional specific permission required
 */
export function sendInsufficientPermissions(res, requiredPermission) {
  const message = requiredPermission
    ? `Insufficient permissions: ${requiredPermission} required`
    : 'Insufficient permissions';
  return res.status(403).json({ error: message });
}

/**
 * Send a not found error
 * @param {Object} res - Express response object
 * @param {string} resource - Resource that was not found
 */
export function sendNotFound(res, resource) {
  return res.status(404).json({ error: `${resource} not found` });
}

/**
 * Send a bad request error
 * @param {Object} res - Express response object
 * @param {string} message - Error message
 * @param {Object} details - Optional validation details
 */
export function sendBadRequest(res, message, details) {
  return sendErrorResponse(res, 400, message, { details });
}

/**
 * Wrap an async route handler with standard error handling
 * @param {Function} handler - Async route handler
 * @param {string} context - Context for error logging
 * @returns {Function} Wrapped handler
 */
export function asyncHandler(handler, context) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      sendInternalError(res, error, context);
    }
  };
}

/**
 * Create a route handler with standard try-catch error handling
 * @param {string} context - Context for error logging
 * @param {Function} handler - Handler function
 * @returns {Function} Route handler
 */
export function createRouteHandler(context, handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      sendInternalError(res, error, context);
    }
  };
}
