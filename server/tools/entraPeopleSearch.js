import 'dotenv/config';
import axios from 'axios';

class GraphApiToolAxios {
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

    console.log('TOOL: No valid token found, fetching a new one...');
    const params = new URLSearchParams();
    params.append('client_id', this.clientId);
    params.append('scope', 'https://graph.microsoft.com/.default');
    params.append('client_secret', this.clientSecret);
    params.append('grant_type', 'client_credentials');

    try {
      const response = await axios.post(this.tokenUrl, params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      const tokenData = response.data;
      this.accessToken = tokenData.access_token;
      this.tokenExpiry = Date.now() + tokenData.expires_in * 1000;
      console.log('TOOL: ✅ Token acquired');
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
      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        ...options
      });
      return response.data;
    } catch (error) {
      if (error.response?.status === 404) {
        console.log(`TOOL: Resource not found at endpoint: ${endpoint}`);
        return null;
      }
      console.error(`❌ Error calling Graph API endpoint ${endpoint}:`, error.response?.data || error.message);
      return null;
    }
  }

  async findUser(name) {
    console.log(`TOOL: Searching for user: ${name}`);
    const encodedName = encodeURIComponent(name);
    const endpoint = `/users?$filter=startswith(displayName,'${encodedName}') or startswith(mail,'${encodedName}')&$select=id,displayName,mail,jobTitle,department,officeLocation`;
    const result = await this._makeGraphRequest(endpoint);
    return result?.value[0] || null;
  }

  async getAllUserDetails(userId) {
    console.log(`TOOL: Getting all details for user ID: ${userId}`);
    return this._makeGraphRequest(`/users/${userId}`);
  }

  async getUserManager(userId) {
    console.log(`TOOL: Getting manager for user ID: ${userId}`);
    return this._makeGraphRequest(`/users/${userId}/manager`);
  }

  async getUserPhotoBase64(userId) {
    console.log(`TOOL: Getting photo for user ID: ${userId}`);
    const photoBuffer = await this._makeGraphRequest(`/users/${userId}/photo/$value`, {
      responseType: 'arraybuffer'
    });
    return photoBuffer ? Buffer.from(photoBuffer).toString('base64') : null;
  }

  async getUserGroups(userId) {
    console.log(`TOOL: Getting groups for user ID: ${userId}`);
    const endpoint = `/users/${userId}/memberOf?$select=id,displayName,description,resourceProvisioningOptions`;
    const result = await this._makeGraphRequest(endpoint);
    const teams = result?.value.filter(group => group.resourceProvisioningOptions?.includes('Team'));
    return teams || [];
  }

  async getTeamMembers(groupId) {
    console.log(`TOOL: Getting members for group ID: ${groupId}`);
    const endpoint = `/groups/${groupId}/members?$select=id,displayName,jobTitle`;
    const result = await this._makeGraphRequest(endpoint);
    return result?.value || [];
  }

  async getTeamChannels(teamId) {
    console.log(`TOOL: Getting channels for team ID: ${teamId}`);
    const result = await this._makeGraphRequest(`/teams/${teamId}/channels`);
    return result?.value || [];
  }
}

const api = new GraphApiToolAxios();

export async function findUser({ name }) {
  return api.findUser(name);
}

export async function getAllUserDetails({ userId }) {
  return api.getAllUserDetails(userId);
}

export async function getUserManager({ userId }) {
  return api.getUserManager(userId);
}

export async function getUserGroups({ userId }) {
  return api.getUserGroups(userId);
}

export async function getTeamMembers({ teamId }) {
  return api.getTeamMembers(teamId);
}

export async function getUserPhotoBase64({ userId }) {
  return api.getUserPhotoBase64(userId);
}

export async function getTeamChannels({ teamId }) {
  return api.getTeamChannels(teamId);
}

export default {
  findUser,
  getAllUserDetails,
  getUserManager,
  getUserGroups,
  getTeamMembers,
  getUserPhotoBase64,
  getTeamChannels
};
=======
// graphToolAxios.js

require('dotenv').config();
const axios = require('axios');

class GraphApiToolAxios {
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

