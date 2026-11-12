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

/** Heap one indexed character takes: a 10 MB text is about 55 MB of index. */
export const INDEX_HEAP_BYTES_PER_CHAR = 5.5;

/**
 * Search indexes of project corpora, as heap bytes. The ceiling is the old 30
 * million characters (~165 MB) at {@link INDEX_HEAP_BYTES_PER_CHAR}.
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

/** @param {number} [heapLimit] @returns {number} Bytes of item text to cache. */
export function itemTextCacheBytes(heapLimit) {
  return budgetFromHeap(ITEM_TEXT_CACHE, heapLimit);
}

/** @param {number} [heapLimit] @returns {number} Indexed characters to cache. */
export function searchIndexCacheChars(heapLimit) {
  return Math.floor(budgetFromHeap(SEARCH_INDEX_CACHE, heapLimit) / INDEX_HEAP_BYTES_PER_CHAR);
}

/** @param {number} [heapLimit] @returns {number} Bytes one source handler caches. */
export function sourceCacheBytes(heapLimit) {
  return budgetFromHeap(SOURCE_CACHE, heapLimit);
}
