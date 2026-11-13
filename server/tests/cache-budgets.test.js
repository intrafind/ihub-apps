// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Per-process caches sized to the worker's own heap limit (#3624, phase 4).
 *
 * The item text cache (96 MB), the search index cache (30M characters, about
 * 165 MB of heap) and the URL source cache (unbounded) were fixed amounts, so
 * on a worker with a ~620 MB heap — the size phase 3 gives a 2 GB pod two
 * workers — they could take 40 % and more of it. Each is now a share of
 * `heap_size_limit`, between a floor and a ceiling.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import {
  INDEX_HEAP_BYTES_PER_CHAR,
  ITEM_TEXT_CACHE,
  SEARCH_INDEX_CACHE,
  SOURCE_CACHE,
  SOURCE_CACHE_MAX_ENTRIES,
  budgetFromHeap,
  itemTextCacheBytes,
  searchIndexCacheChars,
  sourceCacheBytes
} from '../utils/cacheBudgets.js';
import { projectSettings } from '../services/projects/projectSettings.js';
import {
  MAX_CACHE_HEAP_SHARE,
  MAX_INDEX_CACHE_ENTRIES,
  MIN_CACHE_HEAP_SHARE
} from '../services/projects/projectConstants.js';
import { platformConfigSchema } from '../validators/platformConfigSchema.js';
import { indexCacheLimits as indexCacheLimitsFor } from '../services/knowledge/LocalKnowledgeProvider.js';
import { BoundedSourceCache } from '../sources/boundedSourceCache.js';

const MB = 1024 * 1024;

test('the budgets follow the heap limit between a floor and a ceiling', () => {
  // A worker of a 2 GB pod after phase 3: 620 MB old space, ~716 MB heap limit.
  const worker = 716 * MB;
  const text = itemTextCacheBytes(worker);
  const indexChars = searchIndexCacheChars(worker);
  const source = sourceCacheBytes(worker);
  assert.ok(text < 96 * MB && text >= ITEM_TEXT_CACHE.min, `item text ${text / MB} MB`);
  assert.ok(indexChars < 30_000_000, `index ${indexChars} chars`);
  // All of them together — four source handlers each with its own cache —
  // stay well below the heap: under a third, where they used to reach 40 %+.
  const total = text + indexChars * INDEX_HEAP_BYTES_PER_CHAR + 4 * source;
  assert.ok(
    total / worker < 0.33,
    `caches take ${Math.round((100 * total) / worker)} % of the heap`
  );

  // A large heap is capped at the old fixed amounts, a tiny one floored.
  assert.equal(itemTextCacheBytes(16 * 1024 * MB), ITEM_TEXT_CACHE.max);
  assert.equal(itemTextCacheBytes(16 * 1024 * MB), 96 * MB);
  assert.equal(searchIndexCacheChars(16 * 1024 * MB), 30_000_000);
  assert.equal(sourceCacheBytes(16 * 1024 * MB), SOURCE_CACHE.max);
  assert.equal(itemTextCacheBytes(64 * MB), ITEM_TEXT_CACHE.min);
  assert.equal(
    searchIndexCacheChars(64 * MB),
    Math.floor(SEARCH_INDEX_CACHE.min / INDEX_HEAP_BYTES_PER_CHAR)
  );
  assert.equal(sourceCacheBytes(64 * MB), SOURCE_CACHE.min);
});

test('without an argument the budgets read this process’s heap limit', () => {
  const limit = v8.getHeapStatistics().heap_size_limit;
  assert.equal(itemTextCacheBytes(), itemTextCacheBytes(limit));
  assert.equal(budgetFromHeap({ share: 0.5, min: 1, max: Infinity }), Math.floor(limit * 0.5));
});

