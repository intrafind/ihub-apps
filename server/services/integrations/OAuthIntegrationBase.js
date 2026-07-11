import tokenStorage from '../TokenStorageService.js';
import { httpFetch } from '../../utils/httpConfig.js';
import { getForwardedProto, getForwardedHost } from '../../utils/publicBaseUrl.js';
import logger from '../../utils/logger.js';
import configCache from '../../configCache.js';
import credentialService from '../CredentialService.js';

/**
 * Shared OAuth 2.0 token-lifecycle implementation for cloud storage
 * integrations (Google Drive, Office 365, Nextcloud, ...).
 *
 * Subclasses supply provider-specific pieces (auth URL, token exchange,
 * refresh endpoint/params, API base URL) and get callback-URL resolution,
 * provider-config loading, token store/refresh/expiry handling, and the
 * 401-retry-once API request wrapper for free.
 */
class OAuthIntegrationBase {
  constructor({ serviceName, displayName, componentName }) {
    this.serviceName = serviceName;
    this.displayName = displayName;
    this.componentName = componentName || displayName;
  }

  /**
   * Build callback URL from request, honoring X-Forwarded-* proxy chains.
   * @param {Object} req - Express request object
   * @param {string} providerId - Provider ID to include in callback URL
   * @returns {string} Full callback URL
   */
  _buildCallbackUrl(req, providerId) {
    const protocol = getForwardedProto(req);
    const host = getForwardedHost(req);

    if (!host) {
      throw new Error('Unable to determine host for callback URL');
    }

    return `${protocol}://${host}/api/integrations/${this.serviceName}/${providerId}/callback`;
  }

  /**
   * Resolve the OAuth redirect URI: explicit provider config, then an
   * env var, then auto-detection from the request, then a localhost
   * fallback (development).
   * @param {Object} provider - Resolved provider configuration
   * @param {string} providerId - Provider ID
   * @param {string} envVarName - Environment variable holding a fixed redirect URI
   * @param {Object} [req] - Express request object (optional, for auto-detection)
   * @returns {string} Redirect URI
   */
  _resolveRedirectUri(provider, providerId, envVarName, req = null) {
    let redirectUri = provider.redirectUri || process.env[envVarName];

    if (!redirectUri && req) {
      redirectUri = this._buildCallbackUrl(req, providerId);
      logger.info(`Auto-detected ${this.displayName} callback URL from request`, {
        component: this.componentName,
        redirectUri
      });
    }

    if (!redirectUri) {
      redirectUri = `${process.env.SERVER_URL || 'http://localhost:3000'}/api/integrations/${this.serviceName}/${providerId}/callback`;
      logger.warn(`Using fallback localhost URL for ${this.displayName} callback`, {
        component: this.componentName,
        redirectUri
      });
    }

    return redirectUri;
  }

  /**
   * Load and validate a provider's configuration from cloudStorage.providers,
   * resolving secret-reference fields through the credential service.
   * @param {string} providerId - The provider ID from cloud storage config
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
    if (!configCache || typeof configCache.get !== 'function') {
      throw new Error('Platform configuration cache is not initialized');
    }

    const platformConfig = configCache.getPlatform();
    const cloudStorage = platformConfig?.cloudStorage;

    if (!cloudStorage?.enabled) {
      throw new Error('Cloud storage is not enabled');
    }

    const provider = cloudStorage.providers?.find(
      p => p.id === providerId && p.type === type && p.enabled !== false
    );

    if (!provider) {
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
   * Store encrypted user tokens.
   * @param {string} userId - User ID
   * @param {Object} tokens - Tokens to store
   */
  async storeUserTokens(userId, tokens) {
    try {
      if (!tokens.refreshToken) {
        logger.warn('No refresh token - user will need to reconnect when access token expires', {
          component: this.componentName
        });
      }

      await tokenStorage.storeUserTokens(userId, this.serviceName, tokens, tokens.providerId);
      logger.info(`${this.displayName} tokens stored for user`, {
        component: this.componentName,
        userId,
        providerId: tokens.providerId
      });
      return true;
    } catch (error) {
      logger.error('Error storing user tokens', {
        component: this.componentName,
        error
      });
      throw new Error('Failed to store user tokens');
    }
  }

  /**
   * Hook for subclasses to adjust freshly refreshed tokens before they're
   * stored (e.g. carrying forward a cached value the refresh response
   * omitted). Default is a no-op.
   * @param {Object} refreshedTokens
   * @param {Object} _previousTokens
   * @returns {Object} refreshedTokens (mutated or replaced)
   */
  _afterTokenRefresh(refreshedTokens, _previousTokens) {
    return refreshedTokens;
  }

  /**
   * Hook determining whether an error from the outer getUserTokens() try
   * block should be re-thrown as-is rather than wrapped as a generic
   * 'Failed to retrieve user tokens'. Subclasses may extend this.
   * @param {Error} error
   * @returns {boolean}
   */
  _isPassthroughTokenError(error) {
    return (
      error.message.includes('not authenticated') ||
      error.message.includes('authentication expired')
    );
  }

