import { apiClient } from '../client';
import { handleApiResponse } from '../utils/requestHandler';
import { DEFAULT_CACHE_TTL } from '../../utils/cache';
import cache from '../../utils/cache';

// Admin usage data
export const fetchUsageData = async() => {
  return handleApiResponse(() => apiClient.get('/admin/usage'), null, null, false);
};

// Admin API functions
export const fetchAdminPrompts = async(options = {}) => {
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

export const updatePrompt = async(promptId, promptData) => {
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

export const fetchAdminApps = async(options = {}) => {
  const { skipCache = false } = options;
  const cacheKey = skipCache ? null : 'admin_apps';

  return handleApiResponse(() => apiClient.get('/admin/apps'), cacheKey, DEFAULT_CACHE_TTL.SHORT);
};
