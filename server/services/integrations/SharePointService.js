import 'dotenv/config';
import axios from 'axios';
import crypto from 'crypto';
import tokenStorage from '../TokenStorageService.js';
import { enhanceAxiosConfig } from '../../utils/httpConfig.js';
import logger from '../../utils/logger.js';
import { configCache } from '../../configCache.js';

/**
 * SharePoint Service for Microsoft 365 file access integration
 * Provides OAuth 2.0 authentication with PKCE, secure token storage, and Microsoft Graph API access
 */
class SharePointService {
  constructor() {
    this.serviceName = 'sharepoint';

    // Microsoft Identity Platform endpoints
    this.authBaseUrl = 'https://login.microsoftonline.com';
    this.graphApiUrl = 'https://graph.microsoft.com/v1.0';

    logger.info('🔵 SharePointService initialized', { component: 'SharePoint' });
  }

  /**
   * Get SharePoint provider configuration
   * @param {string} providerId - The provider ID from cloud storage config
   * @returns {Object} Provider configuration
   */
  _getProviderConfig(providerId) {
    if (!configCache || typeof configCache.get !== 'function') {
      throw new Error('Platform configuration cache is not initialized');
    }

    const platformConfig = configCache.get('platform');
    const cloudStorage = platformConfig?.cloudStorage;

    if (!cloudStorage?.enabled) {
      throw new Error('Cloud storage is not enabled');
    }

    const provider = cloudStorage.providers?.find(
      p => p.id === providerId && p.type === 'sharepoint' && p.enabled !== false
    );

    if (!provider) {
      throw new Error(`SharePoint provider '${providerId}' not found or not enabled`);
    }

    if (!provider.tenantId || !provider.clientId || !provider.clientSecret) {
      throw new Error(
        `SharePoint provider '${providerId}' missing required configuration (tenantId, clientId, clientSecret)`
      );
    }

    return provider;
  }

