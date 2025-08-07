import 'dotenv/config';
import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

/**
 * JIRA Service for comprehensive ticket management integration
 * Provides OAuth2 PKCE authentication, secure token storage, and JIRA API access
 */
class JiraService {
  constructor() {
    this.baseUrl = process.env.JIRA_BASE_URL;
    this.clientId = process.env.JIRA_OAUTH_CLIENT_ID;
    this.clientSecret = process.env.JIRA_OAUTH_CLIENT_SECRET;
    this.redirectUri = process.env.JIRA_OAUTH_REDIRECT_URI;
    this.encryptionKey = process.env.TOKEN_ENCRYPTION_KEY;

    if (!this.baseUrl || !this.clientId || !this.clientSecret || !this.redirectUri) {
      console.warn('⚠️ JIRA OAuth configuration incomplete. Some JIRA features may not work.');
    }

    // Initialize encryption key if not provided
    if (!this.encryptionKey) {
      this.encryptionKey = crypto.randomBytes(32).toString('hex');
      console.warn('⚠️ Using generated encryption key. Set TOKEN_ENCRYPTION_KEY for production.');
    }

    this.tokenUrl = `${this.baseUrl}/oauth/token`;
    this.authUrl = `${this.baseUrl}/oauth/authorize`;
    this.apiUrl = `${this.baseUrl}/rest/api/2`;
  }

