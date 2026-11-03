// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import tokenStorage from '../TokenStorageService.js';
import { httpFetch } from '../../utils/httpConfig.js';
import { JIRA_INSTANCE_ID, getJiraConfig, isJiraConfigured } from './jiraConfig.js';
import credentialService from '../CredentialService.js';
import logger from '../../utils/logger.js';
import { isUnavailableError } from './oauthRefreshError.js';
import { createFixedEndpointStrategy } from './auth/strategies/fixedEndpoint.js';
import { getIntegrationConnectionService } from './auth/IntegrationConnectionService.js';
import { isIntegrationAuthRequired } from './auth/integrationAuthRequired.js';
import { tokenStorageIdFor } from './auth/tokenSecrets.js';
import { ATLASSIAN_ISSUER } from './auth/connectionProviders.js';

/** What a Jira sign-in asks for; `offline_access` is required for a refresh token. */
const JIRA_SCOPES = Object.freeze([
  'read:jira-user',
  'read:jira-work',
  'write:jira-work',
  'offline_access'
]);

/**
 * JIRA Service for comprehensive ticket management integration: the Jira
 * Cloud API as the signed-in user. The user's Atlassian connection (OAuth 2.0
 * with PKCE, token storage, refresh, disconnect) runs through the shared
 * OAuth client and the connection service; this service declares Atlassian's
 * endpoints (`oauthStrategy`) and calls the API.
 */
class JiraService {
  constructor() {
    this.serviceName = 'jira';

    // Use Atlassian Cloud OAuth endpoints (NOT your site URL)
    this.tokenUrl = 'https://auth.atlassian.com/oauth/token';
    this.authUrl = 'https://auth.atlassian.com/authorize';
    this.resourcesUrl = 'https://api.atlassian.com/oauth/token/accessible-resources';

    // API base will be determined after getting cloudId
    this.apiUrlBase = 'https://api.atlassian.com/ex/jira';
  }

  /**
   * The Jira settings of the installed integration `jira` (see jiraConfig.js).
   * @returns {Object} Jira config with baseUrl, clientId, clientSecretRef, redirectUri, enabled
   */
  getConfig() {
    return getJiraConfig();
  }

  /**
   * Check if Jira is fully configured and enabled.
   * @returns {boolean} True if enabled and has required OAuth credentials
   */
  isConfigured() {
    return isJiraConfigured(this.getConfig());
  }

  /**
   * Atlassian Cloud's authorization server for the shared OAuth client
   * (`auth/OAuthUserClient.js`): OAuth 2.0 (3LO) with PKCE, the Jira scopes
   * plus `offline_access` (so a refresh token is issued), the
   * `api.atlassian.com` audience and a consent prompt. The sign-in, the token
   * exchange, storage, refresh and disconnect run through the connection
   * service; this only says where and as whom.
   * @returns {import('./auth/OAuthUserClient.js').OAuthStrategy}
   * @throws {Error} When the installation has no client id
   */
  oauthStrategy() {
    const jiraConfig = this.getConfig();
    return createFixedEndpointStrategy({
      id: 'fixed:jira',
      issuer: ATLASSIAN_ISSUER,
      authorizationEndpoint: this.authUrl,
      tokenEndpoint: this.tokenUrl,
      clientId: jiraConfig.clientId,
      clientSecret: () => credentialService.resolveSecret(jiraConfig.clientSecretRef),
      scopes: JIRA_SCOPES,
      extraAuthorizationParams: {
        audience: 'api.atlassian.com',
        access_type: 'offline',
        prompt: 'consent'
      }
    });
  }

  /**
   * Get accessible Atlassian resources (to find cloudId)
   */
  async getAccessibleResources(accessToken) {
    try {
      const response = await httpFetch(this.resourcesUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json'
        }
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        logger.error('Error fetching accessible resources', {
          component: 'JiraService',
          error: errorData
        });
        throw new Error('Failed to fetch accessible resources');
      }

      return await response.json();
    } catch (error) {
      if (error.message === 'Failed to fetch accessible resources') throw error;
      logger.error('Error fetching accessible resources', { component: 'JiraService', error });
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
   * The user's Atlassian tokens, refreshed when they expired (or after a
   * 401 with `forceRefresh`). The connection service owns the lifecycle: a
   * refused refresh token ends the connection, a temporary failure keeps it.
   * @param {string} userId
   * @param {Object} [options]
   * @param {boolean} [options.forceRefresh]
   * @param {string} [options.usedAccessToken]
   * @returns {Promise<{accessToken: string, refreshToken?: string, expiresIn?: number, scope?: string}>}
   * @throws {IntegrationAuthRequiredError} `User not authenticated with JIRA` / `JIRA authentication expired. …`
   */
  async getUserTokens(userId, options = {}) {
    try {
      return await getIntegrationConnectionService().getUserTokens({
        installationId: JIRA_INSTANCE_ID,
        userId,
        ...options
      });
    } catch (error) {
      if (isIntegrationAuthRequired(error) || isUnavailableError(error)) throw error;
      logger.error('Error retrieving user tokens', { component: 'JiraService', error });
      throw new Error('Failed to retrieve user tokens');
    }
  }

