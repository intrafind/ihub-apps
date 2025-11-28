import 'dotenv/config';
import axios from 'axios';
import crypto from 'crypto';
import tokenStorage from '../TokenStorageService.js';
import { enhanceAxiosConfig } from '../../utils/httpConfig.js';

/**
 * JIRA Service for comprehensive ticket management integration
 * Provides OAuth2 PKCE authentication, secure token storage, and JIRA API access
 */
class JiraService {
  constructor() {
    this.jiraSiteUrl = process.env.JIRA_BASE_URL; // Your site URL (for reference only)
    this.clientId = process.env.JIRA_OAUTH_CLIENT_ID;
    this.clientSecret = process.env.JIRA_OAUTH_CLIENT_SECRET;
    this.redirectUri = process.env.JIRA_OAUTH_REDIRECT_URI;
    this.serviceName = 'jira';

    if (!this.jiraSiteUrl || !this.clientId || !this.clientSecret || !this.redirectUri) {
      console.warn('⚠️ JIRA OAuth configuration incomplete. Some JIRA features may not work.');
    }

    // Use Atlassian Cloud OAuth endpoints (NOT your site URL)
    this.tokenUrl = 'https://auth.atlassian.com/oauth/token';
    this.authUrl = 'https://auth.atlassian.com/authorize';
    this.resourcesUrl = 'https://api.atlassian.com/oauth/token/accessible-resources';

    // API base will be determined after getting cloudId
    this.apiUrlBase = 'https://api.atlassian.com/ex/jira';
  }

