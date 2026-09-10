import cache, { CACHE_KEYS, buildCacheKey } from '../../../client/src/utils/cache';
import { invalidateCacheByPattern, clearApiCache } from '../../../client/src/api/utils/cache';

/**
 * API responses are held in memory for up to 30 minutes, so anything that
 * changes server-side configuration has to drop the matching entries or every
 * consumer keeps serving the old answer until a full page reload (#2320).
 * `buildCacheKey` appends parameters to the base key, so dropping one resource
 * means dropping a family of keys — that is what prefix matching is for.
 */

beforeEach(() => {
  cache.clear();
});

describe('cache.invalidateByPattern', () => {
  test('a string drops the base key and every parameterized variant', () => {
    cache.set(CACHE_KEYS.UI_CONFIG, { data: 'plain' });
    cache.set(buildCacheKey(CACHE_KEYS.UI_CONFIG, { language: 'de' }), { data: 'de' });
    cache.set(buildCacheKey(CACHE_KEYS.UI_CONFIG, { language: 'en' }), { data: 'en' });
    cache.set(CACHE_KEYS.APPS_LIST, { data: 'apps' });

    expect(cache.invalidateByPattern(CACHE_KEYS.UI_CONFIG)).toBe(3);
    expect(cache.get(CACHE_KEYS.UI_CONFIG)).toBeNull();
    expect(cache.get('ui-config?language=de')).toBeNull();
    // Unrelated resources are left alone.
    expect(cache.get(CACHE_KEYS.APPS_LIST)).toEqual({ data: 'apps' });
  });

  test('a RegExp is tested against the whole key', () => {
    cache.set('ui-config?language=de', { data: 'de' });
    cache.set('ui-config?language=en', { data: 'en' });

    expect(cache.invalidateByPattern(/language=de$/)).toBe(1);
    expect(cache.get('ui-config?language=de')).toBeNull();
    expect(cache.get('ui-config?language=en')).toEqual({ data: 'en' });
  });

  test('an empty pattern is a no-op rather than a full flush', () => {
    cache.set(CACHE_KEYS.UI_CONFIG, { data: 'plain' });

    expect(cache.invalidateByPattern('')).toBe(0);
    expect(cache.invalidateByPattern(null)).toBe(0);
    expect(cache.invalidateByPattern(undefined)).toBe(0);
    expect(cache.get(CACHE_KEYS.UI_CONFIG)).toEqual({ data: 'plain' });
  });
});

describe('api cache helpers', () => {
  // This one called a method the cache never had, so it threw instead of
  // invalidating anything.
  test('invalidateCacheByPattern reports how many entries it dropped', () => {
    cache.set(CACHE_KEYS.UI_CONFIG, { data: 'plain' });
    cache.set('ui-config?language=de', { data: 'de' });

    expect(invalidateCacheByPattern(CACHE_KEYS.UI_CONFIG)).toBe(2);
    expect(cache.size).toBe(0);
  });

  test('clearApiCache drops one key or everything', () => {
    cache.set(CACHE_KEYS.UI_CONFIG, { data: 'plain' });
    cache.set(CACHE_KEYS.APPS_LIST, { data: 'apps' });

    clearApiCache(CACHE_KEYS.UI_CONFIG);
    expect(cache.get(CACHE_KEYS.UI_CONFIG)).toBeNull();
    expect(cache.get(CACHE_KEYS.APPS_LIST)).toEqual({ data: 'apps' });

    clearApiCache();
    expect(cache.size).toBe(0);
  });
});
