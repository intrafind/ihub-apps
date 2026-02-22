import { apiClient } from '../client';
import { handleApiResponse } from '../utils/requestHandler';
import { DEFAULT_CACHE_TTL, buildCacheKey } from '../../utils/cache';

/**
 * Fetch all available skills from the user-facing API.
 * Returns an array of skill objects with `name` and `description` fields.
 *
 * @param {string} [language] - Optional language code for localized content
 * @param {Object} [options] - Request options
 * @param {boolean} [options.skipCache=false] - Whether to bypass the cache
 * @returns {Promise<Array<{name: string, description: string}>>} Array of skill objects
 */
export const fetchSkills = async (language, options = {}) => {
  const { skipCache = false } = options;
  const cacheKey = skipCache ? null : buildCacheKey('skills', { language });
  const params = {};
  if (language) {
    params.language = language;
  }

  return handleApiResponse(
    () => apiClient.get('/skills', { params }),
    cacheKey,
    DEFAULT_CACHE_TTL.MEDIUM
  );
};

/**
 * Fetch the full content/definition of a specific skill.
 * Used to retrieve the skill's executable content or detailed configuration.
 *
 * @param {string} skillName - The unique name identifier of the skill
 * @returns {Promise<Object>} The skill content object
 */
export const fetchSkillContent = async skillName => {
  const cacheKey = buildCacheKey('skill_content', { name: skillName });

  return handleApiResponse(
    () => apiClient.get(`/skills/${encodeURIComponent(skillName)}/content`),
    cacheKey,
    DEFAULT_CACHE_TTL.MEDIUM
  );
};

/**
 * Fetch metadata for a specific skill.
 * Returns the skill's name, description, and other metadata without full content.
 *
 * @param {string} skillName - The unique name identifier of the skill
 * @returns {Promise<Object>} The skill metadata object
 */
export const fetchSkillMetadata = async skillName => {
  const cacheKey = buildCacheKey('skill_metadata', { name: skillName });

  return handleApiResponse(
    () => apiClient.get(`/skills/${encodeURIComponent(skillName)}`),
    cacheKey,
    DEFAULT_CACHE_TTL.MEDIUM
  );
};
