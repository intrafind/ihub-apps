// Tool functions for the Microsoft Entra ID directory. The Graph client lives in
// services/integrations/EntraService.js.

/**
 * The Entra service, loaded on first use. It reads its Azure credentials from
 * the environment when it is created and throws without them, so importing it
 * here would make this whole script fail to load on every installation that
 * does not use Entra (and be reported by the startup tool check). A call on
 * such an installation still fails, with the service's own message.
 * @returns {Promise<Object>} The Entra service
 */
async function getEntraService() {
  const { default: entraService } = await import('../services/integrations/EntraService.js');
  return entraService;
}

/**
 * Find a user by name in Microsoft Entra (Azure AD)
 * @param {Object} params - The search parameters
 * @param {string} params.name - The name to search for
 * @returns {Promise<Object>} The matching user(s)
 */
export async function findUser({ name }) {
  return (await getEntraService()).findUser(name);
}

/**
 * Get all details for a specific user
 * @param {Object} params - The parameters
 * @param {string} params.userId - The user ID
 * @returns {Promise<Object>} The user details
 */
export async function getAllUserDetails({ userId }) {
  return (await getEntraService()).getAllUserDetails(userId);
}

/**
 * Get the manager of a specific user
 * @param {Object} params - The parameters
 * @param {string} params.userId - The user ID
 * @returns {Promise<Object>} The user's manager
 */
export async function getUserManager({ userId }) {
  return (await getEntraService()).getUserManager(userId);
}

/**
 * Get the groups a user belongs to
 * @param {Object} params - The parameters
 * @param {string} params.userId - The user ID
 * @returns {Promise<Object>} The user's groups
 */
export async function getUserGroups({ userId }) {
  return (await getEntraService()).getUserGroups(userId);
}

/**
 * Get members of a specific team
 * @param {Object} params - The parameters
 * @param {string} params.teamId - The team ID
 * @returns {Promise<Object>} The team members
 */
export async function getTeamMembers({ teamId }) {
  return (await getEntraService()).getTeamMembers(teamId);
}

/**
 * Get a user's profile photo as base64
 * @param {Object} params - The parameters
 * @param {string} params.userId - The user ID
 * @returns {Promise<string>} The photo as base64 string
 */
export async function getUserPhotoBase64({ userId }) {
  return (await getEntraService()).getUserPhotoBase64(userId);
}

/**
 * Get channels for a specific team
 * @param {Object} params - The parameters
 * @param {string} params.teamId - The team ID
 * @returns {Promise<Object>} The team channels
 */
export async function getTeamChannels({ teamId }) {
  return (await getEntraService()).getTeamChannels(teamId);
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
