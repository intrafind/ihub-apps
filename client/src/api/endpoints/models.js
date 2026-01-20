import { apiClient } from '../client';
import { handleApiResponse } from '../utils/requestHandler';
import { CACHE_KEYS, DEFAULT_CACHE_TTL, buildCacheKey } from '../../utils/cache';
import cache from '../../utils/cache';

// Models
export const fetchModels = async (options = {}) => {
  const { skipCache = false } = options;
  const cacheKey = skipCache ? null : CACHE_KEYS.MODELS_LIST;

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

      return apiClient.get('/models', { headers });
    },
    cacheKey,
    DEFAULT_CACHE_TTL.MEDIUM,
    true,
    true // Enable ETag handling
  );
};

export const fetchModelDetails = async (modelId, options = {}) => {
  const { skipCache = false } = options;
  const cacheKey = skipCache ? null : buildCacheKey(CACHE_KEYS.MODEL_DETAILS, { id: modelId });

  return handleApiResponse(
    () => apiClient.get(`/models/${modelId}`),
    cacheKey,
    DEFAULT_CACHE_TTL.MEDIUM
  );
};

export const testModel = async modelId => {
  return handleApiResponse(
    () => apiClient.get(`/models/${modelId}/chat/test`),
    null, // No caching for test calls
    null,
    false // Don't deduplicate test requests
  );
};
