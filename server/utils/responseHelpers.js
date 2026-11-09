// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Centralized response helper functions to reduce duplication
 */

import logger from './logger.js';
import { ServiceError } from './ServiceError.js';
import { codeOfStatus, sendProblem } from './errorResponse.js';

/**
 * Send a standardized error response (`application/problem+json`, see
 * `utils/errorResponse.js`). Throw a `ServiceError` where you can; use this where the
 * response must be written in place, for example inside a `try` whose `catch` would
 * answer a second time.
 *
 * @param {Object} res - Express response object
 * @param {number} statusCode - HTTP status code
 * @param {string} message - What went wrong; shown to the caller as `detail` (a 5xx only when it is safe)
 * @param {Object} options - Additional options
 * @param {Error} [options.error] - Error object for logging
 * @param {string} [options.logPrefix] - Prefix for console logging
 * @param {string} [options.code] - A code of `shared/apiErrors.js`; default is the generic code of the status
 * @param {Object|Array} [options.details] - Interpolation parameters for the client's message, or a list of problems
 */
export function sendErrorResponse(res, statusCode, message, options = {}) {
  const { error, logPrefix, code, details } = options;

  if (error && logPrefix) {
    logger.error(logPrefix, { component: 'Utils', error });
  }

  return sendProblem(
    res,
    new ServiceError(code ?? codeOfStatus(statusCode), message, { status: statusCode, details })
  );
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