test('the item text cache module holds to the budget of this process', async () => {
  const service = await import('../services/knowledge/ItemTextService.js');
  assert.equal(service.textCacheBudgetBytes({}), itemTextCacheBytes());

  // Texts a third of the budget each (UTF-16): after four, the first is gone.
  const chars = Math.floor(service.textCacheBudgetBytes() / 2 / 3);
  const reads = [];
  service.setTextReader(async (_project, item) => {
    reads.push(item.text.blobKey);
    return 'x'.repeat(chars);
  });
  service.evictItemText();
  try {
    const project = { id: 'p1' };
    const item = key => ({ id: key, status: 'ready', storage: 'text', text: { blobKey: key } });
    for (const key of ['t1', 't2', 't3', 't4']) await service.getItemText(project, item(key));
    await service.getItemText(project, item('t4'));
    assert.deepEqual(reads, ['t1', 't2', 't3', 't4'], 'the newest is served from the cache');
    await service.getItemText(project, item('t1'));
    assert.deepEqual(reads, ['t1', 't2', 't3', 't4', 't1'], 'the oldest was evicted');
  } finally {
    service.setTextReader(null);
    service.evictItemText();
  }
});

test('the search index cache module uses the budget of this process', async () => {
  const provider = await import('../services/knowledge/LocalKnowledgeProvider.js');
  assert.deepEqual(provider.indexCacheLimits({}), {
    maxEntries: 32,
    maxChars: searchIndexCacheChars()
  });
});

test('an index character is budgeted at 4.5 bytes of heap (#3650)', () => {
  assert.equal(INDEX_HEAP_BYTES_PER_CHAR, 4.5);
  const worker = 716 * MB;
  // 10 % of the heap, in characters at the measured cost.
  assert.equal(
    searchIndexCacheChars(worker),
    Math.floor(Math.floor(worker * 0.1) / INDEX_HEAP_BYTES_PER_CHAR)
  );
  // Same ceiling in characters as before: 30 million.
  assert.equal(searchIndexCacheChars(16 * 1024 * MB), 30_000_000);
  assert.equal(SEARCH_INDEX_CACHE.max, 30_000_000 * 4.5);
});

test('a configured heap share replaces the share and the old ceiling, keeps the floor', () => {
  const big = 16 * 1024 * MB;
  assert.equal(searchIndexCacheChars(big, 0.1), Math.floor((big * 0.1) / 4.5));
  assert.ok(searchIndexCacheChars(big, 0.1) > 30_000_000);
  assert.equal(itemTextCacheBytes(big, 0.06), Math.floor(big * 0.06));
  assert.equal(itemTextCacheBytes(64 * MB, 0.01), ITEM_TEXT_CACHE.min);
  assert.equal(searchIndexCacheChars(undefined, null), searchIndexCacheChars());
});

test('projects.indexCache and textCache are read with fallbacks and clamped', () => {
  const defaults = projectSettings({});
  assert.deepEqual(defaults.indexCache, { maxEntries: 32, maxHeapShare: null });
  assert.deepEqual(defaults.textCache, { maxHeapShare: null });
  assert.deepEqual(
    projectSettings({ projects: { indexCache: {} } }).indexCache,
    defaults.indexCache
  );

  const set = projectSettings({
    projects: {
      indexCache: { maxEntries: 100, maxHeapShare: 0.2 },
      textCache: { maxHeapShare: 0.1 }
    }
  });
  assert.deepEqual(set.indexCache, { maxEntries: 100, maxHeapShare: 0.2 });
  assert.deepEqual(set.textCache, { maxHeapShare: 0.1 });

  const wild = projectSettings({
    projects: {
      indexCache: { maxEntries: 'many', maxHeapShare: 9 },
      textCache: { maxHeapShare: 0 }
    }
  });
  assert.equal(wild.indexCache.maxEntries, 32, 'a non-number falls back');
  assert.equal(wild.indexCache.maxHeapShare, MAX_CACHE_HEAP_SHARE);
  assert.equal(wild.textCache.maxHeapShare, MIN_CACHE_HEAP_SHARE);
  assert.equal(
    projectSettings({ projects: { indexCache: { maxEntries: 1e9 } } }).indexCache.maxEntries,
    MAX_INDEX_CACHE_ENTRIES
  );
  assert.equal(
    projectSettings({ projects: { indexCache: { maxEntries: -3 } } }).indexCache.maxEntries,
    32
  );

  const provider = indexCacheLimitsFor({ projects: { indexCache: { maxEntries: 5 } } });
  assert.equal(provider.maxEntries, 5);
});