  /**
   * Disconnect the user's Atlassian account (audit `connection.revoke`).
   * @param {string} userId
   * @param {import('express').Request} [req] - For the audit entry
   * @returns {Promise<boolean>} Whether tokens were removed
   */
  async deleteUserTokens(userId, req) {
    try {
      const { removed } = await getIntegrationConnectionService().disconnect({
        installationId: JIRA_INSTANCE_ID,
        userId,
        req
      });
      return removed;
    } catch (error) {
      logger.error('Error deleting user tokens', { component: 'JiraService', error });
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

      const fetchOptions = {
        method,
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        }
      };

      if (data && (method === 'POST' || method === 'PUT')) {
        fetchOptions.body = JSON.stringify(data);
      }

      const response = await httpFetch(apiUrl, fetchOptions);

      if (!response.ok) {
        if (response.status === 401 && retryCount < maxRetries) {
          logger.info('Received 401 error, attempting to force token refresh and retry', {
            component: 'JiraService',
            attempt: retryCount + 1,
            maxAttempts: maxRetries + 1
          });

          // A refused refresh token ends the connection inside the service
          // (and surfaces as "authentication expired"); a temporary failure
          // keeps the tokens.
          await this.getUserTokens(userId, {
            forceRefresh: true,
            usedAccessToken: tokens.accessToken
          });
          return await this.makeApiRequest(endpoint, method, data, userId, retryCount + 1);
        } else if (response.status === 401) {
          throw new Error('JIRA authentication required. Please reconnect your account.');
        }

        const errorData = await response.json().catch(() => ({}));
        logger.error('JIRA API request failed', { component: 'JiraService', error: errorData });
        throw new Error(`JIRA API error: ${errorData.errorMessages?.[0] || response.statusText}`);
      }

      if (response.status === 204) return null;
      return await response.json();
    } catch (error) {
      // Re-throw known errors
      if (
        isIntegrationAuthRequired(error) ||
        isUnavailableError(error) ||
        error.message.includes('JIRA authentication') ||
        error.message.includes('JIRA API error')
      ) {
        throw error;
      }
      logger.error('JIRA API request failed', { component: 'JiraService', error });
      throw new Error(`JIRA API error: ${error.message}`);
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
      logger.error('Error searching JIRA tickets', { component: 'JiraService', error });
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
      logger.error('Error getting JIRA ticket', { component: 'JiraService', error });
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
      logger.error('Error adding comment to JIRA ticket', { component: 'JiraService', error });
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
      logger.error('Error getting JIRA ticket transitions', { component: 'JiraService', error });
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
          id: Number.parseInt(transitionId, 10) // Convert to integer as required by JIRA API
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
      logger.error('Error transitioning JIRA ticket', { component: 'JiraService', error });
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
      const metaResponse = await httpFetch(apiUrl, {
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          Accept: 'application/json'
        }
      });

      if (!metaResponse.ok) {
        throw new Error(`Failed to get attachment metadata: ${metaResponse.statusText}`);
      }

      const attachmentInfo = await metaResponse.json();

      // Get attachment content as stream
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000);
      const contentResponse = await httpFetch(attachmentInfo.content, {
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          Accept: '*/*'
        },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!contentResponse.ok) {
        throw new Error(`Failed to download attachment: ${contentResponse.statusText}`);
      }

      return {
        filename: attachmentInfo.filename,
        mimeType: attachmentInfo.mimeType,
        size: attachmentInfo.size,
        stream: contentResponse.body
      };
    } catch (error) {
      logger.error('Error getting JIRA attachment for proxy', { component: 'JiraService', error });
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
      const metaResponse = await httpFetch(apiUrl, {
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          Accept: 'application/json'
        }
      });

      if (!metaResponse.ok) {
        throw new Error(`Failed to get attachment metadata: ${metaResponse.statusText}`);
      }

      const attachmentInfo = await metaResponse.json();

      logger.info('Attachment metadata retrieved', {
        component: 'JiraService',
        attachmentId,
        filename: attachmentInfo.filename,
        mimeType: attachmentInfo.mimeType,
        size: attachmentInfo.size
      });

      // JIRA Cloud API returns attachment content URLs that need special handling
      let contentUrl = attachmentInfo.content;

      // Validate and potentially fix the content URL
      if (!contentUrl || !contentUrl.startsWith('http')) {
        throw new Error(`Invalid attachment content URL: ${contentUrl}`);
      }

      logger.info('Downloading attachment', {
        component: 'JiraService',
        filename: attachmentInfo.filename,
        contentUrl
      });

      // Get attachment content with proper authorization
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      let contentResponse;
      try {
        contentResponse = await httpFetch(contentUrl, {
          headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
            Accept: '*/*'
          },
          signal: controller.signal
        });

        if (!contentResponse.ok) {
          throw new Error(`Failed to download attachment: ${contentResponse.statusText}`);
        }

        if (returnBase64) {
          // Keep timeout active until body is fully consumed
          const buffer = Buffer.from(await contentResponse.arrayBuffer());
          const base64Content = buffer.toString('base64');
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
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      logger.error('Error getting JIRA attachment', { component: 'JiraService', error });
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

      logger.info('User has valid JIRA authentication', { component: 'JiraService', userId });
      return true;
    } catch (error) {
      logger.info('User JIRA authentication failed', { component: 'JiraService', userId, error });
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
      logger.error('Error getting JIRA user info', { component: 'JiraService', error });
      throw error;
    }
  }

  /**
   * Get token expiration info for monitoring
   */
  async getTokenExpirationInfo(userId) {
    try {
      const metadata = await tokenStorage.getTokenMetadata(
        tokenStorageIdFor(userId),
        this.serviceName
      );
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
