import 'dotenv/config';
import crypto from 'crypto';
import { httpFetch } from '../../utils/httpConfig.js';
import logger from '../../utils/logger.js';
import { readBoundedBody, MAX_DOWNLOAD_BYTES } from '../../utils/boundedBodyReader.js';
import OAuthIntegrationBase from './OAuthIntegrationBase.js';

/**
 * Office 365 Service for Microsoft 365 file access integration
 * Provides OAuth 2.0 authentication with PKCE, secure token storage, and Microsoft Graph API access
 */
class Office365Service extends OAuthIntegrationBase {
  constructor() {
    super({
      serviceName: 'office365',
      displayName: 'Office 365',
      componentName: 'Office365Service'
    });

    // Microsoft Identity Platform endpoints
    this.authBaseUrl = 'https://login.microsoftonline.com';
    this.graphApiUrl = 'https://graph.microsoft.com/v1.0';

    logger.info('Office365Service initialized', { component: 'Office365Service' });
  }

  /**
   * Get Office 365 provider configuration
   * @param {string} providerId - The provider ID from cloud storage config
   * @returns {Object} Provider configuration
   */
  _getProviderConfig(providerId) {
    return super._getProviderConfig(providerId, {
      type: 'office365',
      requiredFields: ['tenantIdRef', 'clientId', 'clientSecretRef'],
      secretFields: ['tenantIdRef', 'clientSecretRef']
    });
  }

  /**
   * Build the minimal set of Microsoft Graph scopes required for the
   * provider's enabled sources.
   *
   * Microsoft Entra ID classifies many Graph scopes as "admin consent
   * required" (Files.Read.All, Sites.Read.All, Team.ReadBasic.All,
   * Channel.ReadBasic.All). Requesting them forces every user through a
   * tenant admin even when they only need their own OneDrive. We only
   * ask for those when the corresponding source toggle is enabled.
   *
   * @param {Object} provider - Office 365 provider configuration
   * @returns {string} Space-separated scope string
   */
  _buildScopes(provider) {
    const sources = provider.sources || {
      personalDrive: true,
      followedSites: true,
      teams: true
    };

    const personalDrive = sources.personalDrive !== false;
    const followedSites = sources.followedSites !== false;
    const teams = sources.teams !== false;

    // User.Read and offline_access are delegated user-consent scopes
    // and do not require admin consent.
    const scopes = ['User.Read', 'offline_access'];

    if (followedSites) {
      scopes.push('Sites.Read.All');
    }

    if (teams) {
      scopes.push('Team.ReadBasic.All', 'Channel.ReadBasic.All');
    }

    // For file content access:
    // - If SharePoint or Teams is enabled we need Files.Read.All to read
    //   drive items across all the sources the user can reach.
    // - If only personal OneDrive is enabled, Files.Read is sufficient
    //   AND avoids admin consent entirely.
    if (followedSites || teams) {
      scopes.push('Files.Read.All');
    } else if (personalDrive) {
      scopes.push('Files.Read');
    }

    return scopes.join(' ');
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
      'OFFICE365_OAUTH_REDIRECT_URI',
      req
    );

    const authUrl = `${this.authBaseUrl}/${provider.tenantId}/oauth2/v2.0/authorize`;

    const scopes = this._buildScopes(provider);