test('platform schema validates the cache bounds', () => {
  const parse = projects => platformConfigSchema.safeParse({ projects });
  assert.ok(
    parse({ indexCache: { maxEntries: 100, maxHeapShare: 0.2 }, textCache: { maxHeapShare: 0.1 } })
      .success
  );
  assert.ok(parse({}).success, 'both blocks are optional');
  for (const bad of [
    { indexCache: { maxEntries: 0 } },
    { indexCache: { maxEntries: 1.5 } },
    { indexCache: { maxEntries: MAX_INDEX_CACHE_ENTRIES + 1 } },
    { indexCache: { maxHeapShare: 0.9 } },
    { indexCache: { maxHeapShare: 0 } },
    { textCache: { maxHeapShare: 0.6 } },
    { textCache: { maxHeapShare: 'half' } }
  ]) {
    assert.equal(parse(bad).success, false, JSON.stringify(bad));
  }
});

test('the text cache holds to a configured share', async () => {
  const service = await import('../services/knowledge/ItemTextService.js');
  const heap = v8.getHeapStatistics().heap_size_limit;
  assert.equal(
    service.textCacheBudgetBytes({ projects: { textCache: { maxHeapShare: 0.2 } } }),
    Math.max(ITEM_TEXT_CACHE.min, Math.floor(heap * 0.2))
  );
});

test('the URL source cache evicts the oldest entries by count', () => {
  const cache = new BoundedSourceCache({ maxEntries: 3, maxBytes: 10 * MB });
  for (const key of ['a', 'b', 'c', 'd']) cache.set(key, { data: { content: key } });
  assert.deepEqual([...cache.keys()], ['b', 'c', 'd']);
  // A rewrite counts as new.
  cache.set('b', { data: { content: 'b2' } });
  cache.set('e', { data: { content: 'e' } });
  assert.deepEqual([...cache.keys()], ['d', 'b', 'e']);
});

test('the URL source cache evicts the oldest entries by bytes, and skips an oversized one', () => {
  const cache = new BoundedSourceCache({ maxEntries: 100, maxBytes: 1 * MB });
  const page = chars => ({ data: { content: 'x'.repeat(chars), metadata: { url: 'u' } }, ttl: 1 });
  for (const key of ['a', 'b', 'c']) cache.set(key, page(200_000)); // ~400 KB each
  assert.deepEqual([...cache.keys()], ['b', 'c']);
  assert.ok(cache.bytes <= 1 * MB, `${cache.bytes} bytes`);

  cache.set('huge', page(1_000_000)); // ~2 MB: never cached
  assert.equal(cache.has('huge'), false);
  assert.deepEqual([...cache.keys()], ['b', 'c']);

  // Direct deletes (URLHandler.forget does that) and clear keep the count right.
  cache.delete('b');
  assert.ok(cache.bytes > 0 && cache.bytes < 500_000);
  cache.clear();
  assert.equal(cache.bytes, 0);
});

test('every source handler gets a bounded cache', async () => {
  const { default: URLHandler } = await import('../sources/URLHandler.js');
  const handler = new URLHandler({});
  assert.ok(handler.cache instanceof BoundedSourceCache);
  assert.equal(handler.cache.maxEntries, SOURCE_CACHE_MAX_ENTRIES);
  assert.equal(handler.cache.maxBytes, sourceCacheBytes());
});
