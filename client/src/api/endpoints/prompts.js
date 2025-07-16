import { apiClient } from '../client';
import { handleApiResponse } from '../utils/requestHandler';
import { CACHE_KEYS, DEFAULT_CACHE_TTL } from '../../utils/cache';
import cache from '../../utils/cache';

// Prompts
export const fetchPrompts = async (options = {}) => {
  const { skipCache = false } = options;
  const cacheKey = skipCache ? null : CACHE_KEYS.PROMPTS;

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

      return apiClient.get('/prompts', { headers });
    },
    cacheKey,
    DEFAULT_CACHE_TTL.MEDIUM,
    true,
    true // Enable ETag handling
  );
};

export const generateMagicPrompt = async (input, options = {}) => {
  return handleApiResponse(
    () => apiClient.post('/magic-prompt', { input, ...options }),
    null,
    null,
    false
  );
};
