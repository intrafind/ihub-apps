import { apiClient } from '../client';
import { handleApiResponse } from '../utils/requestHandler';
import cache, { CACHE_KEYS, DEFAULT_CACHE_TTL, buildCacheKey } from '../../utils/cache';

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

// Platform Configuration (includes features)
export const fetchPlatformConfig = async (options = {}) => {
  const { skipCache = false } = options;
  const cacheKey = skipCache ? null : buildCacheKey(CACHE_KEYS.PLATFORM_CONFIG);

  return handleApiResponse(
    () => apiClient.get('/configs/platform'),
    cacheKey,
    DEFAULT_CACHE_TTL.LONG
  );
};

// Mimetypes Configuration
export const fetchMimetypesConfig = async (options = {}) => {
  const { skipCache = false } = options;
  const cacheKey = skipCache ? null : buildCacheKey(CACHE_KEYS.MIMETYPES_CONFIG);

  return handleApiResponse(
    () => apiClient.get('/configs/mimetypes'),
    cacheKey,
    DEFAULT_CACHE_TTL.LONG
  );
};

/**
 * Drop every cached UI-config response, including the per-language variants.
 *
 * Responses are kept in memory for 30 minutes, so a plain refetch after an
 * admin save was answered from the cache and left the sidebar and the "/"
 * redirect on the old configuration until a full page reload. Invalidate
 * first and then fetch normally: the request repopulates the cache, so every
 * other consumer sees the new configuration too.
 *
 * @returns {number} How many cache entries were dropped
 */
export const invalidateUIConfigCache = () => cache.invalidateByPattern(CACHE_KEYS.UI_CONFIG);

/**
 * Drop the cached platform-config response. Same reasoning as
 * `invalidateUIConfigCache`.
 *
 * @returns {number} How many cache entries were dropped
 */
export const invalidatePlatformConfigCache = () =>
  cache.invalidateByPattern(CACHE_KEYS.PLATFORM_CONFIG);
