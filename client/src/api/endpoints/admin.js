import { apiClient } from '../client';
import { handleApiResponse } from '../utils/requestHandler';
import { DEFAULT_CACHE_TTL } from '../../utils/cache';
import cache from '../../utils/cache';

// Admin usage data
export const fetchUsageData = async () => {
  return handleApiResponse(() => apiClient.get('/admin/usage'), null, null, false);
};

// Admin API functions
export const fetchAdminPrompts = async (options = {}) => {
  const { skipCache = false } = options;
  const cacheKey = skipCache ? null : 'admin_prompts';

  return handleApiResponse(
    () => {
      const headers = {};

      // Add ETag header if we have cached data
      if (cacheKey) {
        const cachedData = cache.get(cacheKey);
        if (cachedData && cachedData.etag) {
          headers['If-None-Match'] = cachedData.etag;
        }
      }

      return apiClient.get('/admin/prompts', { headers });
    },
    cacheKey,
    DEFAULT_CACHE_TTL.SHORT, // Shorter TTL for admin data
    true,
    true // Enable ETag handling
  );
};

export const createPrompt = async promptData => {
  return handleApiResponse(() => apiClient.post('/admin/prompts', promptData), null, null, false);
};

export const updatePrompt = async (promptId, promptData) => {
  return handleApiResponse(
    () => apiClient.put(`/admin/prompts/${promptId}`, promptData),
    null,
    null,
    false
  );
};

export const deletePrompt = async promptId => {
  return handleApiResponse(() => apiClient.delete(`/admin/prompts/${promptId}`), null, null, false);
};

export const togglePrompt = async promptId => {
  return handleApiResponse(
    () => apiClient.post(`/admin/prompts/${promptId}/toggle`),
    null,
    null,
    false
  );
};

export const fetchAdminApps = async (options = {}) => {
  const { skipCache = false } = options;
  const cacheKey = skipCache ? null : 'admin_apps';

  return handleApiResponse(() => apiClient.get('/admin/apps'), cacheKey, DEFAULT_CACHE_TTL.SHORT);
};

export const fetchTools = async (options = {}) => {
  const { skipCache = false, language = null } = options;
  const cacheKey = skipCache ? null : 'admin_tools';

  const params = {};
  if (language) {
    params.language = language;
  }

  return handleApiResponse(
    () => apiClient.get('/admin/tools', { params }),
    cacheKey,
    DEFAULT_CACHE_TTL.SHORT
  );
};

// ---------------------------------------------------------------------------
// Admin skill endpoints
// ---------------------------------------------------------------------------

/**
 * Fetch all skills for the admin panel with optional ETag caching.
 * Follows the same pattern as fetchTools.
 *
 * @param {Object} [options] - Request options
 * @param {boolean} [options.skipCache=false] - Whether to bypass the cache
 * @returns {Promise<Array>} Array of skill objects
 */
export const fetchAdminSkills = async (options = {}) => {
  const { skipCache = false } = options;
  const cacheKey = skipCache ? null : 'admin_skills';

  const data = await handleApiResponse(
    () => {
      const headers = {};

      // Add ETag header if we have cached data
      if (cacheKey) {
        const cachedData = cache.get(cacheKey);
        if (cachedData && cachedData.etag) {
          headers['If-None-Match'] = cachedData.etag;
        }
      }

      return apiClient.get('/admin/skills', { headers });
    },
    cacheKey,
    DEFAULT_CACHE_TTL.SHORT,
    true,
    true // Enable ETag handling
  );

  // Server returns { skills: [...], settings: {...} }
  const skills = data?.skills ?? data;
  return Array.isArray(skills) ? skills : [];
};

/**
 * Fetch detailed information for a single skill by name.
 *
 * @param {string} skillName - The unique name identifier of the skill
 * @returns {Promise<Object>} The skill detail object
 */
export const fetchAdminSkillDetail = async skillName => {
  return handleApiResponse(
    () => apiClient.get(`/admin/skills/${encodeURIComponent(skillName)}`),
    null,
    null,
    false
  );
};

/**
 * Update an existing skill's configuration.
 *
 * @param {string} skillName - The unique name identifier of the skill to update
 * @param {Object} data - The updated skill data
 * @returns {Promise<Object>} The updated skill object
 */
export const updateSkill = async (skillName, data) => {
  return handleApiResponse(
    () => apiClient.put(`/admin/skills/${encodeURIComponent(skillName)}`, data),
    null,
    null,
    false
  );
};

/**
 * Toggle the enabled/disabled state of a skill.
 *
 * @param {string} skillName - The unique name identifier of the skill to toggle
 * @returns {Promise<Object>} The toggled skill object with updated enabled state
 */
export const toggleSkill = async skillName => {
  return handleApiResponse(
    () => apiClient.post(`/admin/skills/${encodeURIComponent(skillName)}/toggle`),
    null,
    null,
    false
  );
};

/**
 * Delete a skill by name.
 *
 * @param {string} skillName - The unique name identifier of the skill to delete
 * @returns {Promise<Object>} Confirmation of deletion
 */
export const deleteSkill = async skillName => {
  return handleApiResponse(
    () => apiClient.delete(`/admin/skills/${encodeURIComponent(skillName)}`),
    null,
    null,
    false
  );
};

/**
 * Import a skill from uploaded form data (e.g. a skill package or file).
 *
 * @param {FormData} formData - The form data containing the skill file to import
 * @returns {Promise<Object>} The imported skill object
 */
export const importSkill = async formData => {
  return handleApiResponse(
    () =>
      apiClient.post('/admin/skills/import', formData, {
        headers: {
          'Content-Type': 'multipart/form-data'
        }
      }),
    null,
    null,
    false
  );
};

/**
 * Export a skill by triggering a file download in a new browser tab.
 * Uses a direct window.open approach to initiate the download.
 *
 * @param {string} skillName - The unique name identifier of the skill to export
 */
export const exportSkill = async skillName => {
  window.open(
    `${apiClient.defaults.baseURL}/admin/skills/${encodeURIComponent(skillName)}/export`,
    '_blank'
  );
};