    logger.info('Office 365 OAuth scopes selected from enabled sources', {
      component: 'Office365Service',
      providerId,
      scopes,
      sources: provider.sources
    });

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
   * @param {Object} req - Express request object (optional, for auto-detecting callback URL)
   * @returns {Promise<Object>} Tokens object
   */
  async exchangeCodeForTokens(providerId, authCode, codeVerifier, req = null) {
    try {
      const provider = this._getProviderConfig(providerId);
      const tokenUrl = `${this.authBaseUrl}/${provider.tenantId}/oauth2/v2.0/token`;
      const redirectUri = this._resolveRedirectUri(
        provider,
        providerId,
        'OFFICE365_OAUTH_REDIRECT_URI',
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

      const response = await httpFetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenData
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        logger.error('Error exchanging authorization code', {
          component: 'Office365Service',
          error: errorData
        });
        throw new Error('Failed to exchange authorization code for tokens');
      }

      const tokens = await response.json();

      if (!tokens.refresh_token) {
        logger.warn('No refresh token received from Microsoft OAuth', {
          component: 'Office365Service'
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
      if (error.message === 'Failed to exchange authorization code for tokens') throw error;
      logger.error('Error exchanging authorization code', {
        component: 'Office365Service',
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
      logger.info('Attempting to refresh Office 365 access token', {
        component: 'Office365Service'
      });

      const provider = this._getProviderConfig(providerId);
      const tokenUrl = `${this.authBaseUrl}/${provider.tenantId}/oauth2/v2.0/token`;

      const tokenData = new URLSearchParams({
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        scope: this._buildScopes(provider)
      });

      const response = await httpFetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenData
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        logger.error('Error refreshing Office 365 access token', {
          component: 'Office365Service',
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
      logger.info('Office 365 token refresh successful', { component: 'Office365Service' });

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || refreshToken, // Use new or keep existing
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
      logger.error('Error refreshing Office 365 access token', {
        component: 'Office365Service',
        error
      });
      throw new Error(`Failed to refresh access token: ${error.message}`);
    }
  }

  /**
   * Office 365 also treats a 'permissions have been updated' error as a
   * pass-through condition (surfaced by the outer getUserTokens() catch).
   * @param {Error} error
   * @returns {boolean}
   */
  _isPassthroughTokenError(error) {
    return (
      super._isPassthroughTokenError(error) ||
      error.message.includes('permissions have been updated')
    );
  }

  /**
   * Microsoft Graph always expects Content-Type: application/json, even
   * for GET requests without a body.
   */
  _buildApiRequestHeaders(tokens) {
    return {
      Authorization: `Bearer ${tokens.accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    };
  }

  /**
   * Make authenticated Microsoft Graph API request
   * @param {string} endpoint - API endpoint (e.g., '/me')
   * @param {string} method - HTTP method
   * @param {Object|null} data - Request body
   * @param {string} userId - User ID
   * @param {string} [providerId] - Provider ID for per-tenant token lookup
   * @param {number} retryCount - Current retry count
   * @returns {Promise<Object>} API response
   */
  async makeApiRequest(endpoint, method = 'GET', data = null, userId, providerId, retryCount = 0) {
    return this._makeApiRequestWithRetry(
      this.graphApiUrl,
      endpoint,
      method,
      data,
      userId,
      providerId,
      retryCount
    );
  }

  /**
   * Check if user has valid Office 365 authentication
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} Authentication status
   */
  async isUserAuthenticated(userId, providerId) {
    try {
      // Try to get tokens - this will attempt refresh if expired
      await this.getUserTokens(userId, providerId);

      // Double-check by trying to make a lightweight API call
      await this.makeApiRequest('/me', 'GET', null, userId, providerId);

      logger.info('User has valid Office 365 authentication', {
        component: 'Office365Service',
        userId,
        providerId
      });
      return true;
    } catch (error) {
      logger.info('User Office 365 authentication failed', {
        component: 'Office365Service',
        userId,
        providerId,
        error
      });
      return false;
    }
  }

  /**
   * Get user's Microsoft account information
   * @param {string} userId - User ID
   * @param {string} [providerId] - Provider ID
   * @returns {Promise<Object>} User info
   */
  async getUserInfo(userId, providerId) {
    try {
      const data = await this.makeApiRequest('/me', 'GET', null, userId, providerId);

      return {
        id: data.id,
        displayName: data.displayName,
        mail: data.mail,
        userPrincipalName: data.userPrincipalName,
        jobTitle: data.jobTitle,
        officeLocation: data.officeLocation
      };
    } catch (error) {
      logger.error('Error getting Office 365 user info', {
        component: 'Office365Service',
        error
      });
      throw error;
    }
  }

  /**
   * Make batch API request to Microsoft Graph
   * Combines multiple requests into a single HTTP call (max 20 requests per batch)
   * @param {Array<{id: string, method: string, url: string}>} requests - Array of sub-requests
   * @param {string} userId - User ID
   * @returns {Promise<Array>} Array of responses with {id, status, body}
   * @private
   */
  async _makeBatchRequest(requests, userId, providerId) {
    if (!requests || requests.length === 0) {
      return [];
    }

    if (requests.length > 20) {
      throw new Error('Batch API supports maximum 20 requests per batch');
    }

    const batchPayload = {
      requests: requests.map(req => ({
        id: req.id,
        method: req.method || 'GET',
        url: req.url
      }))
    };

    const response = await this.makeApiRequest('/$batch', 'POST', batchPayload, userId, providerId);
    return response.responses || [];
  }

  /**
   * Batch get group drives for teams
   * @param {Array} teams - Array of team objects with id
   * @param {string} userId - User ID
   * @returns {Promise<Array>} Array of drive objects
   * @private
   */
  async _batchGetGroupDrives(teams, userId, providerId) {
    if (!teams || teams.length === 0) {
      return [];
    }

    const allDrives = [];
    const batchSize = 20;

    // Process teams in batches of 20
    for (let i = 0; i < teams.length; i += batchSize) {
      const teamsBatch = teams.slice(i, i + batchSize);

      // Create batch requests
      // Note: Use /groups/ endpoint because Teams are backed by Microsoft 365 Groups
      // The /teams/{id}/drive endpoint does not exist in Microsoft Graph API
      const requests = teamsBatch.map(team => ({
        id: team.id,
        method: 'GET',
        url: `/groups/${team.id}/drive`
      }));

      logger.info('Batch request for team drives', {
        component: 'Office365Service',
        count: requests.length,
        batch: Math.floor(i / batchSize) + 1
      });

      // Execute batch
      const responses = await this._makeBatchRequest(requests, userId, providerId);

      // Process responses
      for (const response of responses) {
        if (response.status === 200 && response.body) {
          const drive = response.body;
          const team = teamsBatch.find(t => t.id === response.id);

          allDrives.push({
            id: drive.id,
            name: team.displayName,
            description: team.description || team.displayName,
            driveType: 'documentLibrary',
            source: 'teams',
            teamName: team.displayName
          });
        } else if (response.status === 404) {
          // Team doesn't have a SharePoint site - this is normal, skip silently
          logger.debug('Team has no SharePoint site, skipping', {
            component: 'Office365Service',
            teamId: response.id
          });
        } else {
          // Log other errors
          logger.warn('Failed to get drive for team', {
            component: 'Office365Service',
            teamId: response.id,
            status: response.status,
            error: response.body
          });
        }
      }
    }

    logger.info('Batch processing complete', {
      component: 'Office365Service',
      teamDriveCount: allDrives.length
    });

    return allDrives;
  }

  /**
   * Fetch all pages from a paginated Microsoft Graph API endpoint
   * @param {string} endpoint - API endpoint
   * @param {string} userId - User ID
   * @returns {Promise<Array>} All values from all pages
   * @private
   */
  async _fetchAllPages(endpoint, userId, providerId) {
    const allValues = [];
    let url = endpoint;

    while (url) {
      const data = await this.makeApiRequest(url, 'GET', null, userId, providerId);
      if (data.value) {
        allValues.push(...data.value);
      }
      url = data['@odata.nextLink'] || null;
    }

    return allValues;
  }

  /**
   * List Teams drives using batch API
   * @param {string} userId - User ID
   * @returns {Promise<Array>} List of Teams drives
   */
  async listTeamsDrives(userId, providerId) {
    try {
      // Get all joined teams
      logger.info('Fetching joined teams', {
        component: 'Office365Service'
      });

      const teams = await this._fetchAllPages('/me/joinedTeams', userId, providerId);

      logger.info('Joined teams retrieved', {
        component: 'Office365Service',
        teamsCount: teams.length
      });

      if (teams.length === 0) {
        logger.warn('No teams returned from joined teams endpoint', {
          component: 'Office365Service',
          userId,
          hint: 'Verify user has Teams memberships and token has Team.ReadBasic.All scope'
        });
        return [];
      }

      // Use batch API to get team drives (no per-team limit needed)
      const teamsDrives = await this._batchGetGroupDrives(teams, userId, providerId);

      logger.info('Loaded Teams drives', {
        component: 'Office365Service',
        teamsDriveCount: teamsDrives.length,
        teamsCount: teams.length
      });

      return teamsDrives;
    } catch (error) {
      logger.error('Error listing Teams drives', {
        component: 'Office365Service',
        error
      });
      return []; // Return empty array on error to not block other drives
    }
  }

  /**
   * List personal OneDrive drives
   * @param {string} userId - User ID
   * @returns {Promise<Array>} List of personal drives
   */
  async listPersonalDrives(userId, providerId) {
    try {
      logger.info('Loading personal OneDrive drives', { component: 'Office365Service' });
      const personalDrives = await this._fetchAllPages('/me/drives', userId, providerId);

      const drives = personalDrives.map(drive => ({
        id: drive.id,
        name: drive.name,
        description: drive.description,
        driveType: drive.driveType,
        owner: drive.owner,
        source: 'personal'
      }));

      logger.info('Loaded personal drives', {
        component: 'Office365Service',
        count: drives.length
      });

      return drives;
    } catch (error) {
      logger.error('Error listing personal drives', {
        component: 'Office365Service',
        error
      });
      return []; // Return empty array on error
    }
  }

  /**
   * List SharePoint site drives
   * @param {string} userId - User ID
   * @returns {Promise<Array>} List of SharePoint drives
   */
  async listSharePointDrives(userId, providerId) {
    try {
      logger.info('Loading followed SharePoint sites', { component: 'Office365Service' });
      const allDrives = [];

      const sites = await this._fetchAllPages('/me/followedSites', userId, providerId);
      logger.info('Found followed sites', { component: 'Office365Service', count: sites.length });

      for (const site of sites) {
        try {
          const siteDrives = await this._fetchAllPages(
            `/sites/${site.id}/drives`,
            userId,
            providerId
          );
          for (const drive of siteDrives) {
            allDrives.push({
              id: drive.id,
              name: `${site.displayName} - ${drive.name}`,
              description: site.displayName,
              driveType: 'sharepoint',
              owner: drive.owner,
              source: 'sharepoint',
              siteName: site.displayName
            });
          }
        } catch (error) {
          logger.warn('Could not load drives for site', {
            component: 'Office365Service',
            siteName: site.displayName,
            error
          });
        }
      }

      logger.info('Loaded SharePoint drives', {
        component: 'Office365Service',
        count: allDrives.length
      });

      return allDrives;
    } catch (error) {
      logger.error('Error listing SharePoint drives', {
        component: 'Office365Service',
        error
      });
      return []; // Return empty array on error
    }
  }

  /**
   * List items in a drive folder
   * @param {string} userId - User ID
   * @param {string} driveId - Drive ID (optional, uses default drive if not provided)
   * @param {string} folderId - Folder ID (optional, uses root if not provided)
   * @returns {Promise<Array>} List of items
   */
  async listItems(userId, driveId = null, folderId = null, providerId) {
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

      const items = await this._fetchAllPages(endpoint, userId, providerId);

      return items.map(item => ({
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
      logger.error('Error listing items', {
        component: 'Office365Service',
        error
      });
      throw error;
    }
  }

  /**
   * Search for items in a drive
   * @param {string} userId - User ID
   * @param {string} driveId - Drive ID
   * @param {string} query - Search query
   * @returns {Promise<Array>} List of matching items
   */
  async searchItems(userId, driveId, query, providerId) {
    try {
      if (!query || query.trim().length === 0) {
        return [];
      }

      const endpoint = `/drives/${driveId}/root/search(q='${encodeURIComponent(query)}')`;
      const items = await this._fetchAllPages(endpoint, userId, providerId);

      return items.map(item => ({
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
      logger.error('Error searching items', {
        component: 'Office365Service',
        error
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
  async downloadFile(userId, fileId, driveId = null, providerId) {
    try {
      // Get file metadata first
      const endpoint = driveId ? `/drives/${driveId}/items/${fileId}` : `/me/drive/items/${fileId}`;
      const fileInfo = await this.makeApiRequest(endpoint, 'GET', null, userId, providerId);

      if (!fileInfo.file) {
        throw new Error('Item is not a file');
      }

      // Get download URL
      const downloadUrl = fileInfo['@microsoft.graph.downloadUrl'];
      if (!downloadUrl) {
        throw new Error('No download URL available for file');
      }

      // Download file content
      const tokens = await this.getUserTokens(userId, providerId);
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
      const content = await readBoundedBody(response, MAX_DOWNLOAD_BYTES, 'Office 365 download');

      return {
        id: fileInfo.id,
        name: fileInfo.name,
        mimeType: fileInfo.file.mimeType,
        size: fileInfo.size,
        content
      };
    } catch (error) {
      logger.error('Error downloading file', {
        component: 'Office365Service',
        error
      });
      throw error;
    }
  }
}

// Export singleton instance
export default new Office365Service();
