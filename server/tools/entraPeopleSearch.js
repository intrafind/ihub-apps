// DEPRECATED: This file has been moved to services/integrations/EntraService.js
// This wrapper is maintained for backward compatibility

import entraService from '../services/integrations/EntraService.js';

export async function findUser({ name }) {
  return entraService.findUser(name);
}

export async function getAllUserDetails({ userId }) {
  return entraService.getAllUserDetails(userId);
}

export async function getUserManager({ userId }) {
  return entraService.getUserManager(userId);
}

export async function getUserGroups({ userId }) {
  return entraService.getUserGroups(userId);
}

export async function getTeamMembers({ teamId }) {
  return entraService.getTeamMembers(teamId);
}

export async function getUserPhotoBase64({ userId }) {
  return entraService.getUserPhotoBase64(userId);
}

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