  /**
   * Generate OAuth 2.0 authorization URL with PKCE
   * @param {string} providerId - The provider ID
   * @param {string} state - CSRF protection state
   * @param {string} codeVerifier - PKCE code verifier
   * @returns {string} Authorization URL
   */
  generateAuthUrl(providerId, state, codeVerifier) {
    const provider = this._getProviderConfig(providerId);
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    // Use the provider's redirect URI or fallback to default
    const redirectUri =
      provider.redirectUri ||
      process.env.SHAREPOINT_OAUTH_REDIRECT_URI ||
      `${process.env.SERVER_URL || 'http://localhost:3000'}/api/integrations/sharepoint/callback`;

    const authUrl = `${this.authBaseUrl}/${provider.tenantId}/oauth2/v2.0/authorize`;

    // Microsoft Graph API scopes for file access
    const scopes = [
      'User.Read', // Basic user info
      'Files.Read.All', // Read files in all site collections
      'Sites.Read.All', // Read items in all site collections
      'offline_access' // Refresh token
    ].join(' ');

    const params = new URLSearchParams({
      client_id: provider.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope: scopes,
      state: state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'consent' // Force consent to ensure refresh token
    });

    return `${authUrl}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for tokens
   * @param {string} providerId - The provider ID
   * @param {string} authCode - Authorization code from OAuth callback
   * @param {string} codeVerifier - PKCE code verifier
   * @returns {Promise<Object>} Tokens object
   */
  async exchangeCodeForTokens(providerId, authCode, codeVerifier) {
    try {
      const provider = this._getProviderConfig(providerId);
      const tokenUrl = `${this.authBaseUrl}/${provider.tenantId}/oauth2/v2.0/token`;

      const redirectUri =
        provider.redirectUri ||
        process.env.SHAREPOINT_OAUTH_REDIRECT_URI ||
        `${process.env.SERVER_URL || 'http://localhost:3000'}/api/integrations/sharepoint/callback`;

      const tokenData = new URLSearchParams({
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        code: authCode,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: codeVerifier
      });

      const response = await axios.post(
        tokenUrl,
        tokenData,
        enhanceAxiosConfig(
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          },
          tokenUrl
        )
      );

      const tokens = response.data;

      if (!tokens.refresh_token) {
        logger.warn('⚠️ WARNING: No refresh token received from Microsoft OAuth', {
          component: 'SharePoint'
        });
      }

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in,
        scope: tokens.scope,
        providerId: providerId // Store which provider these tokens are for
      };
    } catch (error) {
      logger.error('❌ Error exchanging authorization code:', {
        component: 'SharePoint',
        error: error.response?.data || error.message
      });
      throw new Error('Failed to exchange authorization code for tokens');
    }
  }

  /**
   * Refresh access token using refresh token
   * @param {string} providerId - The provider ID
   * @param {string} refreshToken - Refresh token
   * @returns {Promise<Object>} New tokens
   */
  async refreshAccessToken(providerId, refreshToken) {
    try {
      logger.info('🔄 Attempting to refresh SharePoint access token...', {
        component: 'SharePoint'
      });

      const provider = this._getProviderConfig(providerId);
      const tokenUrl = `${this.authBaseUrl}/${provider.tenantId}/oauth2/v2.0/token`;

      const tokenData = new URLSearchParams({
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        scope: 'User.Read Files.Read.All Sites.Read.All offline_access'
      });

      const response = await axios.post(
        tokenUrl,
        tokenData,
        enhanceAxiosConfig(
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          },
          tokenUrl
        )
      );

      const tokens = response.data;
      logger.info('✅ SharePoint token refresh successful', { component: 'SharePoint' });

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || refreshToken, // Use new or keep existing
        expiresIn: tokens.expires_in,
        scope: tokens.scope,
        providerId: providerId
      };
    } catch (error) {
      const errorDetails = error.response?.data || error.message;
      logger.error('❌ Error refreshing SharePoint access token:', {
        component: 'SharePoint',
        error: errorDetails
      });

      if (error.response?.status === 400) {
        const errorData = error.response.data;
        if (errorData.error === 'invalid_grant') {
          throw new Error('Refresh token expired or invalid - user needs to reconnect');
        }
        throw new Error(
          `Token refresh failed: ${errorData.error_description || errorData.error}`
        );
      }

      throw new Error(`Failed to refresh access token: ${error.message}`);
    }
  }

  /**
   * Store encrypted user tokens
   * @param {string} userId - User ID
   * @param {Object} tokens - Tokens to store
   */
  async storeUserTokens(userId, tokens) {
    try {
      if (!tokens.refreshToken) {
        logger.warn(
          '⚠️ WARNING: No refresh token - user will need to reconnect when access token expires',
          { component: 'SharePoint' }
        );
      }

      await tokenStorage.storeUserTokens(userId, this.serviceName, tokens);
      logger.info(`✅ SharePoint tokens stored for user ${userId}`, {
        component: 'SharePoint',
        providerId: tokens.providerId
      });
      return true;
    } catch (error) {
      logger.error('❌ Error storing user tokens:', {
        component: 'SharePoint',
        error: error.message
      });
      throw new Error('Failed to store user tokens');
    }
  }

  /**
   * Retrieve and decrypt user tokens with automatic refresh if expired
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Decrypted tokens
   */
  async getUserTokens(userId) {
    try {
      // Check if tokens are expired
      const expired = await tokenStorage.areTokensExpired(userId, this.serviceName);

      if (expired) {
        logger.info(`🔄 Tokens expired for user ${userId}, attempting refresh...`, {
          component: 'SharePoint'
        });

        try {
          const expiredTokens = await tokenStorage.getUserTokens(userId, this.serviceName);

          if (!expiredTokens.refreshToken) {
            logger.error('❌ No refresh token available for user:', {
              component: 'SharePoint',
              userId
            });
            throw new Error(
              'No refresh token available - user needs to reconnect SharePoint account'
            );
          }

          const refreshedTokens = await this.refreshAccessToken(
            expiredTokens.providerId,
            expiredTokens.refreshToken
          );

          // Store the refreshed tokens
          await this.storeUserTokens(userId, refreshedTokens);
          logger.info(`✅ Successfully refreshed and stored SharePoint tokens for user ${userId}`, {
            component: 'SharePoint'
          });
          return refreshedTokens;
        } catch (refreshError) {
          logger.error(`❌ Failed to refresh tokens for user ${userId}:`, {
            component: 'SharePoint',
            error: refreshError.message
          });

          // If refresh fails, delete the invalid tokens so user can reconnect
          await this.deleteUserTokens(userId);

          throw new Error('SharePoint authentication expired. Please reconnect your account.');
        }
      }

      return await tokenStorage.getUserTokens(userId, this.serviceName);
    } catch (error) {
      if (error.message.includes('not authenticated')) {
        throw new Error('User not authenticated with SharePoint');
      }
      logger.error('❌ Error retrieving user tokens:', {
        component: 'SharePoint',
        error: error.message
      });
      throw new Error('Failed to retrieve user tokens');
    }
  }

  /**
   * Delete user tokens (disconnect)
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} Success status
   */
  async deleteUserTokens(userId) {
    try {
      const result = await tokenStorage.deleteUserTokens(userId, this.serviceName);
      if (result) {
        logger.info(`✅ SharePoint tokens deleted for user ${userId}`, {
          component: 'SharePoint'
        });
      }
      return result;
    } catch (error) {
      logger.error('❌ Error deleting user tokens:', {
        component: 'SharePoint',
        error: error.message
      });
      return false;
    }
  }

  /**
   * Make authenticated Microsoft Graph API request
   * @param {string} endpoint - API endpoint (e.g., '/me')
   * @param {string} method - HTTP method
   * @param {Object|null} data - Request body
   * @param {string} userId - User ID
   * @param {number} retryCount - Current retry count
   * @returns {Promise<Object>} API response
   */
  async makeApiRequest(endpoint, method = 'GET', data = null, userId, retryCount = 0) {
    const maxRetries = 1; // Allow one retry for token refresh

    try {
      const tokens = await this.getUserTokens(userId);

      const url = endpoint.startsWith('http') ? endpoint : `${this.graphApiUrl}${endpoint}`;

      const config = {
        method,
        url,
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        }
      };

      if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        config.data = data;
      }

      const enhancedConfig = enhanceAxiosConfig(config, url);
      const response = await axios(enhancedConfig);
      return response.data;
    } catch (error) {
      if (error.response?.status === 401 && retryCount < maxRetries) {
        logger.info(
          `🔄 Received 401 error, attempting to force token refresh and retry (attempt ${retryCount + 1}/${maxRetries + 1})`,
          { component: 'SharePoint' }
        );

        try {
          // Force refresh tokens
          const expiredTokens = await tokenStorage.getUserTokens(userId, this.serviceName);

          if (!expiredTokens.refreshToken) {
            throw new Error('No refresh token available');
          }

          const refreshedTokens = await this.refreshAccessToken(
            expiredTokens.providerId,
            expiredTokens.refreshToken
          );

          await this.storeUserTokens(userId, refreshedTokens);

          logger.info(`✅ Forced token refresh successful for user ${userId}`, {
            component: 'SharePoint'
          });

          // Retry the request with fresh tokens
          return await this.makeApiRequest(endpoint, method, data, userId, retryCount + 1);
        } catch (refreshError) {
          logger.error(`❌ Forced token refresh failed:`, {
            component: 'SharePoint',
            error: refreshError.message
          });

          // Clean up invalid tokens
          await this.deleteUserTokens(userId);
          throw new Error('SharePoint authentication expired. Please reconnect your account.');
        }
      } else if (error.response?.status === 401) {
        throw new Error('SharePoint authentication required. Please reconnect your account.');
      }

      logger.error('❌ SharePoint API request failed:', {
        component: 'SharePoint',
        error: error.response?.data || error.message
      });
      throw new Error(`SharePoint API error: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  /**
   * Check if user has valid SharePoint authentication
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} Authentication status
   */
  async isUserAuthenticated(userId) {
    try {
      // Try to get tokens - this will attempt refresh if expired
      await this.getUserTokens(userId);

      // Double-check by trying to make a lightweight API call
      await this.makeApiRequest('/me', 'GET', null, userId);

      logger.info(`✅ User ${userId} has valid SharePoint authentication`, {
        component: 'SharePoint'
      });
      return true;
    } catch (error) {
      logger.info(`❌ User ${userId} authentication failed:`, {
        component: 'SharePoint',
        error: error.message
      });
      return false;
    }
  }

  /**
   * Get user's Microsoft account information
   * @param {string} userId - User ID
   * @returns {Promise<Object>} User info
   */
  async getUserInfo(userId) {
    try {
      const data = await this.makeApiRequest('/me', 'GET', null, userId);

      return {
        id: data.id,
        displayName: data.displayName,
        mail: data.mail,
        userPrincipalName: data.userPrincipalName,
        jobTitle: data.jobTitle,
        officeLocation: data.officeLocation
      };
    } catch (error) {
      logger.error('❌ Error getting SharePoint user info:', {
        component: 'SharePoint',
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get token expiration info for monitoring
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Token metadata
   */
  async getTokenExpirationInfo(userId) {
    try {
      const metadata = await tokenStorage.getTokenMetadata(userId, this.serviceName);
      const now = new Date();
      const expiresAt = new Date(metadata.expiresAt);
      const minutesUntilExpiry = Math.floor((expiresAt - now) / (1000 * 60));

      return {
        expiresAt: metadata.expiresAt,
        minutesUntilExpiry,
        isExpiring: minutesUntilExpiry <= 10, // Consider expiring if less than 10 minutes
        isExpired: metadata.expired
      };
    } catch (error) {
      return {
        expiresAt: null,
        minutesUntilExpiry: 0,
        isExpiring: true,
        isExpired: true
      };
    }
  }

  /**
   * List available drives (OneDrive, SharePoint sites)
   * @param {string} userId - User ID
   * @returns {Promise<Array>} List of drives
   */
  async listDrives(userId) {
    try {
      const data = await this.makeApiRequest('/me/drives', 'GET', null, userId);

      return data.value.map(drive => ({
        id: drive.id,
        name: drive.name,
        description: drive.description,
        driveType: drive.driveType,
        owner: drive.owner
      }));
    } catch (error) {
      logger.error('❌ Error listing drives:', {
        component: 'SharePoint',
        error: error.message
      });
      throw error;
    }
  }

  /**
   * List items in a drive folder
   * @param {string} userId - User ID
   * @param {string} driveId - Drive ID (optional, uses default drive if not provided)
   * @param {string} folderId - Folder ID (optional, uses root if not provided)
   * @returns {Promise<Array>} List of items
   */
  async listItems(userId, driveId = null, folderId = null) {
    try {
      let endpoint;
      if (driveId && folderId) {
        endpoint = `/drives/${driveId}/items/${folderId}/children`;
      } else if (driveId) {
        endpoint = `/drives/${driveId}/root/children`;
      } else if (folderId) {
        endpoint = `/me/drive/items/${folderId}/children`;
      } else {
        endpoint = '/me/drive/root/children';
      }

      const data = await this.makeApiRequest(endpoint, 'GET', null, userId);

      return data.value.map(item => ({
        id: item.id,
        name: item.name,
        size: item.size,
        createdDateTime: item.createdDateTime,
        lastModifiedDateTime: item.lastModifiedDateTime,
        webUrl: item.webUrl,
        isFolder: !!item.folder,
        isFile: !!item.file,
        mimeType: item.file?.mimeType,
        downloadUrl: item['@microsoft.graph.downloadUrl']
      }));
    } catch (error) {
      logger.error('❌ Error listing items:', {
        component: 'SharePoint',
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Download file content
   * @param {string} userId - User ID
   * @param {string} fileId - File ID
   * @param {string} driveId - Drive ID (optional)
   * @returns {Promise<Object>} File data with content
   */
  async downloadFile(userId, fileId, driveId = null) {
    try {
      // Get file metadata first
      const endpoint = driveId ? `/drives/${driveId}/items/${fileId}` : `/me/drive/items/${fileId}`;
      const fileInfo = await this.makeApiRequest(endpoint, 'GET', null, userId);

      if (!fileInfo.file) {
        throw new Error('Item is not a file');
      }

      // Get download URL
      const downloadUrl = fileInfo['@microsoft.graph.downloadUrl'];
      if (!downloadUrl) {
        throw new Error('No download URL available for file');
      }

      // Download file content
      const tokens = await this.getUserTokens(userId);
      const response = await axios.get(
        downloadUrl,
        enhanceAxiosConfig(
          {
            headers: {
              Authorization: `Bearer ${tokens.accessToken}`
            },
            responseType: 'arraybuffer'
          },
          downloadUrl
        )
      );

      return {
        id: fileInfo.id,
        name: fileInfo.name,
        mimeType: fileInfo.file.mimeType,
        size: fileInfo.size,
        content: Buffer.from(response.data)
      };
    } catch (error) {
      logger.error('❌ Error downloading file:', {
        component: 'SharePoint',
        error: error.message
      });
      throw error;
    }
  }
}

// Export singleton instance
export default new SharePointService();