  /**
   * Retrieve and decrypt user tokens with automatic refresh if expired.
   * @param {string} userId - User ID
   * @param {string} [providerId] - Provider ID
   * @returns {Promise<Object>} Decrypted tokens
   */
  async getUserTokens(userId, providerId) {
    try {
      const tokens = await tokenStorage.getUserTokens(userId, this.serviceName, providerId);
      const expired = await tokenStorage.areTokensExpired(userId, this.serviceName, providerId);

      if (!expired) {
        return tokens;
      }

      logger.info('Tokens expired for user, attempting refresh', {
        component: this.componentName,
        userId
      });

      try {
        if (!tokens.refreshToken) {
          logger.error('No refresh token available for user', {
            component: this.componentName,
            userId
          });
          throw new Error(
            `No refresh token available - user needs to reconnect ${this.displayName} account`
          );
        }

        let refreshedTokens = await this.refreshAccessToken(tokens.providerId, tokens.refreshToken);
        refreshedTokens = this._afterTokenRefresh(refreshedTokens, tokens);

        await this.storeUserTokens(userId, refreshedTokens);
        logger.info(`Successfully refreshed and stored ${this.displayName} tokens for user`, {
          component: this.componentName,
          userId
        });
        return refreshedTokens;
      } catch (refreshError) {
        logger.error('Failed to refresh tokens for user', {
          component: this.componentName,
          userId,
          error: refreshError
        });

        await this.deleteUserTokens(userId, providerId);
        throw new Error(
          `${this.displayName} authentication expired. Please reconnect your account.`
        );
      }
    } catch (error) {
      if (this._isPassthroughTokenError(error)) {
        throw error;
      }
      logger.error('Error retrieving user tokens', {
        component: this.componentName,
        error
      });
      throw new Error('Failed to retrieve user tokens');
    }
  }

  /**
   * Delete user tokens (disconnect).
   * @param {string} userId - User ID
   * @param {string} [providerId] - Provider ID
   * @returns {Promise<boolean>} Success status
   */
  async deleteUserTokens(userId, providerId) {
    try {
      const result = await tokenStorage.deleteUserTokens(userId, this.serviceName, providerId);
      if (result) {
        logger.info(`${this.displayName} tokens deleted for user`, {
          component: this.componentName,
          userId,
          providerId
        });
      }
      return result;
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
      const metadata = await tokenStorage.getTokenMetadata(userId, this.serviceName, providerId);
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
   * Make an authenticated API request against the given base URL, with a
   * single automatic token-refresh retry on 401.
   * @param {string} apiBaseUrl - Base URL to prefix onto relative endpoints
   * @param {string} endpoint - API endpoint (absolute or relative to apiBaseUrl)
   * @param {string} method - HTTP method
   * @param {Object|null} data - Request body
   * @param {string} userId - User ID
   * @param {string} [providerId] - Provider ID
   * @param {number} retryCount - Current retry count
   * @returns {Promise<Object>} API response
   */
  async _makeApiRequestWithRetry(
    apiBaseUrl,
    endpoint,
    method = 'GET',
    data = null,
    userId,
    providerId,
    retryCount = 0
  ) {
    const maxRetries = 1;

    try {
      const tokens = await this.getUserTokens(userId, providerId);
      const url = endpoint.startsWith('http') ? endpoint : `${apiBaseUrl}${endpoint}`;
      const hasBody = !!data && ['POST', 'PUT', 'PATCH'].includes(method);

      const fetchOptions = {
        method,
        headers: this._buildApiRequestHeaders(tokens, method, hasBody)
      };

      if (hasBody) {
        fetchOptions.body = JSON.stringify(data);
      }

      const response = await httpFetch(url, fetchOptions);

      if (!response.ok) {
        if (response.status === 401 && retryCount < maxRetries) {
          logger.info('Received 401, attempting token refresh and retry', {
            component: this.componentName,
            attempt: retryCount + 1,
            maxAttempts: maxRetries + 1
          });

          try {
            const expiredTokens = await tokenStorage.getUserTokens(
              userId,
              this.serviceName,
              providerId
            );

            if (!expiredTokens.refreshToken) {
              throw new Error('No refresh token available');
            }

            const refreshedTokens = await this.refreshAccessToken(
              expiredTokens.providerId,
              expiredTokens.refreshToken
            );

            await this.storeUserTokens(userId, refreshedTokens);

            return await this._makeApiRequestWithRetry(
              apiBaseUrl,
              endpoint,
              method,
              data,
              userId,
              providerId,
              retryCount + 1
            );
          } catch (refreshError) {
            logger.error('Forced token refresh failed', {
              component: this.componentName,
              error: refreshError
            });

            await this.deleteUserTokens(userId, providerId);
            throw new Error(
              `${this.displayName} authentication expired. Please reconnect your account.`
            );
          }
        } else if (response.status === 401) {
          throw new Error(
            `${this.displayName} authentication required. Please reconnect your account.`
          );
        } else if (response.status === 429) {
          const retryAfter = response.headers.get('retry-after') || 'unknown';
          logger.warn('Rate limit exceeded', {
            component: this.componentName,
            retryAfter,
            endpoint
          });
          throw new Error(
            `${this.displayName} API rate limit exceeded. Please try again in a moment.`
          );
        }

        const errorData = await response.json().catch(() => ({}));
        if (response.status === 404) {
          logger.debug(`${this.displayName} API returned 404 (not found)`, {
            component: this.componentName,
            endpoint,
            errorMessage: errorData?.error?.message || 'Resource not found'
          });
          throw new Error(
            `${this.displayName} API error: ${errorData?.error?.message || 'Resource not found'}`
          );
        }

        logger.error(`${this.displayName} API request failed`, {
          component: this.componentName,
          error: errorData
        });
        throw new Error(
          `${this.displayName} API error: ${errorData?.error?.message || response.statusText}`
        );
      }

      if (response.status === 204) return null;
      return await response.json();
    } catch (error) {
      if (error.message.includes(this.displayName) || error.message.includes('authentication')) {
        throw error;
      }
      logger.error(`${this.displayName} API request failed`, {
        component: this.componentName,
        error
      });
      throw new Error(`${this.displayName} API error: ${error.message}`);
    }
  }
}

export default OAuthIntegrationBase;
