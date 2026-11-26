// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * How a failed API request reads in the UI, shared by the axios client and by
 * requests that bypass it (a chat turn streamed on its own POST). Kept free of
 * the axios client so either can import it.
 *
 * @module api/utils/apiErrors
 */

// Request timeout detection
export const isTimeoutError = error => {
  return (
    error?.message?.includes('timeout') ||
    error?.originalError?.message?.includes('timeout') ||
    error?.code === 'ECONNABORTED'
  );
};

/**
 * Who refused a request for being too large: `'proxy'` for a 413 that carries no iHub error
 * (a reverse proxy in front of iHub answered, usually with an HTML page: nginx allows 1 MB by
 * default), `'server'` for iHub's own `PAYLOAD_TOO_LARGE` (`requestBodyLimitMB`). Any other
 * 413 (`QUOTA_FILE_BYTES`, `UPLOAD_TOO_LARGE`, ...) names its own cause, so it is neither.
 *
 * @param {Object} error - An axios error, an error enhanced by `enhanceApiError`, or anything
 *   shaped like one (`response.status`, `response.data`)
 * @returns {'proxy'|'server'|undefined}
 */
export function requestTooLargeBy(error) {
  const response = error?.response ?? error?.originalError?.response;
  if (response?.status !== 413) return undefined;
  const code = response.data?.code;
  if (!code) return 'proxy';
  return code === 'PAYLOAD_TOO_LARGE' ? 'server' : undefined;
}

/**
 * The error an API call failed with, as the UI shows it: a friendly message
 * for timeouts, 401, 403, 404 and 5xx, the server's `detail` otherwise, and
 * the flags and `code` callers branch on.
 *
 * @param {Object} error - An axios error, or anything shaped like one
 *   (`message`, `response.status`, `response.data`)
 * @returns {Error} with `status`, `userFriendlyMessage`, `originalMessage`,
 *   `isAccessDenied`, `isAuthRequired`, `isTimeout`, `requestTooLarge` (see
 *   `requestTooLargeBy`) and `code`
 */
export function enhanceApiError(error) {
  // Create user-friendly error messages
  let userMessage = error.response?.data?.detail || error.message || 'An unexpected error occurred';
  let userFriendlyMessage = userMessage;

  // Handle specific error types with better messages
  if (isTimeoutError(error)) {
    userFriendlyMessage = 'Request timed out. The operation may have taken longer than expected.';
  } else if (error.response?.status === 403) {
    userFriendlyMessage =
      'You do not have permission to access this resource. Please contact your administrator if you believe this is an error.';
  } else if (error.response?.status === 401) {
    // For authentication errors, prioritize the server's message if it's more descriptive
    if (error.response?.data?.detail && error.response.data.detail !== 'Authentication required') {
      userFriendlyMessage = error.response.data.detail;
    } else {
      userFriendlyMessage = 'Authentication required. Please log in to access this resource.';
    }
  } else if (error.response?.status === 404) {
    userFriendlyMessage = 'The requested resource was not found.';
  } else if (requestTooLargeBy(error) === 'proxy') {
    userFriendlyMessage =
      'The request was too large and was refused before it reached iHub. A reverse proxy in front of iHub may limit the request size.';
  } else if (requestTooLargeBy(error) === 'server') {
    userFriendlyMessage = 'The request is larger than iHub accepts.';
  } else if (error.response?.status >= 500) {
    userFriendlyMessage = 'A server error occurred. Please try again later.';
  }

  // Enhance error object with useful information
  const enhancedError = new Error(userFriendlyMessage);
  enhancedError.status = error.response?.status || 500;
  enhancedError.originalError = error;
  enhancedError.originalMessage = userMessage;
  enhancedError.userFriendlyMessage = userFriendlyMessage;
  enhancedError.isAccessDenied = error.response?.status === 403;
  enhancedError.isAuthRequired = error.response?.status === 401;
  enhancedError.isTimeout = isTimeoutError(error);
  enhancedError.requestTooLarge = requestTooLargeBy(error);
  enhancedError.code = error.response?.data?.code; // Extract error code from server response
  return enhancedError;
}

/**
 * A request was answered 401: forget the stored token and, unless told not
 * to, raise `authTokenExpired` (AuthContext then signs the user out or
 * redirects to the login). Also used by requests that bypass this client
 * (a chat turn streamed on its own POST).
 *
 * @param {Object} [options]
 * @param {boolean} [options.notify=true] - Dispatch `authTokenExpired`
 */
export function expireSession({ notify = true } = {}) {
  // Token expired or invalid - clear localStorage token for backward compatibility
  if (localStorage.getItem('authToken')) {
    console.log('Authentication token expired or invalid, clearing localStorage token');
    localStorage.removeItem('authToken');
  }
  if (notify) window.dispatchEvent(new CustomEvent('authTokenExpired'));
}