    /**
     * @private
     * Gets and caches an OAuth2 access token.
     * If a valid, non-expired token exists, it returns the cached one.
     * Otherwise, it fetches a new one.
     */
    async _getAccessToken() {
        // If we have a token and it's not expiring in the next 60 seconds, reuse it.
        if (this.accessToken && this.tokenExpiry && this.tokenExpiry > Date.now() + 60000) {
            return this.accessToken;
        }

        console.log('TOOL: No valid token found, fetching a new one...');
        const params = new URLSearchParams();
        params.append('client_id', this.clientId);
        params.append('scope', 'https://graph.microsoft.com/.default');
        params.append('client_secret', this.clientSecret);
        params.append('grant_type', 'client_credentials');

        try {
            const response = await axios.post(this.tokenUrl, params, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });

            const tokenData = response.data;
            this.accessToken = tokenData.access_token;
            // Set expiry to a future timestamp (response.expires_in is in seconds)
            this.tokenExpiry = Date.now() + tokenData.expires_in * 1000;
            console.log('TOOL: ✅ Token acquired');
            return this.accessToken;
        } catch (error) {
            console.error('❌ Error fetching access token:', error.response?.data || error.message);
            throw new Error('Failed to acquire access token.');
        }
    }
    
    /**
     * @private
     * A generic helper to make authenticated requests to the Graph API.
     */
    async _makeGraphRequest(endpoint, options = {}) {
        const token = await this._getAccessToken();
        const url = `${this.graphUrl}${endpoint}`;

        try {
            const response = await axios.get(url, {
                headers: { Authorization: `Bearer ${token}` },
                ...options, // Spread any additional axios options (like responseType)
            });
            return response.data;
        } catch (error) {
            // Handle 404 gracefully for calls that might not find a resource
            if (error.response?.status === 404) {
                console.log(`TOOL: Resource not found at endpoint: ${endpoint}`);
                return null;
            }
            console.error(`❌ Error calling Graph API endpoint ${endpoint}:`, error.response?.data || error.message);
            return null;
        }
    }
    
    // --- Public Tool Methods for AI ---

    /**
     * Finds a user by their display name or email.
     * @param {string} name - The name or email to search for.
     * @returns {Promise<object|null>} The user object or null if not found.
     */
    async findUser(name) {
        console.log(`TOOL: Searching for user: ${name}`);
        const encodedName = encodeURIComponent(name);
        const endpoint = `/users?$filter=startswith(displayName,'${encodedName}') or startswith(mail,'${encodedName}')&$select=id,displayName,mail,jobTitle,department,officeLocation`;
        const result = await this._makeGraphRequest(endpoint);
        return result?.value[0] || null; // Return the first match
    }

    /**
     * Gets all available details for a specific user.
     * @param {string} userId - The user's ID.
     * @returns {Promise<object|null>} A comprehensive user object.
     */
    async getAllUserDetails(userId) {
        console.log(`TOOL: Getting all details for user ID: ${userId}`);
        return this._makeGraphRequest(`/users/${userId}`);
    }
    
    /**
     * Gets a user's manager.
     * @param {string} userId - The user's ID.
     * @returns {Promise<object|null>} The manager object.
     */
    async getUserManager(userId) {
        console.log(`TOOL: Getting manager for user ID: ${userId}`);
        return this._makeGraphRequest(`/users/${userId}/manager`);
    }
    
    /**
     * Gets the user's profile photo as a Base64 string.
     * @param {string} userId - The user's ID.
     * @returns {Promise<string|null>} Base64 encoded image string or null.
     */
    async getUserPhotoBase64(userId) {
        console.log(`TOOL: Getting photo for user ID: ${userId}`);
        // This endpoint returns binary data, so we need to set responseType
        const photoBuffer = await this._makeGraphRequest(`/users/${userId}/photo/$value`, {
            responseType: 'arraybuffer'
        });
        return photoBuffer ? Buffer.from(photoBuffer).toString('base64') : null;
    }

    /**
     * Lists all groups and teams a user is a member of.
     * @param {string} userId - The user's ID.
     * @returns {Promise<Array<object>>} An array of group/team objects.
     */
    async getUserGroups(userId) {
        console.log(`TOOL: Getting groups for user ID: ${userId}`);
        const endpoint = `/users/${userId}/memberOf?$select=id,displayName,description,resourceProvisioningOptions`;
        const result = await this._makeGraphRequest(endpoint);
        // We can filter here to return only objects that are Microsoft Teams
        const teams = result?.value.filter(group => group.resourceProvisioningOptions?.includes('Team'));
        return teams || [];
    }

    /**
     * Gets all members of a specific team/group.
     * @param {string} groupId - The group's ID.
     * @returns {Promise<Array<object>>} An array of user objects.
     */
    async getTeamMembers(groupId) {
        console.log(`TOOL: Getting members for group ID: ${groupId}`);
        const endpoint = `/groups/${groupId}/members?$select=id,displayName,jobTitle`;
        const result = await this._makeGraphRequest(endpoint);
        return result?.value || [];
    }

    /**
     * Gets all channels in a Team that the application can see.
     * @param {string} teamId - The team's ID.
     * @returns {Promise<Array<object>>} An array of channel objects.
     */
    async getTeamChannels(teamId) {
        console.log(`TOOL: Getting channels for team ID: ${teamId}`);
        const result = await this._makeGraphRequest(`/teams/${teamId}/channels`);
        return result?.value || [];
    }
}

// --- DEMONSTRATION OF HOW TO USE THE TOOL ---
async function main() {
    const tool = new GraphApiToolAxios();
    const userName = "Daniel Manzke"; // Change this to a user in your directory

    console.log(`\n--- Query: who is ${userName}? ---`);
    const user = await tool.findUser(userName);

    if (!user) {
        console.log(`Could not find a user named ${userName}. Exiting.`);
        return;
    }
    
    console.log('Found User:', user);
    
    console.log(`\n--- Query: give me all information you have about ${userName} ---`);
    const allDetails = await tool.getAllUserDetails(user.id);
    console.log('All Details:', {
        displayName: allDetails.displayName,
        jobTitle: allDetails.jobTitle,
        mail: allDetails.mail,
        officeLocation: allDetails.officeLocation
    });

    console.log(`\n--- Query: who is the manager of ${userName}? ---`);
    const manager = await tool.getUserManager(user.id);
    console.log('Manager:', manager ? manager.displayName : 'No manager found.');
    
    console.log(`\n--- Query: in which team is he? ---`);
    const teams = await tool.getUserGroups(user.id);
    console.log('Teams:', teams.map(t => t.displayName));
    
    if (teams.length > 0) {
        console.log(`\n--- Query: who else is in the team "${teams[0].displayName}"? ---`);
        const members = await tool.getTeamMembers(teams[0].id);
        console.log('Team Members:', members.map(m => m.displayName));
    }

    console.log(`\n--- Query: do you have a picture of ${userName}? ---`);
    const photo = await tool.getUserPhotoBase64(user.id);
    console.log('Photo available:', photo ? `Yes, Base64 data starts with: ${photo.substring(0, 30)}...` : 'No photo found.');
}

main().catch(error => console.error(error));