  /**
   * Generate OAuth2 authorization URL with PKCE
   */
  generateAuthUrl(state, codeVerifier) {
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      state: state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      scope: 'read:jira-user read:jira-work write:jira-work'
    });

    return `${this.authUrl}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for tokens using PKCE
   */
  async exchangeCodeForTokens(authCode, codeVerifier) {
    try {
      const response = await axios.post(
        this.tokenUrl,
        {
          grant_type: 'authorization_code',
          client_id: this.clientId,
          client_secret: this.clientSecret,
          code: authCode,
          redirect_uri: this.redirectUri,
          code_verifier: codeVerifier
        },
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      const tokens = response.data;
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in,
        scope: tokens.scope
      };
    } catch (error) {
      console.error('❌ Error exchanging authorization code:', error.response?.data || error.message);
      throw new Error('Failed to exchange authorization code for tokens');
    }
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(refreshToken) {
    try {
      const response = await axios.post(
        this.tokenUrl,
        {
          grant_type: 'refresh_token',
          client_id: this.clientId,
          client_secret: this.clientSecret,
          refresh_token: refreshToken
        },
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      const tokens = response.data;
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || refreshToken, // Use new refresh token if provided
        expiresIn: tokens.expires_in,
        scope: tokens.scope
      };
    } catch (error) {
      console.error('❌ Error refreshing access token:', error.response?.data || error.message);
      throw new Error('Failed to refresh access token');
    }
  }

  /**
   * Encrypt token data for secure storage
   */
  encryptTokens(tokens) {
    try {
      const algorithm = 'aes-256-gcm';
      const key = Buffer.from(this.encryptionKey, 'hex');
      const iv = crypto.randomBytes(16);

      const cipher = crypto.createCipherGCM(algorithm, key, iv);

      let encrypted = cipher.update(JSON.stringify(tokens), 'utf8', 'hex');
      encrypted += cipher.final('hex');

      const authTag = cipher.getAuthTag();

      return {
        encrypted,
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex')
      };
    } catch (error) {
      console.error('❌ Error encrypting tokens:', error.message);
      throw new Error('Failed to encrypt tokens');
    }
  }

  /**
   * Decrypt token data from storage
   */
  decryptTokens(encryptedData) {
    try {
      const algorithm = 'aes-256-gcm';
      const key = Buffer.from(this.encryptionKey, 'hex');
      const iv = Buffer.from(encryptedData.iv, 'hex');

      const decipher = crypto.createDecipherGCM(algorithm, key, iv);
      decipher.setAuthTag(Buffer.from(encryptedData.authTag, 'hex'));

      let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return JSON.parse(decrypted);
    } catch (error) {
      console.error('❌ Error decrypting tokens:', error.message);
      throw new Error('Failed to decrypt tokens');
    }
  }

  /**
   * Store encrypted user tokens
   */
  async storeUserTokens(userId, tokens) {
    try {
      const encryptedTokens = this.encryptTokens(tokens);
      const tokenData = {
        userId,
        ...encryptedTokens,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString()
      };

      // Store in contents/integrations/jira directory
      const tokenDir = path.join(process.cwd(), 'contents', 'integrations', 'jira');
      await fs.mkdir(tokenDir, { recursive: true });

      const tokenFile = path.join(tokenDir, `${userId}.json`);
      await fs.writeFile(tokenFile, JSON.stringify(tokenData, null, 2));

      console.log(`✅ JIRA tokens stored for user ${userId}`);
      return true;
    } catch (error) {
      console.error('❌ Error storing user tokens:', error.message);
      throw new Error('Failed to store user tokens');
    }
  }

  /**
   * Retrieve and decrypt user tokens
   */
  async getUserTokens(userId) {
    try {
      const tokenFile = path.join(process.cwd(), 'contents', 'integrations', 'jira', `${userId}.json`);
      const tokenData = JSON.parse(await fs.readFile(tokenFile, 'utf8'));

      // Check if tokens are expired
      const expiresAt = new Date(tokenData.expiresAt);
      const now = new Date();

      if (expiresAt <= now) {
        console.log(`🔄 Tokens expired for user ${userId}, attempting refresh...`);
        
        const decryptedTokens = this.decryptTokens(tokenData);
        const refreshedTokens = await this.refreshAccessToken(decryptedTokens.refreshToken);
        
        // Store the refreshed tokens
        await this.storeUserTokens(userId, refreshedTokens);
        return refreshedTokens;
      }

      return this.decryptTokens(tokenData);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error('User not authenticated with JIRA');
      }
      console.error('❌ Error retrieving user tokens:', error.message);
      throw new Error('Failed to retrieve user tokens');
    }
  }

  /**
   * Delete user tokens (disconnect)
   */
  async deleteUserTokens(userId) {
    try {
      const tokenFile = path.join(process.cwd(), 'contents', 'integrations', 'jira', `${userId}.json`);
      await fs.unlink(tokenFile);
      console.log(`✅ JIRA tokens deleted for user ${userId}`);
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('❌ Error deleting user tokens:', error.message);
      }
      return false;
    }
  }

  /**
   * Make authenticated JIRA API request
   */
  async makeApiRequest(endpoint, method = 'GET', data = null, userId) {
    try {
      const tokens = await this.getUserTokens(userId);
      
      const config = {
        method,
        url: `${this.apiUrl}${endpoint}`,
        headers: {
          'Authorization': `Bearer ${tokens.accessToken}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      };

      if (data && (method === 'POST' || method === 'PUT')) {
        config.data = data;
      }

      const response = await axios(config);
      return response.data;
    } catch (error) {
      if (error.response?.status === 401) {
        throw new Error('JIRA authentication required. Please reconnect your account.');
      }
      
      console.error('❌ JIRA API request failed:', error.response?.data || error.message);
      throw new Error(`JIRA API error: ${error.response?.data?.errorMessages?.[0] || error.message}`);
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
        fields: 'key,summary,status,assignee,reporter,created,updated,priority,issuetype,description',
        expand: 'renderedFields'
      });

      const data = await this.makeApiRequest(`/search?${params}`, 'GET', null, userId);
      
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
      const data = await this.makeApiRequest(`/issue/${issueKey}?expand=${expand}`, 'GET', null, userId);
      
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
        attachments: data.fields.attachment?.map(att => ({
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
      const commentData = {
        body: comment
      };

      const response = await this.makeApiRequest(`/issue/${issueKey}/comment`, 'POST', commentData, userId);
      
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
          id: transitionId
        }
      };

      if (comment) {
        transitionData.update = {
          comment: [
            {
              add: {
                body: comment
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
   * Get attachment content
   */
  async getAttachment({ attachmentId, returnBase64 = false, userId }) {
    try {
      const tokens = await this.getUserTokens(userId);
      
      const response = await axios.get(`${this.baseUrl}/rest/api/2/attachment/${attachmentId}`, {
        headers: {
          'Authorization': `Bearer ${tokens.accessToken}`
        }
      });

      const attachmentInfo = response.data;
      
      // Get attachment content
      const contentResponse = await axios.get(attachmentInfo.content, {
        headers: {
          'Authorization': `Bearer ${tokens.accessToken}`
        },
        responseType: returnBase64 ? 'arraybuffer' : 'stream'
      });

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
          downloadUrl: attachmentInfo.content
        };
      }
    } catch (error) {
      console.error('❌ Error getting JIRA attachment:', error.message);
      throw error;
    }
  }

  /**
   * Check if user has valid JIRA authentication
   */
  async isUserAuthenticated(userId) {
    try {
      await this.getUserTokens(userId);
      return true;
    } catch (error) {
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
}

// Export singleton instance
export default new JiraService();