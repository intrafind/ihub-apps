import 'dotenv/config';
import crypto from 'crypto';
import { httpFetch } from '../../utils/httpConfig.js';
import logger from '../../utils/logger.js';
import { readBoundedBody, MAX_DOWNLOAD_BYTES } from '../../utils/boundedBodyReader.js';
import OAuthIntegrationBase from './OAuthIntegrationBase.js';

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
class GoogleDriveService extends OAuthIntegrationBase {
  constructor() {
    super({
      serviceName: 'googledrive',
      displayName: 'Google Drive',
      componentName: 'Google Drive'
    });

    // Google OAuth2 endpoints
    this.authBaseUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
    this.tokenUrl = 'https://oauth2.googleapis.com/token';
    this.driveApiUrl = 'https://www.googleapis.com/drive/v3';
    this.userInfoUrl = 'https://www.googleapis.com/oauth2/v2/userinfo';

    logger.info('GoogleDriveService initialized', { component: 'Google Drive' });
  }

  /**
   * Get Google Drive provider configuration
   * @param {string} providerId - The provider ID from cloud storage config
   * @returns {Object} Provider configuration
   */
  _getProviderConfig(providerId) {
    return super._getProviderConfig(providerId, {
      type: 'googledrive',
      requiredFields: ['clientId', 'clientSecretRef'],
      secretFields: ['clientSecretRef']
    });
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
    const redirectUri = this._resolveRedirectUri(
      provider,
      providerId,
      'GOOGLEDRIVE_OAUTH_REDIRECT_URI',
      req
    );

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
      const redirectUri = this._resolveRedirectUri(
        provider,
        providerId,
        'GOOGLEDRIVE_OAUTH_REDIRECT_URI',
        req
      );

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
   * Make authenticated Google API request
   * @param {string} endpoint - API endpoint
   * @param {string} method - HTTP method
   * @param {Object|null} data - Request body
   * @param {string} userId - User ID
   * @param {string} [providerId] - Provider ID
   * @param {number} retryCount - Current retry count
   * @returns {Promise<Object>} API response
   */
  async makeApiRequest(endpoint, method = 'GET', data = null, userId, providerId, retryCount = 0) {
    return this._makeApiRequestWithRetry(
      this.driveApiUrl,
      endpoint,
      method,
      data,
      userId,
      providerId,
      retryCount
    );
  }

  /**
   * Check if user has valid Google Drive authentication
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} Authentication status
   */
  async isUserAuthenticated(userId, providerId) {
    try {
      await this.getUserTokens(userId, providerId);
      await this.makeApiRequest(this.userInfoUrl, 'GET', null, userId, providerId);
      return true;
    } catch (error) {
      logger.info('User Google Drive authentication failed', {
        component: 'Google Drive',
        userId,
        providerId,
        error
      });
      return false;
    }
  }

  /**
   * Get user's Google account information
   * @param {string} userId - User ID
   * @param {string} [providerId] - Provider ID
   * @returns {Promise<Object>} User info
   */
  async getUserInfo(userId, providerId) {
    try {
      const data = await this.makeApiRequest(this.userInfoUrl, 'GET', null, userId, providerId);

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
   * Fetch all pages from a paginated Google Drive API endpoint
   * @param {string} endpoint - API endpoint
   * @param {Object} params - Query parameters
   * @param {string} userId - User ID
   * @returns {Promise<Array>} All items from all pages
   * @private
   */
  async _fetchAllPages(endpoint, params, userId, providerId, maxPages = 10) {
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
      const data = await this.makeApiRequest(url, 'GET', null, userId, providerId);

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
  async listMyDriveFiles(userId, folderId = null, providerId) {
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

      const files = await this._fetchAllPages('/files', params, userId, providerId);

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
  async listSharedDrives(userId, providerId) {
    try {
      logger.info('Loading shared drives', { component: 'Google Drive' });

      const params = {
        pageSize: '100',
        fields: 'nextPageToken,drives(id,name)'
      };

      const drives = await this._fetchAllPages('/drives', params, userId, providerId);

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
  async listSharedDriveFiles(userId, driveId, folderId = null, providerId) {
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

      const files = await this._fetchAllPages('/files', params, userId, providerId);

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
  async listSharedWithMe(userId, providerId) {
    try {
      const params = {
        q: 'sharedWithMe=true and trashed=false',
        fields:
          'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,iconLink,thumbnailLink,webViewLink)',
        pageSize: '100',
        orderBy: 'folder,name'
      };

      const files = await this._fetchAllPages('/files', params, userId, providerId);

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
  async searchFiles(userId, query, driveId = null, providerId) {
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

      const files = await this._fetchAllPages('/files', params, userId, providerId);

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
  async downloadFile(userId, fileId, providerId) {
    try {
      // Retrieve tokens once for all operations in this method
      const tokens = await this.getUserTokens(userId, providerId);

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

      // Bounded read defends against an attacker hitting `/download`
      // directly with a huge file. Client-side upload caps don't help
      // against `curl`. See server/utils/boundedBodyReader.js.
      const content = await readBoundedBody(response, MAX_DOWNLOAD_BYTES, 'Google Drive download');

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
