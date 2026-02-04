// DEPRECATED: This file has been moved to services/integrations/EntraService.js
// This wrapper is maintained for backward compatibility

import entraService from '../services/integrations/EntraService.js';

/**
 * Find a user by name in Microsoft Entra (Azure AD)
 * @param {Object} params - The search parameters
 * @param {string} params.name - The name to search for
 * @returns {Promise<Object>} The matching user(s)
 */
export async function findUser({ name }) {
  return entraService.findUser(name);
}

/**
 * Get all details for a specific user
 * @param {Object} params - The parameters
 * @param {string} params.userId - The user ID
 * @returns {Promise<Object>} The user details
 */
export async function getAllUserDetails({ userId }) {
  return entraService.getAllUserDetails(userId);
}

/**
 * Get the manager of a specific user
 * @param {Object} params - The parameters
 * @param {string} params.userId - The user ID
 * @returns {Promise<Object>} The user's manager
 */
export async function getUserManager({ userId }) {
  return entraService.getUserManager(userId);
}

/**
 * Get the groups a user belongs to
 * @param {Object} params - The parameters
 * @param {string} params.userId - The user ID
 * @returns {Promise<Object>} The user's groups
 */
export async function getUserGroups({ userId }) {
  return entraService.getUserGroups(userId);
}

/**
 * Get members of a specific team
 * @param {Object} params - The parameters
 * @param {string} params.teamId - The team ID
 * @returns {Promise<Object>} The team members
 */
export async function getTeamMembers({ teamId }) {
  return entraService.getTeamMembers(teamId);
}

/**
 * Get a user's profile photo as base64
 * @param {Object} params - The parameters
 * @param {string} params.userId - The user ID
 * @returns {Promise<string>} The photo as base64 string
 */
export async function getUserPhotoBase64({ userId }) {
  return entraService.getUserPhotoBase64(userId);
}

/**
 * Get channels for a specific team
 * @param {Object} params - The parameters
 * @param {string} params.teamId - The team ID
 * @returns {Promise<Object>} The team channels
 */
export async function getTeamChannels({ teamId }) {
  return entraService.getTeamChannels(teamId);
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
