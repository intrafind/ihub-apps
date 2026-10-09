/**
 * Typed errors for refreshing an integration's OAuth access token.
 *
 * Callers decide what to do from `error.code`, never from the message text:
 * the stored tokens are only worth deleting when the refresh token is gone for
 * good, and a temporary failure must not read as a disconnected account.
 */

export const REFRESH_ERROR_CODES = Object.freeze({
  /** The provider rejected the refresh token (`invalid_grant`): the user must reconnect. */
  INVALID_GRANT: 'invalid_grant',
  /** No refresh token is stored: the user must reconnect. */
  MISSING: 'refresh_missing',
  /**
   * The refresh could not be completed for a reason that says nothing about the
   * grant: network error, 5xx, 429, a provider config problem. Other provider
   * error codes (for example `invalid_client`, an expired client secret that an
   * admin can fix) are kept as they came and are not terminal either.
   */
  TEMPORARY: 'refresh_unavailable'
});

/** Code of the error that tells the caller to try again later, not to reconnect. */
export const UNAVAILABLE_ERROR_CODE = 'integration_unavailable';

/** A failed token refresh, carrying a machine-readable `code`. */
export class OAuthRefreshError extends Error {
  /**
   * @param {string} message
   * @param {string} code - One of REFRESH_ERROR_CODES, or the provider's own error code
   * @param {ErrorOptions} [options] - e.g. `{ cause }`
   */
  constructor(message, code, options) {
    super(message, options);
    this.name = 'OAuthRefreshError';
    this.code = code;
  }
}

/** A 400 from the token endpoint: `invalid_grant` is a rejected refresh token, anything else is not. */
function badRequestRefreshFailure(errorData, code) {
  if (code === REFRESH_ERROR_CODES.INVALID_GRANT) {
    return new OAuthRefreshError(
      'Refresh token expired or invalid - user needs to reconnect',
      REFRESH_ERROR_CODES.INVALID_GRANT
    );
  }
  return new OAuthRefreshError(
    `Token refresh failed: ${errorData.error_description || errorData.error}`,
    code
  );
}

/**
 * Build the error for a non-OK response from the token endpoint during a
 * refresh. `invalid_grant` means the provider rejected the refresh token; any
 * other provider error code is kept on the error as it came, and a response
 * without one (5xx, 429, an HTML error page) is a temporary failure.
 * @param {Response} response - The failed token endpoint response
 * @param {Object} errorData - Parsed JSON body, or {} when it had none
 * @returns {OAuthRefreshError}
 */
export function refreshFailureFromResponse(response, errorData) {
  const providerCode = typeof errorData.error === 'string' ? errorData.error : undefined;
  const code = providerCode || REFRESH_ERROR_CODES.TEMPORARY;

  if (response.status === 400) {
    return badRequestRefreshFailure(errorData, code);
  }
  return new OAuthRefreshError(`Failed to refresh access token: ${response.statusText}`, code);
}

/**
 * True when the refresh token is rejected or missing, so the user has to go
 * through the consent flow again. Every other failure, including an unknown
 * one, is not terminal and leaves the stored tokens alone.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isTerminalRefreshError(error) {
  return (
    error?.code === REFRESH_ERROR_CODES.INVALID_GRANT || error?.code === REFRESH_ERROR_CODES.MISSING
  );
}

/**
 * The error thrown to callers when a refresh failed but the user's connection
 * is intact: the advice is to try again, not to reconnect.
 * @param {string} displayName - e.g. 'Google Drive'
 * @param {Error} [cause] - The refresh failure
 * @returns {Error}
 */
export function createUnavailableError(displayName, cause) {
  const error = new Error(
    `${displayName} is temporarily unavailable. Please try again in a moment.`,
    {
      cause
    }
  );
  error.code = UNAVAILABLE_ERROR_CODE;
  return error;
}

/**
 * @param {unknown} error
 * @returns {boolean} true for an error made by createUnavailableError
 */
export function isUnavailableError(error) {
  return error?.code === UNAVAILABLE_ERROR_CODE;
}
