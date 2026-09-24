/**
 * Prompt-cache metrics on the admin usage reports (issue #2508): hit ratio,
 * write-to-read ratio and the per-model / per-app / per-provider rows built
 * from the all-time usage aggregate. A key missing from the cache maps means
 * the provider never reported caching — "not reported", not 0 %.
 */
import {
  buildCacheRows,
  cacheHitRatio,
  formatRatio,
  summarizePromptCache,
  writeToReadRatio
} from '../../../client/src/features/admin/utils/promptCacheStats';

const tokens = {
  prompt: {
    total: 12000,
    perModel: { claude: 8000, gpt: 3000, iassistant: 1000 },
    perApp: { chat: 12000 },
    perProvider: { anthropic: 8000, openai: 3000 }
  },
  cacheRead: {
    total: 6400,
    perModel: { claude: 6000, gpt: 400 },
    perApp: { chat: 6400 },
    perProvider: { anthropic: 6000, openai: 400 }
  },
  cacheWrite: {
    total: 900,
    perModel: { claude: 900 },
    perApp: { chat: 900 },
    perProvider: { anthropic: 900 }
  }
};

describe('cacheHitRatio', () => {
  it('divides cached by prompt tokens, clamped to 0..1', () => {
    expect(cacheHitRatio(50, 200)).toBe(0.25);
    expect(cacheHitRatio(300, 200)).toBe(1);
  });

  it('is null when not reported or nothing to divide', () => {
    expect(cacheHitRatio(undefined, 200)).toBeNull();
    expect(cacheHitRatio(10, 0)).toBeNull();
  });
});

describe('writeToReadRatio', () => {
  it('is null without writes, Infinity with writes but no reads', () => {
    expect(writeToReadRatio(0, 100)).toBeNull();
    expect(writeToReadRatio(100, 0)).toBe(Infinity);
    expect(writeToReadRatio(50, 100)).toBe(0.5);
  });
});

describe('formatRatio', () => {
  it('formats a percentage and a dash for null / Infinity', () => {
    expect(formatRatio(0.75, 'en')).toBe('75%');
    expect(formatRatio(0.034, 'en')).toBe('3.4%');
    expect(formatRatio(null, 'en')).toBe('—');
    expect(formatRatio(Infinity, 'en')).toBe('—');
  });
});

describe('buildCacheRows', () => {
  it('builds sorted rows and marks models that never reported caching', () => {
    const rows = buildCacheRows(tokens, 'perModel');
    expect(rows.map(r => r.id)).toEqual(['claude', 'gpt', 'iassistant']);
    expect(rows[0]).toMatchObject({
      promptTokens: 8000,
      cacheReadTokens: 6000,
      cacheWriteTokens: 900,
      hitRatio: 0.75,
      reported: true
    });
    expect(rows[1]).toMatchObject({ cacheReadTokens: 400, reported: true });
    expect(rows[1].cacheWriteTokens).toBeUndefined();
    expect(rows[2]).toMatchObject({ reported: false, hitRatio: null });
    expect(rows[2].cacheReadTokens).toBeUndefined();
  });

  it('handles a usage.json written before cache tracking', () => {
    const legacy = { prompt: { total: 10, perModel: { m: 10 } } };
    expect(buildCacheRows(legacy, 'perModel')).toEqual([
      { id: 'm', promptTokens: 10, hitRatio: null, reported: false }
    ]);
    expect(buildCacheRows(legacy, 'perProvider')).toEqual([]);
  });
});

describe('summarizePromptCache', () => {
  it('only counts prompt tokens of models that report caching', () => {
    const summary = summarizePromptCache(tokens);
    expect(summary).toMatchObject({
      cacheReadTokens: 6400,
      cacheWriteTokens: 900,
      reportedPromptTokens: 11000,
      reported: true
    });
    expect(summary.hitRatio).toBeCloseTo(6400 / 11000);
    expect(summary.writeToRead).toBeCloseTo(900 / 6400);
  });

  it('reports nothing for an installation without cache data', () => {
    expect(summarizePromptCache({ prompt: { total: 5, perModel: { m: 5 } } })).toMatchObject({
      reported: false,
      hitRatio: null,
      cacheReadTokens: 0
    });
  });
});
