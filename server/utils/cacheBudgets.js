// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * How much of a process's heap its in-memory caches may hold (#3624).
 *
 * The caches below used to be fixed amounts — 96 MB of item text, 30 million
 * characters of search index (about 165 MB of heap), and a URL source cache
 * with no bound at all — which is fine for a process with a multi-gigabyte
 * heap and 40 % and more of the ~620 MB heap a worker gets in a 2 GB container
 * (phase 3 of #3624). Each is now a share of the process's own heap limit
 * (`v8.getHeapStatistics().heap_size_limit`), never below a floor that keeps
 * the cache useful and never above the amount it had before.
 *
 * The shares together stay well below the heap: on a 716 MB heap limit about
 * 6 % item text + 10 % search index + 4 × 2 % URL source caches (one per
 * source handler) ≈ 24 %, leaving the rest for the requests themselves.
 *
 * @module utils/cacheBudgets
 */
import v8 from 'node:v8';

const MB = 1024 * 1024;

/**
 * Decrypted project item text (UTF-16 bytes). A single text may take half of
 * it, so on a 2 GB-pod worker (~43 MB) a 10 MB text (20 MB in memory) is still
 * cached; the floor keeps a few typical texts cacheable on a small heap, the
 * ceiling is the old fixed size.
 */
export const ITEM_TEXT_CACHE = Object.freeze({ share: 0.06, min: 16 * MB, max: 96 * MB });

/**
 * Heap one indexed character takes, as the budget assumes it: a 10 MB text is
 * about 45 MB of index. It was 5.5; #3650 measured about 4.5 (590,000
 * characters → 2.6 MB) for the load-test projects.
 *
 * The cost depends on the text — the index holds a copy of every part, the
 * terms and their postings, so text with many distinct terms costs more.
 * Re-measured on Node 22.23 with `buildCorpusIndex`, forcing a GC before and
 * after (`node --expose-gc`) and taking the difference of
 * `process.memoryUsage().heapUsed` with the source texts kept alive both times:
 * ~595k characters of the repository's own Markdown docs (code-heavy, many
 * identifiers) cost 3.6 MB steady state, 6.3 bytes per character (the first
 * build in a process adds ~1.3 MB of one-off warm-up). Typical business prose
 * sits between the two, which is why the heap share is configurable
 * (`projects.indexCache.maxHeapShare`) and the cache `chars`/`entries` metrics
 * exist to check it against a real installation.
 */
export const INDEX_HEAP_BYTES_PER_CHAR = 4.5;

/**
 * Search indexes of project corpora, as heap bytes. The ceiling is the old 30
 * million characters (135 MB) at {@link INDEX_HEAP_BYTES_PER_CHAR}.
 */
export const SEARCH_INDEX_CACHE = Object.freeze({
  share: 0.1,
  min: 12 * MB,
  max: 30_000_000 * INDEX_HEAP_BYTES_PER_CHAR
});

/**
 * Cached source content per source handler (URL, page, iFinder, …), as
 * estimated UTF-16 bytes. The page reader caps a page at 400,000 characters
 * (~800 KB), so even the floor holds several pages.
 */
export const SOURCE_CACHE = Object.freeze({ share: 0.02, min: 4 * MB, max: 32 * MB });

/** Entries one source handler caches, whatever their size. */
export const SOURCE_CACHE_MAX_ENTRIES = 256;

/**
 * This process's V8 heap limit.
 *
 * @returns {number} Bytes
 */
export function heapLimitBytes() {
  return v8.getHeapStatistics().heap_size_limit;
}

/**
 * A share of the heap limit, clamped to `[min, max]`.
 *
 * @param {{share: number, min: number, max: number}} budget - Share, floor and ceiling
 * @param {number} [heapLimit] - Heap limit in bytes; this process's by default
 * @returns {number} Bytes
 */
export function budgetFromHeap({ share, min, max }, heapLimit = heapLimitBytes()) {
  return Math.min(max, Math.max(min, Math.floor(heapLimit * share)));
}

/**
 * A configured share (`projects.*Cache.maxHeapShare`) replaces the built-in
 * share and drops the old ceiling — raising the share is how an operator with a
 * large heap holds a larger working set; the floor stays.
 */
function budgetFor(budget, heapLimit, share) {
  return typeof share === 'number'
    ? budgetFromHeap({ ...budget, share, max: Infinity }, heapLimit)
    : budgetFromHeap(budget, heapLimit);
}

/**
 * @param {number} [heapLimit]
 * @param {number|null} [share] - `projects.textCache.maxHeapShare`, if set
 * @returns {number} Bytes of item text to cache.
 */
export function itemTextCacheBytes(heapLimit, share) {
  return budgetFor(ITEM_TEXT_CACHE, heapLimit, share);
}

/**
 * @param {number} [heapLimit]
 * @param {number|null} [share] - `projects.indexCache.maxHeapShare`, if set
 * @returns {number} Indexed characters to cache.
 */
export function searchIndexCacheChars(heapLimit, share) {
  return Math.floor(budgetFor(SEARCH_INDEX_CACHE, heapLimit, share) / INDEX_HEAP_BYTES_PER_CHAR);
}

/** @param {number} [heapLimit] @returns {number} Bytes one source handler caches. */
export function sourceCacheBytes(heapLimit) {
  return budgetFromHeap(SOURCE_CACHE, heapLimit);
}
