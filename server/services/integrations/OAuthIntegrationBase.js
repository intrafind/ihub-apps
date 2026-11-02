// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import tokenStorage from '../TokenStorageService.js';
import { httpFetch } from '../../utils/httpConfig.js';
import { getIntegrationConnectionService } from './auth/IntegrationConnectionService.js';
import { isIntegrationAuthRequired } from './auth/integrationAuthRequired.js';
import { tokenStorageIdFor } from './auth/tokenSecrets.js';
import { getForwardedHost } from '../../utils/publicBaseUrl.js';
import logger from '../../utils/logger.js';
import credentialService from '../CredentialService.js';
import { findCloudStorageProvider, resolveCloudStorageRedirectUri } from './cloudStorageConfig.js';
import { isUnavailableError } from './oauthRefreshError.js';

// A request answered with 401 is retried once, after refreshing the tokens.
const MAX_API_RETRIES = 1;

/** An absolute endpoint passes through; a relative one is prefixed with the service's base URL. */
function resolveApiUrl(apiBaseUrl, endpoint) {
  return endpoint.startsWith('http') ? endpoint : `${apiBaseUrl}${endpoint}`;
}

/** The parsed JSON body of a successful response, or null for 204 No Content. */
function readResponseBody(response) {
  return response.status === 204 ? null : response.json();
}

/**
 * Shared base of the cloud storage integrations (Google Drive, Office 365,
 * Nextcloud): provider-config loading, callback-URL resolution and the
 * 401-retry-once API request wrapper.
 *
 * The token lifecycle is not here: sign-in, code exchange, storage, refresh
 * and disconnect run through the shared OAuth client and the connection
 * service (`auth/OAuthUserClient.js`, `auth/IntegrationConnectionService.js`).
 * A subclass only declares its authorization server and scopes through
 * `oauthStrategy(providerId)`.
 */
class OAuthIntegrationBase {
  constructor({ serviceName, displayName, componentName }) {
    this.serviceName = serviceName;
    this.displayName = displayName;
    this.componentName = componentName || displayName;
  }

  /**
   * The callback URL derived from the request, as the browser sees it: scheme
   * and host from the `X-Forwarded-Proto` / `X-Forwarded-Host` headers of a
   * trusted proxy (else the request's own), the deployment's base path
   * (`X-Forwarded-Prefix`), then `/api/integrations/<service>/<providerId>/callback`.
   * @param {Object} req - Express request object
   * @param {string} providerId - The installation id
   * @returns {string} Full callback URL
   * @throws {Error} when the request names no host
   */
  _buildCallbackUrl(req, providerId) {
    if (!getForwardedHost(req)) {
      throw new Error('Unable to determine host for callback URL');
    }
    return resolveCloudStorageRedirectUri(req, { id: providerId, type: this.serviceName });
  }

  /**
   * Load and validate a provider's configuration from its installation
   * (`cloudStorageConfig.js`: an installation of the Office 365, Google Drive
   * or Nextcloud definition, read in the provider shape), resolving
   * secret-reference fields through the credential service.
   * @param {string} providerId - The provider ID: the installation id
   * @param {Object} options
   * @param {string} options.type - Provider type discriminator (e.g. 'googledrive')
   * @param {string[]} [options.requiredFields] - Fields that must be present on the provider
   * @param {string[]} [options.secretFields] - Ref fields to resolve (e.g. 'clientSecretRef' -> 'clientSecret')
   * @param {Function} [options.postProcess] - Optional (provider) => provider transform
   * @returns {Object} Provider configuration with secrets resolved
   */
  _getProviderConfig(
    providerId,
    { type, requiredFields = [], secretFields = [], postProcess } = {}
  ) {
    const provider = findCloudStorageProvider(providerId, type);

    if (!provider || provider.enabled === false) {
      throw new Error(`${this.displayName} provider '${providerId}' not found or not enabled`);
    }

    const missingFields = requiredFields.filter(field => !provider[field]);
    if (missingFields.length > 0) {
      throw new Error(
        `${this.displayName} provider '${providerId}' missing required configuration (${requiredFields.join(', ')})`
      );
    }

    const resolved = { ...provider };
    for (const refField of secretFields) {
      const targetField = refField.replace(/Ref$/, '');
      resolved[targetField] = credentialService.resolveSecret(provider[refField]);
    }

    return postProcess ? postProcess(resolved) || resolved : resolved;
  }

