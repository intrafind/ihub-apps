import 'dotenv/config';
import axios from 'axios';
import crypto from 'crypto';
import tokenStorage from '../TokenStorageService.js';
import { enhanceAxiosConfig } from '../../utils/httpConfig.js';
import logger from '../../utils/logger.js';
import configCache from '../../configCache.js';

/**
 * Office 365 Service for Microsoft 365 file access integration
 * Provides OAuth 2.0 authentication with PKCE, secure token storage, and Microsoft Graph API access
 */
class Office365Service {
  constructor() {
    this.serviceName = 'office365';

    // Microsoft Identity Platform endpoints
    this.authBaseUrl = 'https://login.microsoftonline.com';
    this.graphApiUrl = 'https://graph.microsoft.com/v1.0';

    logger.info('🔵 Office365Service initialized', { component: 'Office 365' });
  }

  /**
   * Build callback URL from request
   * @param {Object} req - Express request object
   * @param {string} providerId - Provider ID to include in callback URL
   * @returns {string} Full callback URL
   */
  _buildCallbackUrl(req, providerId) {
    // Get protocol - consider X-Forwarded-Proto for reverse proxy setups
    const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';

    // Get host - consider X-Forwarded-Host for reverse proxy setups
    const host = req.get('x-forwarded-host') || req.get('host');

    if (!host) {
      throw new Error('Unable to determine host for callback URL');
    }

    // Build full callback URL with provider ID
    // Note: serviceName is included in the route mount point (/api/integrations/office365)
    return `${protocol}://${host}/api/integrations/${this.serviceName}/${providerId}/callback`;
  }

