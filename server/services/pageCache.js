/**
 * Short-TTL, bounded in-memory cache for pages the page reader extracted.
 *
 * The web search counterpart is `searchCache.js`. Pages differ from search
 * results in size — one extracted document can be hundreds of kilobytes — so
 * this cache is bounded by total characters as well as by entry count. What
 * is stored is the whole extracted document, not the window the model asked
 * for, so reading a page again in a turn, or reading on from an `offset`,
 * costs no request at all.
 *
 * Entries are keyed by URL and the `Accept-Language` the page was requested
 * with: the same URL can serve another language's page.
 *
 * Process-global and insertion-ordered: the oldest entry goes first when a
 * bound is reached. Only successful extractions are stored.
 *
 * @module services/pageCache
 */

const store = new Map(); // key -> { value, size, expiresAt }

/** Most pages kept. */
export const MAX_PAGE_ENTRIES = 100;

/** Most characters kept across all pages (about 32 MB of UTF-16). */
export const MAX_PAGE_CACHE_CHARS = 16_000_000;

let totalChars = 0;

/** Default time a page stays cached: 10 minutes, like search results. */
export const DEFAULT_PAGE_CACHE_TTL_MS = 600_000;

/**
 * @param {string} url
 * @param {string} [acceptLanguage]
 * @returns {string}
 */
export function makePageCacheKey(url, acceptLanguage = '') {
  return `${String(url || '')}::${String(acceptLanguage || '').toLowerCase()}`;
}

function drop(key) {
  const entry = store.get(key);
  if (!entry) return;
  totalChars -= entry.size;
  store.delete(key);
}

/**
 * @returns the cached page if present and not expired, else undefined.
 * `now` is injectable for tests.
 */
export function getCachedPage(key, now = Date.now()) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    drop(key);
    return undefined;
  }
  return entry.value;
}

/**
 * Store a page for `ttlMs`. `size` is its character count (the document text);
 * a page larger than the whole cache is not stored.
 */
export function setCachedPage(key, value, size, ttlMs, now = Date.now()) {
  if (!key || !Number.isFinite(ttlMs) || ttlMs <= 0) return;
  const chars = Math.max(0, Math.floor(Number(size) || 0));
  if (chars > MAX_PAGE_CACHE_CHARS) return;
  drop(key);
  while (
    store.size > 0 &&
    (store.size >= MAX_PAGE_ENTRIES || totalChars + chars > MAX_PAGE_CACHE_CHARS)
  ) {
    drop(store.keys().next().value);
  }
  store.set(key, { value, size: chars, expiresAt: now + ttlMs });
  totalChars += chars;
}

/** Test helper — clear all cached pages. */
export function _clearPageCache() {
  store.clear();
  totalChars = 0;
}

/** Test helper — what the cache holds. */
export function _pageCacheStats() {
  return { entries: store.size, chars: totalChars };
}