  /**
   * The user's tokens for one installation, refreshed when they expired.
   * Delegates to the connection service, which owns the token lifecycle of
   * every integration (refresh single-flight, terminal vs temporary
   * failures, endpoint changes); the stored payload keeps the shape the
   * service reads (`{ accessToken, refreshToken, providerId, … }`).
   * @param {string} userId - User ID
   * @param {string} providerId - Provider ID (the installation id)
   * @param {Object} [options]
   * @param {boolean} [options.forceRefresh] - The API answered 401
   * @param {string} [options.usedAccessToken] - The token that answer was for
   * @returns {Promise<Object>} Decrypted tokens
   */
  async getUserTokens(userId, providerId, options = {}) {
    try {
      return await getIntegrationConnectionService().getUserTokens({
        installationId: providerId,
        userId,
        ...options
      });
    } catch (error) {
      throw this._toTokenError(error);
    }
  }

  /**
   * Errors the caller acts on pass through unchanged — "connect first"
   * (`IntegrationAuthRequiredError`: not authenticated, authentication
   * expired) and "temporarily unavailable" — anything else is logged and
   * reported as a generic failure.
   * @param {Error} error
   * @returns {Error}
   */
  _toTokenError(error) {
    if (isIntegrationAuthRequired(error) || isUnavailableError(error)) return error;
    logger.error('Error retrieving user tokens', {
      component: this.componentName,
      error
    });
    return new Error('Failed to retrieve user tokens');
  }

  /**
   * Disconnect: revoke upstream when the provider supports it, delete the
   * tokens, mark the connection revoked (audit `connection.revoke`).
   * @param {string} userId - User ID
   * @param {string} providerId - Provider ID (the installation id)
   * @param {import('express').Request} [req] - For the audit entry
   * @returns {Promise<boolean>} Whether tokens were removed
   */
  async deleteUserTokens(userId, providerId, req) {
    try {
      const { removed } = await getIntegrationConnectionService().disconnect({
        installationId: providerId,
        userId,
        req
      });
      return removed;
    } catch (error) {
      logger.error('Error deleting user tokens', {
        component: this.componentName,
        error
      });
      return false;
    }
  }

  /**
   * Get token expiration info for monitoring.
   * @param {string} userId - User ID
   * @param {string} [providerId] - Provider ID
   * @returns {Promise<Object>} Token metadata
   */
  async getTokenExpirationInfo(userId, providerId) {
    try {
      const metadata = await tokenStorage.getTokenMetadata(
        tokenStorageIdFor(userId),
        this.serviceName,
        providerId
      );
      const now = new Date();
      const expiresAt = new Date(metadata.expiresAt);
      const minutesUntilExpiry = Math.floor((expiresAt - now) / (1000 * 60));

      return {
        expiresAt: metadata.expiresAt,
        minutesUntilExpiry,
        isExpiring: minutesUntilExpiry <= 10,
        isExpired: metadata.expired
      };
    } catch {
      return {
        expiresAt: null,
        minutesUntilExpiry: 0,
        isExpiring: true,
        isExpired: true
      };
    }
  }

  /**
   * Build headers for an authenticated API request. Subclasses override
   * to always include Content-Type (Office 365) vs. only on write methods
   * with a body (Google Drive default here).
   * @param {Object} tokens
   * @param {string} method
   * @param {boolean} hasBody
   * @returns {Object} headers
   */
  _buildApiRequestHeaders(tokens, method, hasBody) {
    const headers = {
      Authorization: `Bearer ${tokens.accessToken}`,
      Accept: 'application/json'
    };
    if (hasBody) {
      headers['Content-Type'] = 'application/json';
    }
    return headers;
  }

  /**
   * Build the fetch options for an authenticated API request. A JSON body is
   * only sent for POST/PUT/PATCH; `_buildApiRequestHeaders` decides the rest.
   * @param {Object} tokens - Decrypted user tokens
   * @param {string} method - HTTP method
   * @param {Object|null} data - Request body
   * @returns {Object} Options for httpFetch
   */
  _buildApiFetchOptions(tokens, method, data) {
    const hasBody = Boolean(data) && ['POST', 'PUT', 'PATCH'].includes(method);
    const options = {
      method,
      headers: this._buildApiRequestHeaders(tokens, method, hasBody)
    };
    if (hasBody) {
      options.body = JSON.stringify(data);
    }
    return options;
  }

  /**
   * Build the error for a 429, logging the provider's retry-after hint.
   * @param {Response} response - The 429 response
   * @param {string} endpoint - Requested endpoint, for logging
   * @returns {Error} The error to throw
   */
  _rateLimitError(response, endpoint) {
    const retryAfter = response.headers.get('retry-after') || 'unknown';
    logger.warn('Rate limit exceeded', {
      component: this.componentName,
      retryAfter,
      endpoint
    });
    return new Error(`${this.displayName} API rate limit exceeded. Please try again in a moment.`);
  }

