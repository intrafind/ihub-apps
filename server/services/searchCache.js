/**
 * Short-TTL, bounded in-memory cache for web-search results.
 *
 * An agent run issues many searches, and across re-plan/verify rounds the same
 * (or near-identical) queries recur. Brave's free tier is ~1 req/s, so every
 * avoided call is one fewer 429 (run wf-exec-f4f70e84 fired 151 searches, all
 * rate-limited). Caching successful results by normalized query lets repeat
 * queries skip the network and the throttle entirely.
 *
 * Process-global singleton (keyed by provider+query) so the cache is shared
 * across all tasks and sub-workflows. Insertion-ordered Map → evict-oldest when
 * the entry cap is hit, so it never grows unbounded.
 *
 * @module services/searchCache
 */

const store = new Map(); // key -> { value, expiresAt }
const MAX_ENTRIES = 500;

/**
 * Build a normalized cache key. Query case and internal whitespace are folded
 * so trivially-different phrasings of the same query share an entry; `extra`
 * (e.g. result count / offset) participates so different request shapes don't
 * collide.
 */
export function makeSearchCacheKey(provider, query, extra = {}) {
  const q = String(query == null ? '' : query)
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
  let extraKey = '';
  try {
    const keys = Object.keys(extra || {}).sort();
    extraKey = keys.map(k => `${k}=${extra[k]}`).join('&');
  } catch {
    extraKey = '';
  }
  return `${provider}::${q}::${extraKey}`;
}

/**
 * @returns the cached value if present and not expired, else undefined.
 * Expired entries are evicted on access. `now` is injectable for tests.
 */
export function getCachedSearch(key, now = Date.now()) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

/**
 * Store a value with a TTL. Evicts the oldest entry when the cap is reached.
 * `now` is injectable for tests.
 */
export function setCachedSearch(key, value, ttlMs, now = Date.now()) {
  if (!key || !Number.isFinite(ttlMs) || ttlMs <= 0) return;
  if (!store.has(key) && store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { value, expiresAt: now + ttlMs });
}

/** Test helper — clear all cached entries. */
export function _clearSearchCache() {
  store.clear();
}