  /**
   * Generate OAuth2 authorization URL for Atlassian Cloud
   * Note: PKCE may not be fully supported by Atlassian Cloud, but we'll try
   */
  generateAuthUrl(state, codeVerifier = null) {
    const params = new URLSearchParams({
      audience: 'api.atlassian.com', // Required for Atlassian Cloud
      client_id: this.clientId,
      scope: 'read:jira-user read:jira-work write:jira-work offline_access', // offline_access is REQUIRED for refresh tokens
      redirect_uri: this.redirectUri,
      state: state,
      response_type: 'code',
      access_type: 'offline', // Explicitly request offline access for refresh tokens
      prompt: 'consent' // Force consent screen to ensure offline_access is granted
    });

    // Add PKCE parameters if provided (may be ignored by Atlassian Cloud)
    if (codeVerifier) {
      const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
      params.append('code_challenge', codeChallenge);
      params.append('code_challenge_method', 'S256');
    }

    return `${this.authUrl}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for tokens (Atlassian Cloud)
   */
  async exchangeCodeForTokens(authCode, codeVerifier = null) {
    try {
      const tokenData = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code: authCode,
        redirect_uri: this.redirectUri
      });

      // Add code_verifier only if provided (PKCE may not be supported)
      if (codeVerifier) {
        tokenData.append('code_verifier', codeVerifier);
      }

      const response = await axios.post(
        this.tokenUrl,
        tokenData,
        enhanceAxiosConfig(
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          },
          this.tokenUrl
        )
      );

      const tokens = response.data;

      if (!tokens.refresh_token) {
        console.warn('⚠️ WARNING: No refresh token received from Atlassian OAuth');
      }

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in,
        scope: tokens.scope
      };
    } catch (error) {
      console.error(
        '❌ Error exchanging authorization code:',
        error.response?.data || error.message
      );
      throw new Error('Failed to exchange authorization code for tokens');
    }
  }

  /**
   * Get accessible Atlassian resources (to find cloudId)
   */
  async getAccessibleResources(accessToken) {
    try {
      const response = await axios.get(
        this.resourcesUrl,
        enhanceAxiosConfig(
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: 'application/json'
            }
          },
          this.resourcesUrl
        )
      );

      return response.data;
    } catch (error) {
      console.error(
        '❌ Error fetching accessible resources:',
        error.response?.data || error.message
      );
      throw new Error('Failed to fetch accessible resources');
    }
  }

  /**
   * Get the JIRA cloud ID for API calls
   */
  async getJiraCloudId(accessToken) {
    const resources = await this.getAccessibleResources(accessToken);

    // Find JIRA resource
    const jiraResource = resources.find(
      resource =>
        (resource.name && resource.name.toLowerCase().includes('jira')) ||
        (resource.scopes && resource.scopes.includes('read:jira-user'))
    );

    if (!jiraResource) {
      throw new Error('No JIRA resource found in accessible resources');
    }

    return jiraResource.id;
  }

  /**
   * Build API URL for JIRA Cloud calls
   */
  async buildApiUrl(accessToken, endpoint) {
    const cloudId = await this.getJiraCloudId(accessToken);
    return `${this.apiUrlBase}/${cloudId}/rest/api/3${endpoint}`;
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(refreshToken) {
    try {
      console.log('🔄 Attempting to refresh JIRA access token...');

      const tokenData = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: refreshToken
      });

      const response = await axios.post(
        this.tokenUrl,
        tokenData,
        enhanceAxiosConfig(
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          },
          this.tokenUrl
        )
      );

      const tokens = response.data;
      console.log('✅ JIRA token refresh successful');

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || refreshToken, // Use new refresh token if provided
        expiresIn: tokens.expires_in,
        scope: tokens.scope
      };
    } catch (error) {
      const errorDetails = error.response?.data || error.message;
      console.error('❌ Error refreshing JIRA access token:', errorDetails);

      // Check if it's a specific type of error
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
   * Store encrypted user tokens using centralized token storage
   */
  async storeUserTokens(userId, tokens) {
    try {
      if (!tokens.refreshToken) {
        console.warn(
          '⚠️ WARNING: No refresh token - user will need to reconnect when access token expires'
        );
      }

      await tokenStorage.storeUserTokens(userId, this.serviceName, tokens);
      console.log(
        `✅ JIRA tokens stored for user ${userId}${!tokens.refreshToken ? ' (NO REFRESH CAPABILITY)' : ''}`
      );
      return true;
    } catch (error) {
      console.error('❌ Error storing user tokens:', error.message);
      throw new Error('Failed to store user tokens');
    }
  }

  /**
   * Retrieve and decrypt user tokens using centralized token storage
   */
  async getUserTokens(userId) {
    try {
      // Check if tokens are expired
      const expired = await tokenStorage.areTokensExpired(userId, this.serviceName);

      if (expired) {
        console.log(`🔄 Tokens expired for user ${userId}, attempting refresh...`);

        try {
          const expiredTokens = await tokenStorage.getUserTokens(userId, this.serviceName);

          if (!expiredTokens.refreshToken) {
            console.error('❌ No refresh token available for user:', userId);
            console.error('   This means the initial OAuth did not provide offline_access');
            console.error('   The user must reconnect their JIRA account to get new tokens');
            throw new Error('No refresh token available - user needs to reconnect JIRA account');
          }

          const refreshedTokens = await this.refreshAccessToken(expiredTokens.refreshToken);

          // Store the refreshed tokens
          await this.storeUserTokens(userId, refreshedTokens);
          console.log(`✅ Successfully refreshed and stored JIRA tokens for user ${userId}`);
          return refreshedTokens;
        } catch (refreshError) {
          console.error(`❌ Failed to refresh tokens for user ${userId}:`, refreshError.message);

          // If refresh fails, delete the invalid tokens so user can reconnect
          await this.deleteUserTokens(userId);

          throw new Error('JIRA authentication expired. Please reconnect your account.');
        }
      }

      return await tokenStorage.getUserTokens(userId, this.serviceName);
    } catch (error) {
      if (error.message.includes('not authenticated')) {
        throw new Error('User not authenticated with JIRA');
      }
      console.error('❌ Error retrieving user tokens:', error.message);
      throw new Error('Failed to retrieve user tokens');
    }
  }

  /**
   * Delete user tokens using centralized token storage (disconnect)
   */
  async deleteUserTokens(userId) {
    try {
      const result = await tokenStorage.deleteUserTokens(userId, this.serviceName);
      if (result) {
        console.log(`✅ JIRA tokens deleted for user ${userId}`);
      }
      return result;
    } catch (error) {
      console.error('❌ Error deleting user tokens:', error.message);
      return false;
    }
  }

  /**
   * Make authenticated JIRA Cloud API request using the cloud gateway
   */
  async makeApiRequest(endpoint, method = 'GET', data = null, userId, retryCount = 0) {
    const maxRetries = 1; // Allow one retry for token refresh

    try {
      const tokens = await this.getUserTokens(userId);

      // Build the full API URL using cloud gateway
      const apiUrl = await this.buildApiUrl(tokens.accessToken, endpoint);

      const config = {
        method,
        url: apiUrl,
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        }
      };

      if (data && (method === 'POST' || method === 'PUT')) {
        config.data = data;
      }

      const enhancedConfig = enhanceAxiosConfig(config, apiUrl);
      const response = await axios(enhancedConfig);
      return response.data;
    } catch (error) {
      if (error.response?.status === 401 && retryCount < maxRetries) {
        console.log(
          `🔄 Received 401 error, attempting to force token refresh and retry (attempt ${retryCount + 1}/${maxRetries + 1})`
        );

        try {
          // Force refresh tokens by getting them directly and refreshing them
          const expiredTokens = await tokenStorage.getUserTokens(userId, this.serviceName);

          if (!expiredTokens.refreshToken) {
            throw new Error('No refresh token available');
          }

          const refreshedTokens = await this.refreshAccessToken(expiredTokens.refreshToken);

          await this.storeUserTokens(userId, refreshedTokens);

          console.log(`✅ Forced token refresh successful for user ${userId}`);

          // Retry the request with fresh tokens
          return await this.makeApiRequest(endpoint, method, data, userId, retryCount + 1);
        } catch (refreshError) {
          console.error(`❌ Forced token refresh failed:`, refreshError.message);

          // Clean up invalid tokens
          await this.deleteUserTokens(userId);
          throw new Error('JIRA authentication expired. Please reconnect your account.');
        }
      } else if (error.response?.status === 401) {
        throw new Error('JIRA authentication required. Please reconnect your account.');
      }

      console.error('❌ JIRA API request failed:', error.response?.data || error.message);
      throw new Error(
        `JIRA API error: ${error.response?.data?.errorMessages?.[0] || error.message}`
      );
    }
  }

  /**
   * Search JIRA tickets using JQL
   */
  async searchTickets({ jql, maxResults = 50, userId }) {
    try {
      const params = new URLSearchParams({
        jql,
        maxResults: Math.min(maxResults, 100),
        fields:
          'key,summary,status,assignee,reporter,created,updated,priority,issuetype,description',
        expand: 'renderedFields'
      });

      const data = await this.makeApiRequest(`/search/jql?${params}`, 'GET', null, userId);

      return {
        total: data.total,
        startAt: data.startAt,
        maxResults: data.maxResults,
        issues: data.issues.map(issue => ({
          key: issue.key,
          summary: issue.fields.summary,
          status: issue.fields.status?.name,
          assignee: issue.fields.assignee?.displayName,
          reporter: issue.fields.reporter?.displayName,
          created: issue.fields.created,
          updated: issue.fields.updated,
          priority: issue.fields.priority?.name,
          issueType: issue.fields.issuetype?.name,
          description: issue.renderedFields?.description || issue.fields.description
        }))
      };
    } catch (error) {
      console.error('❌ Error searching JIRA tickets:', error.message);
      throw error;
    }
  }

  /**
   * Get detailed information about a JIRA ticket
   */
  async getTicket({ issueKey, includeComments = true, userId }) {
    try {
      const expand = includeComments ? 'renderedFields,comments' : 'renderedFields';
      const data = await this.makeApiRequest(
        `/issue/${issueKey}?expand=${expand}`,
        'GET',
        null,
        userId
      );

      const ticket = {
        key: data.key,
        summary: data.fields.summary,
        description: data.renderedFields?.description || data.fields.description,
        status: data.fields.status?.name,
        assignee: data.fields.assignee?.displayName,
        reporter: data.fields.reporter?.displayName,
        created: data.fields.created,
        updated: data.fields.updated,
        priority: data.fields.priority?.name,
        issueType: data.fields.issuetype?.name,
        project: data.fields.project?.name,
        labels: data.fields.labels || [],
        fixVersions: data.fields.fixVersions?.map(v => v.name) || [],
        components: data.fields.components?.map(c => c.name) || [],
        attachments:
          data.fields.attachment?.map(att => ({
            id: att.id,
            filename: att.filename,
            size: att.size,
            mimeType: att.mimeType,
            author: att.author?.displayName,
            created: att.created
          })) || []
      };

      if (includeComments && data.fields.comment?.comments) {
        ticket.comments = data.fields.comment.comments.map(comment => ({
          id: comment.id,
          author: comment.author?.displayName,
          body: comment.body,
          created: comment.created,
          updated: comment.updated
        }));
      }

      return ticket;
    } catch (error) {
      console.error('❌ Error getting JIRA ticket:', error.message);
      throw error;
    }
  }

  /**
   * Add a comment to a JIRA ticket
   */
  async addComment({ issueKey, comment, userId }) {
    try {
      // JIRA Cloud requires comments in Atlassian Document Format (ADF)
      const commentData = {
        body: {
          version: 1,
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: comment
                }
              ]
            }
          ]
        }
      };

      const response = await this.makeApiRequest(
        `/issue/${issueKey}/comment`,
        'POST',
        commentData,
        userId
      );

      return {
        id: response.id,
        author: response.author?.displayName,
        body: response.body,
        created: response.created
      };
    } catch (error) {
      console.error('❌ Error adding comment to JIRA ticket:', error.message);
      throw error;
    }
  }

  /**
   * Get available transitions for a ticket
   */
  async getTransitions({ issueKey, userId }) {
    try {
      const data = await this.makeApiRequest(`/issue/${issueKey}/transitions`, 'GET', null, userId);

      return {
        transitions: data.transitions.map(transition => ({
          id: transition.id,
          name: transition.name,
          to: {
            id: transition.to.id,
            name: transition.to.name,
            description: transition.to.description
          }
        }))
      };
    } catch (error) {
      console.error('❌ Error getting JIRA ticket transitions:', error.message);
      throw error;
    }
  }

  /**
   * Transition a ticket to a new status
   */
  async transitionTicket({ issueKey, transitionId, comment = null, userId }) {
    try {
      const transitionData = {
        transition: {
          id: parseInt(transitionId, 10) // Convert to integer as required by JIRA API
        }
      };

      if (comment) {
        // JIRA Cloud requires comments in Atlassian Document Format (ADF)
        transitionData.update = {
          comment: [
            {
              add: {
                body: {
                  version: 1,
                  type: 'doc',
                  content: [
                    {
                      type: 'paragraph',
                      content: [
                        {
                          type: 'text',
                          text: comment
                        }
                      ]
                    }
                  ]
                }
              }
            }
          ]
        };
      }

      await this.makeApiRequest(`/issue/${issueKey}/transitions`, 'POST', transitionData, userId);

      // Get updated ticket information
      const updatedTicket = await this.getTicket({ issueKey, includeComments: false, userId });

      return {
        success: true,
        newStatus: updatedTicket.status,
        message: `Ticket ${issueKey} successfully transitioned to ${updatedTicket.status}`
      };
    } catch (error) {
      console.error('❌ Error transitioning JIRA ticket:', error.message);
      throw error;
    }
  }

  /**
   * Get attachment content for proxy streaming
   */
  async getAttachmentProxy({ attachmentId, userId }) {
    try {
      const tokens = await this.getUserTokens(userId);

      // Get attachment metadata using the cloud API
      const apiUrl = await this.buildApiUrl(tokens.accessToken, `/attachment/${attachmentId}`);
      const response = await axios.get(
        apiUrl,
        enhanceAxiosConfig(
          {
            headers: {
              Authorization: `Bearer ${tokens.accessToken}`,
              Accept: 'application/json'
            }
          },
          apiUrl
        )
      );

      const attachmentInfo = response.data;

      // Get attachment content as stream
      const contentResponse = await axios.get(
        attachmentInfo.content,
        enhanceAxiosConfig(
          {
            headers: {
              Authorization: `Bearer ${tokens.accessToken}`,
              Accept: '*/*'
            },
            responseType: 'stream',
            timeout: 60000 // 60 second timeout for large files
          },
          attachmentInfo.content
        )
      );

      return {
        filename: attachmentInfo.filename,
        mimeType: attachmentInfo.mimeType,
        size: attachmentInfo.size,
        stream: contentResponse.data
      };
    } catch (error) {
      console.error('❌ Error getting JIRA attachment for proxy:', error.message);
      throw error;
    }
  }

  /**
   * Get attachment content
   */
  async getAttachment({ attachmentId, returnBase64 = false, userId }) {
    try {
      const tokens = await this.getUserTokens(userId);

      // Get attachment metadata using the cloud API
      const apiUrl = await this.buildApiUrl(tokens.accessToken, `/attachment/${attachmentId}`);
      const response = await axios.get(
        apiUrl,
        enhanceAxiosConfig(
          {
            headers: {
              Authorization: `Bearer ${tokens.accessToken}`,
              Accept: 'application/json'
            }
          },
          apiUrl
        )
      );

      const attachmentInfo = response.data;

      console.log(`📎 Attachment metadata for ${attachmentId}:`, {
        filename: attachmentInfo.filename,
        mimeType: attachmentInfo.mimeType,
        size: attachmentInfo.size,
        content: attachmentInfo.content
      });

      // JIRA Cloud API returns attachment content URLs that need special handling
      let contentUrl = attachmentInfo.content;

      // Validate and potentially fix the content URL
      if (!contentUrl || !contentUrl.startsWith('http')) {
        throw new Error(`Invalid attachment content URL: ${contentUrl}`);
      }

      console.log(`📎 Downloading attachment: ${attachmentInfo.filename} from ${contentUrl}`);

      // Get attachment content with proper authorization
      const contentResponse = await axios.get(
        contentUrl,
        enhanceAxiosConfig(
          {
            headers: {
              Authorization: `Bearer ${tokens.accessToken}`,
              Accept: '*/*'
            },
            responseType: returnBase64 ? 'arraybuffer' : 'stream',
            timeout: 30000 // 30 second timeout for large files
          },
          contentUrl
        )
      );

      if (returnBase64) {
        const base64Content = Buffer.from(contentResponse.data).toString('base64');
        return {
          filename: attachmentInfo.filename,
          mimeType: attachmentInfo.mimeType,
          size: attachmentInfo.size,
          content: base64Content
        };
      } else {
        return {
          filename: attachmentInfo.filename,
          mimeType: attachmentInfo.mimeType,
          size: attachmentInfo.size,
          downloadUrl: contentUrl
        };
      }
    } catch (error) {
      console.error('❌ Error getting JIRA attachment:', error.message);

      // Provide more detailed error information
      if (error.response) {
        console.error('❌ Response status:', error.response.status);
        console.error('❌ Response data:', error.response.data);
      }

      throw error;
    }
  }

  /**
   * Check if user has valid JIRA authentication
   * This method attempts to get tokens and refresh if needed
   */
  async isUserAuthenticated(userId) {
    try {
      // Try to get tokens - this will attempt refresh if expired
      await this.getUserTokens(userId);

      // Double-check by trying to make a lightweight API call
      await this.makeApiRequest('/myself', 'GET', null, userId);

      console.log(`✅ User ${userId} has valid JIRA authentication`);
      return true;
    } catch (error) {
      console.log(`❌ User ${userId} authentication failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Get user's JIRA account information
   */
  async getUserInfo(userId) {
    try {
      const data = await this.makeApiRequest('/myself', 'GET', null, userId);

      return {
        accountId: data.accountId,
        displayName: data.displayName,
        emailAddress: data.emailAddress,
        avatarUrls: data.avatarUrls,
        active: data.active,
        accountType: data.accountType
      };
    } catch (error) {
      console.error('❌ Error getting JIRA user info:', error.message);
      throw error;
    }
  }

  /**
   * Get token expiration info for monitoring
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
}

// Export singleton instance
export default new JiraService();
