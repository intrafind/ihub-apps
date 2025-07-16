import { apiClient } from '../client';
import { handleApiResponse } from '../utils/requestHandler';
import { CACHE_KEYS, DEFAULT_CACHE_TTL, buildCacheKey } from '../../utils/cache';

// UI Configuration
export const fetchUIConfig = async (options = {}) => {
  const { skipCache = false, language = null } = options;
  const cacheKey = skipCache ? null : buildCacheKey(CACHE_KEYS.UI_CONFIG, { language });

  return handleApiResponse(
    () => apiClient.get('/configs/ui', { params: { language } }),
    cacheKey,
    DEFAULT_CACHE_TTL.LONG
  );
};

// Platform configuration
export const fetchPlatformConfig = async (options = {}) => {
  const { skipCache = false } = options;
  const cacheKey = skipCache ? null : CACHE_KEYS.PLATFORM_CONFIG;

  return handleApiResponse(
    () => apiClient.get('/configs/platform'),
    cacheKey,
    DEFAULT_CACHE_TTL.LONG
  );
};
