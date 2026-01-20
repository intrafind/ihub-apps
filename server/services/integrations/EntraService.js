import 'dotenv/config';
import axios from 'axios';
import { enhanceAxiosConfig } from '../../utils/httpConfig.js';

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

    console.log('EntraService: No valid token found, fetching a new one...');
    const params = new URLSearchParams();
    params.append('client_id', this.clientId);
    params.append('scope', 'https://graph.microsoft.com/.default');
    params.append('client_secret', this.clientSecret);
    params.append('grant_type', 'client_credentials');

    try {
      const axiosConfig = enhanceAxiosConfig(
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        },
        this.tokenUrl
      );
      const response = await axios.post(this.tokenUrl, params, axiosConfig);
      const tokenData = response.data;
      this.accessToken = tokenData.access_token;
      this.tokenExpiry = Date.now() + tokenData.expires_in * 1000;
      console.log('EntraService: ✅ Token acquired');
      return this.accessToken;
    } catch (error) {
      console.error('❌ Error fetching access token:', error.response?.data || error.message);
      throw new Error('Failed to acquire access token.');
    }
  }

  async _makeGraphRequest(endpoint, options = {}) {
    const token = await this._getAccessToken();
    const url = `${this.graphUrl}${endpoint}`;
    try {
      const axiosConfig = enhanceAxiosConfig(
        {
          headers: { Authorization: `Bearer ${token}` },
          ...options
        },
        url
      );
      const response = await axios.get(url, axiosConfig);
      return response.data;
    } catch (error) {
      if (error.response?.status === 404) {
        console.log(`EntraService: Resource not found at endpoint: ${endpoint}`);
        return null;
      }
      console.error(
        `❌ Error calling Graph API endpoint ${endpoint}:`,
        error.response?.data || error.message
      );
      return null;
    }
  }

  async findUser(name) {
    console.log(`EntraService: Searching for user: ${name}`);
    const encodedName = encodeURIComponent(name);
    const endpoint = `/users?$filter=startswith(displayName,'${encodedName}') or startswith(mail,'${encodedName}')&$select=id,displayName,mail,jobTitle,department,officeLocation`;
    const result = await this._makeGraphRequest(endpoint);
    return result?.value[0] || null;
  }

  async getAllUserDetails(userId) {
    console.log(`EntraService: Getting all details for user ID: ${userId}`);
    return this._makeGraphRequest(`/users/${userId}`);
  }

  async getUserManager(userId) {
    console.log(`EntraService: Getting manager for user ID: ${userId}`);
    return this._makeGraphRequest(`/users/${userId}/manager`);
  }

  async getUserPhotoBase64(userId) {
    console.log(`EntraService: Getting photo for user ID: ${userId}`);
    const photoBuffer = await this._makeGraphRequest(`/users/${userId}/photo/$value`, {
      responseType: 'arraybuffer'
    });
    return photoBuffer ? Buffer.from(photoBuffer).toString('base64') : null;
  }

  async getUserGroups(userId) {
    console.log(`EntraService: Getting groups for user ID: ${userId}`);
    const endpoint = `/users/${userId}/memberOf?$select=id,displayName,description,resourceProvisioningOptions`;
    const result = await this._makeGraphRequest(endpoint);
    const teams = result?.value.filter(group =>
      group.resourceProvisioningOptions?.includes('Team')
    );
    return teams || [];
  }

  async getTeamMembers(groupId) {
    console.log(`EntraService: Getting members for group ID: ${groupId}`);
    const endpoint = `/groups/${groupId}/members?$select=id,displayName,jobTitle`;
    const result = await this._makeGraphRequest(endpoint);
    return result?.value || [];
  }

  async getTeamChannels(teamId) {
    console.log(`EntraService: Getting channels for team ID: ${teamId}`);
    const result = await this._makeGraphRequest(`/teams/${teamId}/channels`);
    return result?.value || [];
  }
}

// Export singleton instance
export default new EntraService();
