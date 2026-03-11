import 'dotenv/config';
import crypto from 'crypto';
import tokenStorage from '../TokenStorageService.js';
import { httpFetch } from '../../utils/httpConfig.js';
import logger from '../../utils/logger.js';
import configCache from '../../configCache.js';

/**
 * Google Drive export MIME type mappings for Google Workspace documents
 * These files cannot be downloaded directly and must be exported to a standard format
 */
const GOOGLE_EXPORT_MIME_TYPES = {
  'application/vnd.google-apps.document': {
    exportMimeType: 'application/pdf',
    extension: '.pdf'
  },
  'application/vnd.google-apps.spreadsheet': {
    exportMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: '.xlsx'
  },
  'application/vnd.google-apps.presentation': {
    exportMimeType: 'application/pdf',
    extension: '.pdf'
  },
  'application/vnd.google-apps.drawing': {
    exportMimeType: 'image/png',
    extension: '.png'
  }
};

/**
 * Google Drive Service for Google Workspace file access integration
 * Provides OAuth 2.0 authentication with PKCE, secure token storage, and Google Drive API access
 */
class GoogleDriveService {
  constructor() {
    this.serviceName = 'googledrive';

    // Google OAuth2 endpoints
    this.authBaseUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
    this.tokenUrl = 'https://oauth2.googleapis.com/token';
    this.driveApiUrl = 'https://www.googleapis.com/drive/v3';
    this.userInfoUrl = 'https://www.googleapis.com/oauth2/v2/userinfo';

    logger.info('GoogleDriveService initialized', { component: 'Google Drive' });
  }

  /**
   * Build callback URL from request
   * @param {Object} req - Express request object
   * @param {string} providerId - Provider ID to include in callback URL
   * @returns {string} Full callback URL
   */
  _buildCallbackUrl(req, providerId) {
    const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
    const host = req.get('x-forwarded-host') || req.get('host');

    if (!host) {
      throw new Error('Unable to determine host for callback URL');
    }

    return `${protocol}://${host}/api/integrations/${this.serviceName}/${providerId}/callback`;
  }

  /**
   * Get Google Drive provider configuration
   * @param {string} providerId - The provider ID from cloud storage config
   * @returns {Object} Provider configuration
   */
  _getProviderConfig(providerId) {
    if (!configCache || typeof configCache.get !== 'function') {
      throw new Error('Platform configuration cache is not initialized');
    }

    const platformConfig = configCache.getPlatform();
    const cloudStorage = platformConfig?.cloudStorage;

    if (!cloudStorage?.enabled) {
      throw new Error('Cloud storage is not enabled');
    }

    const provider = cloudStorage.providers?.find(
      p => p.id === providerId && p.type === 'googledrive' && p.enabled !== false
    );

    if (!provider) {
      throw new Error(`Google Drive provider '${providerId}' not found or not enabled`);
    }

    if (!provider.clientId || !provider.clientSecret) {
      throw new Error(
        `Google Drive provider '${providerId}' missing required configuration (clientId, clientSecret)`
      );
    }

    return provider;
  }

