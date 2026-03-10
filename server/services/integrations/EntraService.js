import 'dotenv/config';
import { httpFetch } from '../../utils/httpConfig.js';
import logger from '../../utils/logger.js';

/**
 * Entra ID (Azure AD) Service for Microsoft Graph API integration
 * Provides user search, profile data, and team information functionality
 */
class EntraService {
  constructor() {
    this.clientId = process.env.AZURE_CLIENT_ID;
    this.clientSecret = process.env.AZURE_CLIENT_SECRET;
    this.tenantId = process.env.AZURE_TENANT_ID;

    if (!this.clientId || !this.clientSecret || !this.tenantId) {
      throw new Error('Missing Azure credentials in environment variables.');
    }

    this.tokenUrl = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
    this.graphUrl = 'https://graph.microsoft.com/v1.0';
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  async _getAccessToken() {
    if (this.accessToken && this.tokenExpiry && this.tokenExpiry > Date.now() + 60000) {
      return this.accessToken;
    }

    logger.info('EntraService: No valid token found, fetching a new one...');
    const params = new URLSearchParams();
    params.append('client_id', this.clientId);
    params.append('scope', 'https://graph.microsoft.com/.default');
    params.append('client_secret', this.clientSecret);
    params.append('grant_type', 'client_credentials');

    try {
      const response = await httpFetch(this.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        logger.error('❌ Error fetching access token:', errorData);
        throw new Error('Failed to acquire access token.');
      }

      const tokenData = await response.json();
      this.accessToken = tokenData.access_token;
      this.tokenExpiry = Date.now() + tokenData.expires_in * 1000;
      logger.info('EntraService: ✅ Token acquired');
      return this.accessToken;
    } catch (error) {
      if (error.message === 'Failed to acquire access token.') throw error;
      logger.error('❌ Error fetching access token:', error.message);
      throw new Error('Failed to acquire access token.');
    }
  }

  async _makeGraphRequest(endpoint, options = {}) {
    const token = await this._getAccessToken();
    const url = `${this.graphUrl}${endpoint}`;
    try {
      const response = await httpFetch(url, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!response.ok) {
        if (response.status === 404) {
          logger.info(`EntraService: Resource not found at endpoint: ${endpoint}`);
          return null;
        }
        const errorData = await response.json().catch(() => ({}));
        logger.error(`❌ Error calling Graph API endpoint ${endpoint}:`, errorData);
        return null;
      }

      if (options.responseType === 'arraybuffer') {
        return await response.arrayBuffer();
      }
      return await response.json();
    } catch (error) {
      logger.error(`❌ Error calling Graph API endpoint ${endpoint}:`, error.message);
      return null;
    }
  }

  async findUser(name) {
    logger.info(`EntraService: Searching for user: ${name}`);
    const encodedName = encodeURIComponent(name);
    const endpoint = `/users?$filter=startswith(displayName,'${encodedName}') or startswith(mail,'${encodedName}')&$select=id,displayName,mail,jobTitle,department,officeLocation`;
    const result = await this._makeGraphRequest(endpoint);
    return result?.value[0] || null;
  }

  async getAllUserDetails(userId) {
    logger.info(`EntraService: Getting all details for user ID: ${userId}`);
    return this._makeGraphRequest(`/users/${userId}`);
  }

  async getUserManager(userId) {
    logger.info(`EntraService: Getting manager for user ID: ${userId}`);
    return this._makeGraphRequest(`/users/${userId}/manager`);
  }

  async getUserPhotoBase64(userId) {
    logger.info(`EntraService: Getting photo for user ID: ${userId}`);
    const photoBuffer = await this._makeGraphRequest(`/users/${userId}/photo/$value`, {
      responseType: 'arraybuffer'
    });
    return photoBuffer ? Buffer.from(photoBuffer).toString('base64') : null;
  }

  async getUserGroups(userId) {
    logger.info(`EntraService: Getting groups for user ID: ${userId}`);
    const endpoint = `/users/${userId}/memberOf?$select=id,displayName,description,resourceProvisioningOptions`;
    const result = await this._makeGraphRequest(endpoint);
    const teams = result?.value.filter(group =>
      group.resourceProvisioningOptions?.includes('Team')
    );
    return teams || [];
  }

  async getTeamMembers(groupId) {
    logger.info(`EntraService: Getting members for group ID: ${groupId}`);
    const endpoint = `/groups/${groupId}/members?$select=id,displayName,jobTitle`;
    const result = await this._makeGraphRequest(endpoint);
    return result?.value || [];
  }

  async getTeamChannels(teamId) {
    logger.info(`EntraService: Getting channels for team ID: ${teamId}`);
    const result = await this._makeGraphRequest(`/teams/${teamId}/channels`);
    return result?.value || [];
  }
}

// Export singleton instance
export default new EntraService();