  /**
   * Get Office 365 provider configuration
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
      p => p.id === providerId && p.type === 'office365' && p.enabled !== false
    );

    if (!provider) {
      throw new Error(`Office 365 provider '${providerId}' not found or not enabled`);
    }

    if (!provider.tenantId || !provider.clientId || !provider.clientSecret) {
      throw new Error(
        `Office 365 provider '${providerId}' missing required configuration (tenantId, clientId, clientSecret)`
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

    // Use the provider's redirect URI, environment variable, auto-detected URL, or fallback to localhost
    let redirectUri = provider.redirectUri || process.env.OFFICE365_OAUTH_REDIRECT_URI;

    if (!redirectUri && req) {
      // Auto-detect from request if not configured
      redirectUri = this._buildCallbackUrl(req, providerId);
      logger.info('🔗 Auto-detected Office 365 callback URL from request', {
        component: 'Office 365',
        redirectUri
      });
    }

    if (!redirectUri) {
      // Final fallback to localhost (development)
      redirectUri = `${process.env.SERVER_URL || 'http://localhost:3000'}/api/integrations/${this.serviceName}/${providerId}/callback`;
      logger.warn('⚠️ Using fallback localhost URL for Office 365 callback', {
        component: 'Office 365',
        redirectUri
      });
    }

    const authUrl = `${this.authBaseUrl}/${provider.tenantId}/oauth2/v2.0/authorize`;

    // Microsoft Graph API scopes for file access
    const scopes = [
      'User.Read', // Basic user info
      'Files.Read.All', // Read files in all site collections
      'Sites.Read.All', // Read items in all site collections
      'Team.ReadBasic.All', // Read Teams information
      'Channel.ReadBasic.All', // Read Teams channel information
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
   * @param {Object} req - Express request object (optional, for auto-detecting callback URL)
   * @returns {Promise<Object>} Tokens object
   */
  async exchangeCodeForTokens(providerId, authCode, codeVerifier, req = null) {
    try {
      const provider = this._getProviderConfig(providerId);
      const tokenUrl = `${this.authBaseUrl}/${provider.tenantId}/oauth2/v2.0/token`;

      // Use the provider's redirect URI, environment variable, auto-detected URL, or fallback to localhost
      let redirectUri = provider.redirectUri || process.env.OFFICE365_OAUTH_REDIRECT_URI;

      if (!redirectUri && req) {
        // Auto-detect from request if not configured
        redirectUri = this._buildCallbackUrl(req, providerId);
        logger.info('🔗 Auto-detected Office 365 callback URL from request for token exchange', {
          component: 'Office 365',
          redirectUri
        });
      }

      if (!redirectUri) {
        // Final fallback to localhost (development)
        redirectUri = `${process.env.SERVER_URL || 'http://localhost:3000'}/api/integrations/${this.serviceName}/${providerId}/callback`;
        logger.warn('⚠️ Using fallback localhost URL for Office 365 token exchange', {
          component: 'Office 365',
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
          component: 'Office 365'
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
        component: 'Office 365',
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
      logger.info('🔄 Attempting to refresh Office 365 access token...', {
        component: 'Office 365'
      });

      const provider = this._getProviderConfig(providerId);
      const tokenUrl = `${this.authBaseUrl}/${provider.tenantId}/oauth2/v2.0/token`;

      const tokenData = new URLSearchParams({
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        scope:
          'User.Read Files.Read.All Sites.Read.All Team.ReadBasic.All Channel.ReadBasic.All offline_access'
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
      logger.info('✅ Office 365 token refresh successful', { component: 'Office 365' });

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || refreshToken, // Use new or keep existing
        expiresIn: tokens.expires_in,
        scope: tokens.scope,
        providerId: providerId
      };
    } catch (error) {
      const errorDetails = error.response?.data || error.message;
      logger.error('❌ Error refreshing Office 365 access token:', {
        component: 'Office 365',
        error: errorDetails
      });

      if (error.response?.status === 400) {
        const errorData = error.response.data;
        if (errorData.error === 'invalid_grant') {
          throw new Error('Refresh token expired or invalid - user needs to reconnect');
        }
        throw new Error(`Token refresh failed: ${errorData.error_description || errorData.error}`);
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
          { component: 'Office 365' }
        );
      }

      await tokenStorage.storeUserTokens(userId, this.serviceName, tokens);
      logger.info(`✅ Office 365 tokens stored for user ${userId}`, {
        component: 'Office 365',
        providerId: tokens.providerId
      });
      return true;
    } catch (error) {
      logger.error('❌ Error storing user tokens:', {
        component: 'Office 365',
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
      // First, get the tokens to check their scope
      let tokens = await tokenStorage.getUserTokens(userId, this.serviceName);

      // Check if tokens have old scope (Group.Read.All) from before admin rights removal
      // These tokens need to be invalidated so user can re-authenticate with new scopes
      if (tokens.scope && tokens.scope.includes('Group.Read.All')) {
        logger.warn(
          `⚠️ Detected old Office 365 token with Group.Read.All scope for user ${userId}. Invalidating tokens to force re-authentication with new scopes.`,
          {
            component: 'Office 365',
            oldScope: tokens.scope
          }
        );

        // Delete the old tokens
        await this.deleteUserTokens(userId);

        throw new Error(
          'Office 365 permissions have been updated. Please reconnect your account to continue accessing Teams drives.'
        );
      }

      // Check if tokens are expired
      const expired = await tokenStorage.areTokensExpired(userId, this.serviceName);

      if (expired) {
        logger.info(`🔄 Tokens expired for user ${userId}, attempting refresh...`, {
          component: 'Office 365'
        });

        try {
          if (!tokens.refreshToken) {
            logger.error('❌ No refresh token available for user:', {
              component: 'Office 365',
              userId
            });
            throw new Error(
              'No refresh token available - user needs to reconnect Office 365 account'
            );
          }

          const refreshedTokens = await this.refreshAccessToken(
            tokens.providerId,
            tokens.refreshToken
          );

          // Store the refreshed tokens
          await this.storeUserTokens(userId, refreshedTokens);
          logger.info(`✅ Successfully refreshed and stored Office 365 tokens for user ${userId}`, {
            component: 'Office 365'
          });
          return refreshedTokens;
        } catch (refreshError) {
          logger.error(`❌ Failed to refresh tokens for user ${userId}:`, {
            component: 'Office 365',
            error: refreshError.message
          });

          // If refresh fails, delete the invalid tokens so user can reconnect
          await this.deleteUserTokens(userId);

          throw new Error('Office 365 authentication expired. Please reconnect your account.');
        }
      }

      return tokens;
    } catch (error) {
      // Don't wrap specific error messages - pass them through
      if (
        error.message.includes('not authenticated') ||
        error.message.includes('permissions have been updated') ||
        error.message.includes('authentication expired')
      ) {
        throw error;
      }
      logger.error('❌ Error retrieving user tokens:', {
        component: 'Office 365',
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
        logger.info(`✅ Office 365 tokens deleted for user ${userId}`, {
          component: 'Office 365'
        });
      }
      return result;
    } catch (error) {
      logger.error('❌ Error deleting user tokens:', {
        component: 'Office 365',
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
          { component: 'Office 365' }
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
            component: 'Office 365'
          });

          // Retry the request with fresh tokens
          return await this.makeApiRequest(endpoint, method, data, userId, retryCount + 1);
        } catch (refreshError) {
          logger.error(`❌ Forced token refresh failed:`, {
            component: 'Office 365',
            error: refreshError.message
          });

          // Clean up invalid tokens
          await this.deleteUserTokens(userId);
          throw new Error('Office 365 authentication expired. Please reconnect your account.');
        }
      } else if (error.response?.status === 401) {
        throw new Error('Office 365 authentication required. Please reconnect your account.');
      } else if (error.response?.status === 429) {
        // Rate limit exceeded - log and throw
        const retryAfter = error.response?.headers?.['retry-after'] || 'unknown';
        logger.warn(`⏱️ Rate limit exceeded. Retry after: ${retryAfter} seconds`, {
          component: 'Office 365',
          endpoint
        });
        throw new Error('Office 365 API rate limit exceeded. Please try again in a moment.');
      }

      // Log 404 errors as debug (expected for Teams without SharePoint sites, etc.)
      if (error.response?.status === 404) {
        logger.debug('Office 365 API returned 404 (not found):', {
          component: 'Office 365',
          endpoint,
          error: error.response?.data?.error?.message || 'Resource not found'
        });
        throw new Error(
          `Office 365 API error: ${error.response?.data?.error?.message || error.message}`
        );
      }

      // Log other errors as error
      logger.error('❌ Office 365 API request failed:', {
        component: 'Office 365',
        error: error.response?.data || error.message
      });
      throw new Error(
        `Office 365 API error: ${error.response?.data?.error?.message || error.message}`
      );
    }
  }

  /**
   * Check if user has valid Office 365 authentication
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} Authentication status
   */
  async isUserAuthenticated(userId) {
    try {
      // Try to get tokens - this will attempt refresh if expired
      await this.getUserTokens(userId);

      // Double-check by trying to make a lightweight API call
      await this.makeApiRequest('/me', 'GET', null, userId);

      logger.info(`✅ User ${userId} has valid Office 365 authentication`, {
        component: 'Office 365'
      });
      return true;
    } catch (error) {
      logger.info(`❌ User ${userId} authentication failed:`, {
        component: 'Office 365',
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
      logger.error('❌ Error getting Office 365 user info:', {
        component: 'Office 365',
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
   * Make batch API request to Microsoft Graph
   * Combines multiple requests into a single HTTP call (max 20 requests per batch)
   * @param {Array<{id: string, method: string, url: string}>} requests - Array of sub-requests
   * @param {string} userId - User ID
   * @returns {Promise<Array>} Array of responses with {id, status, body}
   * @private
   */
  async _makeBatchRequest(requests, userId) {
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

    const response = await this.makeApiRequest('/$batch', 'POST', batchPayload, userId);
    return response.responses || [];
  }

  /**
   * Batch get group drives for teams
   * @param {Array} teams - Array of team objects with id
   * @param {string} userId - User ID
   * @returns {Promise<Array>} Array of drive objects
   * @private
   */
  async _batchGetGroupDrives(teams, userId) {
    if (!teams || teams.length === 0) {
      return [];
    }

    const allDrives = [];
    const batchSize = 20;

    // Process teams in batches of 20
    for (let i = 0; i < teams.length; i += batchSize) {
      const teamsBatch = teams.slice(i, i + batchSize);

      // Create batch requests
      const requests = teamsBatch.map(team => ({
        id: team.id,
        method: 'GET',
        url: `/teams/${team.id}/drive`
      }));

      logger.info(
        `📦 Batch request for ${requests.length} team drives (batch ${Math.floor(i / batchSize) + 1})`,
        {
          component: 'Office 365'
        }
      );

      // Execute batch
      const responses = await this._makeBatchRequest(requests, userId);

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
          logger.debug(`Team ${response.id} has no SharePoint site (404), skipping`, {
            component: 'Office 365'
          });
        } else {
          // Log other errors
          logger.warn(`Failed to get drive for team ${response.id}: ${response.status}`, {
            component: 'Office 365',
            error: response.body
          });
        }
      }
    }

    logger.info(`✅ Batch processing complete - ${allDrives.length} team drives retrieved`, {
      component: 'Office 365'
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
  async _fetchAllPages(endpoint, userId) {
    const allValues = [];
    let url = endpoint;

    while (url) {
      const data = await this.makeApiRequest(url, 'GET', null, userId);
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
  async listTeamsDrives(userId) {
    try {
      // Get all joined teams
      logger.info('🔍 Fetching joined teams from /me/joinedTeams...', {
        component: 'Office 365'
      });
      
      const teams = await this._fetchAllPages('/me/joinedTeams', userId);
      
      logger.info(`👥 /me/joinedTeams returned ${teams.length} teams`, {
        component: 'Office 365',
        teamsCount: teams.length
      });

      if (teams.length === 0) {
        logger.warn(
          '⚠️ No teams returned from /me/joinedTeams. This could mean: 1) User is not a member of any Teams, 2) API permissions issue, or 3) API bug. Verify user has Teams memberships and token has Team.ReadBasic.All scope.',
          {
            component: 'Office 365',
            userId
          }
        );
        return [];
      }

      // Use batch API to get team drives (no per-team limit needed)
      const teamsDrives = await this._batchGetGroupDrives(teams, userId);

      logger.info(`✅ Loaded ${teamsDrives.length} Teams drives from ${teams.length} teams`, {
        component: 'Office 365'
      });

      return teamsDrives;
    } catch (error) {
      logger.error('❌ Error listing Teams drives:', {
        component: 'Office 365',
        error: error.message,
        stack: error.stack
      });
      return []; // Return empty array on error to not block other drives
    }
  }

  /**
   * List personal OneDrive drives
   * @param {string} userId - User ID
   * @returns {Promise<Array>} List of personal drives
   */
  async listPersonalDrives(userId) {
    try {
      logger.info('📁 Loading personal OneDrive drives...', { component: 'Office 365' });
      const personalDrives = await this._fetchAllPages('/me/drives', userId);

      const drives = personalDrives.map(drive => ({
        id: drive.id,
        name: drive.name,
        description: drive.description,
        driveType: drive.driveType,
        owner: drive.owner,
        source: 'personal'
      }));

      logger.info(`✅ Loaded ${drives.length} personal drives`, {
        component: 'Office 365'
      });

      return drives;
    } catch (error) {
      logger.error('❌ Error listing personal drives:', {
        component: 'Office 365',
        error: error.message
      });
      return []; // Return empty array on error
    }
  }

  /**
   * List SharePoint site drives
   * @param {string} userId - User ID
   * @returns {Promise<Array>} List of SharePoint drives
   */
  async listSharePointDrives(userId) {
    try {
      logger.info('🌐 Loading followed SharePoint sites...', { component: 'Office 365' });
      const allDrives = [];

      const sites = await this._fetchAllPages('/me/followedSites', userId);
      logger.info(`📋 Found ${sites.length} followed sites`, { component: 'Office 365' });

      for (const site of sites) {
        try {
          const siteDrives = await this._fetchAllPages(`/sites/${site.id}/drives`, userId);
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
        } catch (e) {
          logger.warn(`Could not load drives for site ${site.displayName}:`, {
            error: e.message
          });
        }
      }

      logger.info(`✅ Loaded ${allDrives.length} SharePoint drives`, {
        component: 'Office 365'
      });

      return allDrives;
    } catch (error) {
      logger.error('❌ Error listing SharePoint drives:', {
        component: 'Office 365',
        error: error.message
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

      const items = await this._fetchAllPages(endpoint, userId);

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
      logger.error('❌ Error listing items:', {
        component: 'Office 365',
        error: error.message
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
  async searchItems(userId, driveId, query) {
    try {
      if (!query || query.trim().length === 0) {
        return [];
      }

      const endpoint = `/drives/${driveId}/root/search(q='${encodeURIComponent(query)}')`;
      const items = await this._fetchAllPages(endpoint, userId);

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
      logger.error('❌ Error searching items:', {
        component: 'Office 365',
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
        component: 'Office 365',
        error: error.message
      });
      throw error;
    }
  }
}

// Export singleton instance
export default new Office365Service();
