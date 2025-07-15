import cache from '../../utils/cache';

// Clear the API cache - useful when user actions might invalidate the cache
export const clearApiCache = (key = null) => {
  if (key) {
    cache.delete(key);
  } else {
    cache.clear();
  }
  console.log(key ? `Cleared cache for ${key}` : 'Cleared entire API cache');
};

// Invalidate specific cache entries based on prefix or pattern
export const invalidateCacheByPattern = pattern => {
  const invalidatedCount = cache.invalidateByPattern(pattern);
  console.log(`Invalidated ${invalidatedCount} cache entries matching: ${pattern}`);
  return invalidatedCount;
};