  /**
   * Build the error for a 404. A 404 is an expected outcome, so it is only
   * debug-logged.
   * @param {Object} errorData - Parsed error body, or {} when it had none
   * @param {string} endpoint - Requested endpoint, for logging
   * @returns {Error} The error to throw
   */
  _notFoundError(errorData, endpoint) {
    const message = errorData.error?.message || 'Resource not found';
    logger.debug(`${this.displayName} API returned 404 (not found)`, {
      component: this.componentName,
      endpoint,
      errorMessage: message
    });
    return new Error(`${this.displayName} API error: ${message}`);
  }

  /**
   * Build the error for any other failed response: the provider's message, or
   * the status text when the body has none.
   * @param {Response} response - The failed response
   * @param {Object} errorData - Parsed error body, or {} when it had none
   * @returns {Error} The error to throw
   */
  _requestFailedError(response, errorData) {
    logger.error(`${this.displayName} API request failed`, {
      component: this.componentName,
      error: errorData
    });
    return new Error(
      `${this.displayName} API error: ${errorData.error?.message || response.statusText}`
    );
  }

  /**
   * Turn a failed (non-OK, non-retried) API response into the error to throw.
   * 401 and 429 get dedicated messages; a 404 and everything else carry the
   * provider's message.
   * @param {Response} response - The failed response
   * @param {string} endpoint - Requested endpoint, for logging
   * @returns {Promise<Error>} The error to throw
   */
  async _apiErrorFromResponse(response, endpoint) {
    if (response.status === 401) {
      return new Error(
        `${this.displayName} authentication required. Please reconnect your account.`
      );
    }
    if (response.status === 429) {
      return this._rateLimitError(response, endpoint);
    }

    const errorData = await response.json().catch(() => ({}));
    return response.status === 404
      ? this._notFoundError(errorData, endpoint)
      : this._requestFailedError(response, errorData);
  }

  /**
   * Decide what to throw for an error that escaped an API request: errors
   * that already name the service or concern authentication pass through,
   * everything else is logged and wrapped as an API error.
   * @param {Error} error
   * @returns {Error} The error to throw
   */
  _toApiRequestError(error) {
    if (error.message.includes(this.displayName) || error.message.includes('authentication')) {
      return error;
    }
    logger.error(`${this.displayName} API request failed`, {
      component: this.componentName,
      error
    });
    return new Error(`${this.displayName} API error: ${error.message}`);
  }

  /**
   * Make an authenticated API request against the given base URL, with a
   * single automatic token-refresh retry on 401.
   * @param {string} apiBaseUrl - Base URL to prefix onto relative endpoints
   * @param {string} endpoint - API endpoint (absolute or relative to apiBaseUrl)
   * @param {string} method - HTTP method
   * @param {Object|null} data - Request body
   * @param {string} userId - User ID
   * @param {string} [providerId] - Provider ID
   * @param {number} [retryCount] - Current retry count
   * @param {{signal?: AbortSignal}} [options] - `signal` aborts the request
   * @returns {Promise<Object>} API response
   */
  async _makeApiRequestWithRetry(
    apiBaseUrl,
    endpoint,
    method,
    data,
    userId,
    providerId,
    retryCount = 0,
    options = {}
  ) {
    try {
      const tokens = await this.getUserTokens(userId, providerId);
      const url = resolveApiUrl(apiBaseUrl, endpoint);
      const fetchOptions = this._buildApiFetchOptions(tokens, method, data);
      if (options.signal) fetchOptions.signal = options.signal;
      const response = await httpFetch(url, fetchOptions);

      if (response.ok) {
        return await readResponseBody(response);
      }

      if (response.status === 401 && retryCount < MAX_API_RETRIES) {
        logger.info('Received 401, attempting token refresh and retry', {
          component: this.componentName,
          attempt: retryCount + 1,
          maxAttempts: MAX_API_RETRIES + 1
        });
        await this.getUserTokens(userId, providerId, {
          forceRefresh: true,
          usedAccessToken: tokens.accessToken
        });
        return await this._makeApiRequestWithRetry(
          apiBaseUrl,
          endpoint,
          method,
          data,
          userId,
          providerId,
          retryCount + 1,
          options
        );
      }

      throw await this._apiErrorFromResponse(response, endpoint);
    } catch (error) {
      throw this._toApiRequestError(error);
    }
  }
}

export default OAuthIntegrationBase;
