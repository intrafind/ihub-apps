/**
 * Tests for CorpusSearchNodeExecutor paging behaviour.
 *
 * Focus: a single query that iFinder reports has more hits than one page
 * (100) must be paged until fully collected when `maxPerTopic: 0`, bounded by
 * the corpus-wide `maxTotalDocs`. A positive `maxPerTopic` keeps the historical
 * top-N-per-query cap. Regression guard for the Stellungnahmen/iFinder review
 * only resolving the first 25 of 155 documents.
 *
 * Stubs the iFinderService singleton's `search()` the same way the discover
 * test does — the executor imports the same instance, so reassigning the method
 * intercepts its calls.
 */
import { CorpusSearchNodeExecutor } from '../services/workflow/executors/CorpusSearchNodeExecutor.js';
import iFinderService from '../services/integrations/iFinderService.js';

/**
 * Build a search() stub that models a corpus of `total` documents with unique
 * ids, honouring the `from`/`maxResults` paging params. Records every call.
 */
function makeSearchStub(total) {
  const calls = [];
  const fn = async ({ from = 0, maxResults = 0 }) => {
    calls.push({ from, maxResults });
    const end = Math.min(from + maxResults, total);
    const results = [];
    for (let i = from; i < end; i++) {
      results.push({ id: `doc-${i}`, title: `Doc ${i}`, sourceName: 'corpus' });
    }
    return { results, totalFound: total, took: 1 };
  };
  return { fn, calls };
}

function makeNode(config) {
  return {
    id: 'search-corpus',
    type: 'corpus-search',
    config: {
      queryPath: '$.data.q',
      searchProfile: 'profile-test',
      fetchFulltext: false,
      ...config
    }
  };
}

const state = { data: { q: 'krankengeld' } };
const context = { user: { id: 'u1', email: 'u@example.com' }, chatId: 'c1' };

describe('CorpusSearchNodeExecutor paging', () => {
  let executor;
  let originalSearch;

  beforeEach(() => {
    executor = new CorpusSearchNodeExecutor();
    originalSearch = iFinderService.search.bind(iFinderService);
  });

  afterEach(() => {
    iFinderService.search = originalSearch;
  });

  test('maxPerTopic:0 pages through all hits beyond the 100-per-call cap', async () => {
    const { fn, calls } = makeSearchStub(155);
    iFinderService.search = fn;

    const result = await executor.execute(
      makeNode({ maxPerTopic: 0, maxTotalDocs: 500 }),
      state,
      context
    );

    expect(result.status).toBe('completed');
    expect(result.output.total).toBe(155);
    expect(result.stateUpdates._corpus).toHaveLength(155);
    // 100 + 55 across two pages, proving pagination actually ran.
    expect(calls).toHaveLength(2);
    expect(calls[0].from).toBe(0);
    expect(calls[1].from).toBe(100);
  });

  test('positive maxPerTopic keeps the historical top-N-per-query cap', async () => {
    const { fn, calls } = makeSearchStub(155);
    iFinderService.search = fn;

    const result = await executor.execute(
      makeNode({ maxPerTopic: 25, maxTotalDocs: 500 }),
      state,
      context
    );

    expect(result.output.total).toBe(25);
    expect(result.stateUpdates._corpus).toHaveLength(25);
    expect(calls).toHaveLength(1);
    expect(calls[0].maxResults).toBe(25);
  });

  test('maxTotalDocs bounds the corpus even when maxPerTopic is unlimited', async () => {
    const { fn, calls } = makeSearchStub(155);
    iFinderService.search = fn;

    const result = await executor.execute(
      makeNode({ maxPerTopic: 0, maxTotalDocs: 120 }),
      state,
      context
    );

    expect(result.output.total).toBe(120);
    // Second page is trimmed to the remaining corpus budget (20), not a full 100.
    expect(calls).toHaveLength(2);
    expect(calls[1].maxResults).toBe(20);
  });

  test('a corpus smaller than one page resolves in a single call', async () => {
    const { fn, calls } = makeSearchStub(60);
    iFinderService.search = fn;

    const result = await executor.execute(
      makeNode({ maxPerTopic: 0, maxTotalDocs: 500 }),
      state,
      context
    );

    expect(result.output.total).toBe(60);
    expect(calls).toHaveLength(1);
  });
});