  /**
   * Generate OAuth 2.0 authorization URL with PKCE
   * @param {string} providerId - The provider ID
   * @param {string} state - CSRF protection state
   * @param {string} codeVerifier - PKCE code verifier
   * @param {Object} req - Express request object (optional, for auto-detecting callback URL)
   * @returns {string} Authorization URL
   */
  generateAuthUrl(providerId, state, codeVerifier, req = null) {
    const provider = this._getProviderConfig(providerId);
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    let redirectUri = provider.redirectUri || process.env.GOOGLEDRIVE_OAUTH_REDIRECT_URI;

    if (!redirectUri && req) {
      redirectUri = this._buildCallbackUrl(req, providerId);
      logger.info('Auto-detected Google Drive callback URL from request', {
        component: 'Google Drive',
        redirectUri
      });
    }

    if (!redirectUri) {
      redirectUri = `${process.env.SERVER_URL || 'http://localhost:3000'}/api/integrations/${this.serviceName}/${providerId}/callback`;
      logger.warn('Using fallback localhost URL for Google Drive callback', {
        component: 'Google Drive',
        redirectUri
      });
    }

    // Google Drive API scopes
    const scopes = [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email'
    ].join(' ');

    const params = new URLSearchParams({
      client_id: provider.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: scopes,
      state: state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent'
    });

    return `${this.authBaseUrl}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for tokens
   * @param {string} providerId - The provider ID
   * @param {string} authCode - Authorization code from OAuth callback
   * @param {string} codeVerifier - PKCE code verifier
   * @param {Object} req - Express request object (optional, for auto-detecting callback URL)
   * @returns {Promise<Object>} Tokens object
   */
  async exchangeCodeForTokens(providerId, authCode, codeVerifier, req = null) {
    try {
      const provider = this._getProviderConfig(providerId);

      let redirectUri = provider.redirectUri || process.env.GOOGLEDRIVE_OAUTH_REDIRECT_URI;

      if (!redirectUri && req) {
        redirectUri = this._buildCallbackUrl(req, providerId);
        logger.info('Auto-detected Google Drive callback URL for token exchange', {
          component: 'Google Drive',
          redirectUri
        });
      }

      if (!redirectUri) {
        redirectUri = `${process.env.SERVER_URL || 'http://localhost:3000'}/api/integrations/${this.serviceName}/${providerId}/callback`;
        logger.warn('Using fallback localhost URL for Google Drive token exchange', {
          component: 'Google Drive',
          redirectUri
        });
      }

      const tokenData = new URLSearchParams({
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        code: authCode,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: codeVerifier
      });

      const response = await httpFetch(this.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenData
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        logger.error('Error exchanging authorization code', {
          component: 'Google Drive',
          error: errorData
        });
        throw new Error('Failed to exchange authorization code for tokens');
      }

      const tokens = await response.json();

      if (!tokens.refresh_token) {
        logger.warn('No refresh token received from Google OAuth', {
          component: 'Google Drive'
        });
      }

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in,
        scope: tokens.scope,
        providerId: providerId
      };
    } catch (error) {
      if (error.message === 'Failed to exchange authorization code for tokens') throw error;
      logger.error('Error exchanging authorization code', {
        component: 'Google Drive',
        error
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
      logger.info('Attempting to refresh Google Drive access token', {
        component: 'Google Drive'
      });

      const provider = this._getProviderConfig(providerId);

      const tokenData = new URLSearchParams({
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      });

      const response = await httpFetch(this.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenData
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        logger.error('Error refreshing Google Drive access token', {
          component: 'Google Drive',
          error: errorData
        });

        if (response.status === 400) {
          if (errorData.error === 'invalid_grant') {
            throw new Error('Refresh token expired or invalid - user needs to reconnect');
          }
          throw new Error(
            `Token refresh failed: ${errorData.error_description || errorData.error}`
          );
        }

        throw new Error(`Failed to refresh access token: ${response.statusText}`);
      }

      const tokens = await response.json();
      logger.info('Google Drive token refresh successful', { component: 'Google Drive' });

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || refreshToken,
        expiresIn: tokens.expires_in,
        scope: tokens.scope,
        providerId: providerId
      };
    } catch (error) {
      if (
        error.message.includes('Refresh token expired') ||
        error.message.includes('Token refresh failed') ||
        error.message.includes('Failed to refresh access token')
      ) {
        throw error;
      }
      logger.error('Error refreshing Google Drive access token', {
        component: 'Google Drive',
        error
      });
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
        logger.warn('No refresh token - user will need to reconnect when access token expires', {
          component: 'Google Drive'
        });
      }

      await tokenStorage.storeUserTokens(userId, this.serviceName, tokens);
      logger.info('Google Drive tokens stored for user', {
        component: 'Google Drive',
        userId,
        providerId: tokens.providerId
      });
      return true;
    } catch (error) {
      logger.error('Error storing user tokens', {
        component: 'Google Drive',
        error
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
      let tokens = await tokenStorage.getUserTokens(userId, this.serviceName);

      const expired = await tokenStorage.areTokensExpired(userId, this.serviceName);

      if (expired) {
        logger.info('Tokens expired for user, attempting refresh', {
          component: 'Google Drive',
          userId
        });

        try {
          if (!tokens.refreshToken) {
            logger.error('No refresh token available for user', {
              component: 'Google Drive',
              userId
            });
            throw new Error(
              'No refresh token available - user needs to reconnect Google Drive account'
            );
          }

          const refreshedTokens = await this.refreshAccessToken(
            tokens.providerId,
            tokens.refreshToken
          );

          await this.storeUserTokens(userId, refreshedTokens);
          logger.info('Successfully refreshed Google Drive tokens for user', {
            component: 'Google Drive',
            userId
          });
          return refreshedTokens;
        } catch (refreshError) {
          logger.error('Failed to refresh tokens for user', {
            component: 'Google Drive',
            userId,
            error: refreshError
          });

          await this.deleteUserTokens(userId);
          throw new Error('Google Drive authentication expired. Please reconnect your account.');
        }
      }

      return tokens;
    } catch (error) {
      if (
        error.message.includes('not authenticated') ||
        error.message.includes('authentication expired')
      ) {
        throw error;
      }
      logger.error('Error retrieving user tokens', {
        component: 'Google Drive',
        error
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
        logger.info('Google Drive tokens deleted for user', {
          component: 'Google Drive',
          userId
        });
      }
      return result;
    } catch (error) {
      logger.error('Error deleting user tokens', {
        component: 'Google Drive',
        error
      });
      return false;
    }
  }

  /**
   * Make authenticated Google API request
   * @param {string} endpoint - API endpoint
   * @param {string} method - HTTP method
   * @param {Object|null} data - Request body
   * @param {string} userId - User ID
   * @param {number} retryCount - Current retry count
   * @returns {Promise<Object>} API response
   */
  async makeApiRequest(endpoint, method = 'GET', data = null, userId, retryCount = 0) {
    const maxRetries = 1;

    try {
      const tokens = await this.getUserTokens(userId);

      const url = endpoint.startsWith('http') ? endpoint : `${this.driveApiUrl}${endpoint}`;

      const fetchOptions = {
        method,
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          Accept: 'application/json'
        }
      };

      if (data && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        fetchOptions.headers['Content-Type'] = 'application/json';
        fetchOptions.body = JSON.stringify(data);
      }

      const response = await httpFetch(url, fetchOptions);

      if (!response.ok) {
        if (response.status === 401 && retryCount < maxRetries) {
          logger.info('Received 401, attempting token refresh and retry', {
            component: 'Google Drive',
            attempt: retryCount + 1,
            maxAttempts: maxRetries + 1
          });

          try {
            const expiredTokens = await tokenStorage.getUserTokens(userId, this.serviceName);

            if (!expiredTokens.refreshToken) {
              throw new Error('No refresh token available');
            }

            const refreshedTokens = await this.refreshAccessToken(
              expiredTokens.providerId,
              expiredTokens.refreshToken
            );

            await this.storeUserTokens(userId, refreshedTokens);

            return await this.makeApiRequest(endpoint, method, data, userId, retryCount + 1);
          } catch (refreshError) {
            logger.error('Forced token refresh failed', {
              component: 'Google Drive',
              error: refreshError
            });

            await this.deleteUserTokens(userId);
            throw new Error('Google Drive authentication expired. Please reconnect your account.');
          }
        } else if (response.status === 401) {
          throw new Error('Google Drive authentication required. Please reconnect your account.');
        } else if (response.status === 429) {
          const retryAfter = response.headers.get('retry-after') || 'unknown';
          logger.warn('Rate limit exceeded', {
            component: 'Google Drive',
            retryAfter,
            endpoint
          });
          throw new Error('Google Drive API rate limit exceeded. Please try again in a moment.');
        }

        const errorData = await response.json().catch(() => ({}));
        if (response.status === 404) {
          logger.debug('Google Drive API returned 404 (not found)', {
            component: 'Google Drive',
            endpoint,
            errorMessage: errorData?.error?.message || 'Resource not found'
          });
          throw new Error(
            `Google Drive API error: ${errorData?.error?.message || 'Resource not found'}`
          );
        }

        logger.error('Google Drive API request failed', {
          component: 'Google Drive',
          error: errorData
        });
        throw new Error(
          `Google Drive API error: ${errorData?.error?.message || response.statusText}`
        );
      }

      if (response.status === 204) return null;
      return await response.json();
    } catch (error) {
      if (error.message.includes('Google Drive')) {
        throw error;
      }
      logger.error('Google Drive API request failed', {
        component: 'Google Drive',
        error
      });
      throw new Error(`Google Drive API error: ${error.message}`);
    }
  }

  /**
   * Check if user has valid Google Drive authentication
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} Authentication status
   */
  async isUserAuthenticated(userId) {
    try {
      await this.getUserTokens(userId);
      await this.makeApiRequest(this.userInfoUrl, 'GET', null, userId);
      return true;
    } catch (error) {
      logger.info('User Google Drive authentication failed', {
        component: 'Google Drive',
        userId,
        error
      });
      return false;
    }
  }

  /**
   * Get user's Google account information
   * @param {string} userId - User ID
   * @returns {Promise<Object>} User info
   */
  async getUserInfo(userId) {
    try {
      const data = await this.makeApiRequest(this.userInfoUrl, 'GET', null, userId);

      return {
        id: data.id,
        displayName: data.name,
        mail: data.email,
        picture: data.picture
      };
    } catch (error) {
      logger.error('Error getting Google Drive user info', {
        component: 'Google Drive',
        error
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
        isExpiring: minutesUntilExpiry <= 10,
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
   * Fetch all pages from a paginated Google Drive API endpoint
   * @param {string} endpoint - API endpoint
   * @param {Object} params - Query parameters
   * @param {string} userId - User ID
   * @returns {Promise<Array>} All items from all pages
   * @private
   */
  async _fetchAllPages(endpoint, params, userId, maxPages = 10) {
    const allItems = [];
    let pageToken = null;
    let pageCount = 0;

    do {
      if (pageCount >= maxPages) {
        logger.warn('Reached maximum page limit in _fetchAllPages', {
          component: 'Google Drive',
          maxPages,
          endpoint
        });
        break;
      }

      const queryParams = { ...params };
      if (pageToken) {
        queryParams.pageToken = pageToken;
      }

      const queryString = new URLSearchParams(queryParams).toString();
      const url = `${endpoint}?${queryString}`;
      const data = await this.makeApiRequest(url, 'GET', null, userId);

      if (data.files) {
        allItems.push(...data.files);
      } else if (data.drives) {
        allItems.push(...data.drives);
      }

      pageToken = data.nextPageToken || null;
      pageCount++;
    } while (pageToken);

    return allItems;
  }

  /**
   * List files in user's My Drive
   * @param {string} userId - User ID
   * @param {string} folderId - Folder ID (null for root)
   * @returns {Promise<Array>} List of files/folders
   */
  async listMyDriveFiles(userId, folderId = null) {
    try {
      const rawParentId = folderId || 'root';
      const parentId = rawParentId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const params = {
        q: `'${parentId}' in parents and trashed=false`,
        fields:
          'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,iconLink,thumbnailLink,webViewLink)',
        pageSize: '100',
        orderBy: 'folder,name'
      };

      const files = await this._fetchAllPages('/files', params, userId);

      return files.map(file => this._mapFileToItem(file));
    } catch (error) {
      logger.error('Error listing My Drive files', {
        component: 'Google Drive',
        error
      });
      throw error;
    }
  }

  /**
   * List shared drives
   * @param {string} userId - User ID
   * @returns {Promise<Array>} List of shared drives
   */
  async listSharedDrives(userId) {
    try {
      logger.info('Loading shared drives', { component: 'Google Drive' });

      const params = {
        pageSize: '100',
        fields: 'nextPageToken,drives(id,name)'
      };

      const drives = await this._fetchAllPages('/drives', params, userId);

      const result = drives.map(drive => ({
        id: drive.id,
        name: drive.name,
        description: drive.name,
        driveType: 'shared',
        source: 'sharedDrives'
      }));

      logger.info('Loaded shared drives', { component: 'Google Drive', count: result.length });
      return result;
    } catch (error) {
      logger.error('Error listing shared drives', {
        component: 'Google Drive',
        error
      });
      return [];
    }
  }

  /**
   * List files in a shared drive
   * @param {string} userId - User ID
   * @param {string} driveId - Shared drive ID
   * @param {string} folderId - Folder ID (null for root)
   * @returns {Promise<Array>} List of files/folders
   */
  async listSharedDriveFiles(userId, driveId, folderId = null) {
    try {
      const rawParentId = folderId || driveId;
      const parentId = rawParentId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const params = {
        q: `'${parentId}' in parents and trashed=false`,
        corpora: 'drive',
        driveId: driveId,
        includeItemsFromAllDrives: 'true',
        supportsAllDrives: 'true',
        fields:
          'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,iconLink,thumbnailLink,webViewLink)',
        pageSize: '100',
        orderBy: 'folder,name'
      };

      const files = await this._fetchAllPages('/files', params, userId);

      return files.map(file => this._mapFileToItem(file));
    } catch (error) {
      logger.error('Error listing shared drive files', {
        component: 'Google Drive',
        error
      });
      throw error;
    }
  }

  /**
   * List files shared with the user
   * @param {string} userId - User ID
   * @returns {Promise<Array>} List of shared files
   */
  async listSharedWithMe(userId) {
    try {
      const params = {
        q: 'sharedWithMe=true and trashed=false',
        fields:
          'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,iconLink,thumbnailLink,webViewLink)',
        pageSize: '100',
        orderBy: 'folder,name'
      };

      const files = await this._fetchAllPages('/files', params, userId);

      return files.map(file => this._mapFileToItem(file));
    } catch (error) {
      logger.error('Error listing shared with me files', {
        component: 'Google Drive',
        error
      });
      throw error;
    }
  }

  /**
   * Search for files
   * @param {string} userId - User ID
   * @param {string} query - Search query
   * @param {string} driveId - Optional shared drive ID
   * @returns {Promise<Array>} List of matching files
   */
  async searchFiles(userId, query, driveId = null) {
    try {
      if (!query || query.trim().length === 0) {
        return [];
      }

      const escapedQuery = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const params = {
        q: `name contains '${escapedQuery}' and trashed=false`,
        fields:
          'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,iconLink,thumbnailLink,webViewLink)',
        pageSize: '100'
      };

      if (driveId) {
        params.corpora = 'drive';
        params.driveId = driveId;
        params.includeItemsFromAllDrives = 'true';
        params.supportsAllDrives = 'true';
      }

      const files = await this._fetchAllPages('/files', params, userId);

      return files.map(file => this._mapFileToItem(file));
    } catch (error) {
      logger.error('Error searching files', {
        component: 'Google Drive',
        error
      });
      throw error;
    }
  }

  /**
   * Download file content
   * @param {string} userId - User ID
   * @param {string} fileId - File ID
   * @returns {Promise<Object>} File data with content
   */
  async downloadFile(userId, fileId) {
    try {
      // Retrieve tokens once for all operations in this method
      const tokens = await this.getUserTokens(userId);

      // Get file metadata first
      const metadataUrl = `${this.driveApiUrl}/files/${fileId}?fields=id,name,mimeType,size,webViewLink`;
      const metadataResponse = await httpFetch(metadataUrl, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` }
      });

      if (!metadataResponse.ok) {
        throw new Error(`Failed to get file metadata: ${metadataResponse.statusText}`);
      }

      const fileInfo = await metadataResponse.json();

      const isGoogleDoc = GOOGLE_EXPORT_MIME_TYPES[fileInfo.mimeType];

      let downloadUrl;
      let resultMimeType;
      let resultName = fileInfo.name;

      if (isGoogleDoc) {
        // Google Workspace documents need to be exported
        downloadUrl = `${this.driveApiUrl}/files/${fileId}/export?mimeType=${encodeURIComponent(isGoogleDoc.exportMimeType)}`;
        resultMimeType = isGoogleDoc.exportMimeType;
        // Add extension if not already present
        if (!resultName.endsWith(isGoogleDoc.extension)) {
          resultName += isGoogleDoc.extension;
        }
      } else {
        // Regular files can be downloaded directly
        downloadUrl = `${this.driveApiUrl}/files/${fileId}?alt=media`;
        resultMimeType = fileInfo.mimeType;
      }

      const response = await httpFetch(downloadUrl, {
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to download file: ${response.statusText}`);
      }

      const content = Buffer.from(await response.arrayBuffer());

      return {
        id: fileInfo.id,
        name: resultName,
        mimeType: resultMimeType,
        size: content.byteLength,
        content
      };
    } catch (error) {
      logger.error('Error downloading file', {
        component: 'Google Drive',
        error
      });
      throw error;
    }
  }

  /**
   * Map a Google Drive file object to standardized item format
   * @param {Object} file - Google Drive file object
   * @returns {Object} Standardized item
   * @private
   */
  _mapFileToItem(file) {
    const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
    const isGoogleDoc = !!GOOGLE_EXPORT_MIME_TYPES[file.mimeType];

    return {
      id: file.id,
      name: file.name,
      size: file.size ? parseInt(file.size, 10) : 0,
      createdDateTime: null,
      lastModifiedDateTime: file.modifiedTime,
      webUrl: file.webViewLink,
      isFolder,
      isFile: !isFolder,
      mimeType: isGoogleDoc
        ? GOOGLE_EXPORT_MIME_TYPES[file.mimeType].exportMimeType
        : file.mimeType,
      isGoogleDoc
    };
  }
}

// Export singleton instance
export default new GoogleDriveService();
