import { jest } from '@jest/globals';

/**
 * Unit tests for UsageAggregator.js (issue #2508): prompt-cache, reasoning
 * and web-search counters are rolled up next to prompt/completion tokens —
 * per day, per month, per user/app/model and per provider — and rollups
 * written before these counters existed still merge.
 */

const files = new Map();

jest.unstable_mockModule('fs/promises', () => ({
  default: {
    mkdir: jest.fn(async () => {}),
    writeFile: jest.fn(async (file, data) => {
      files.set(file, data);
    }),
    readFile: jest.fn(async file => {
      if (!files.has(file)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(file);
    }),
    readdir: jest.fn(async dir =>
      [...files.keys()].filter(f => f.startsWith(`${dir}/`)).map(f => f.slice(dir.length + 1))
    ),
    unlink: jest.fn(async file => files.delete(file))
  }
}));

let events = [];

jest.unstable_mockModule('../services/UsageEventLog.js', () => ({
  readEvents: async () => events,
  getDailyDir: () => '/data/usage-daily',
  getMonthlyDir: () => '/data/usage-monthly',
  cleanupEvents: async () => {},
  flushQueue: async () => 0
}));

jest.unstable_mockModule('../feedbackStorage.js', () => ({
  cleanupFeedback: async () => ({ removed: 0 })
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));

const {
  generateDailyRollups,
  generateMonthlyRollups,
  getDailyRollups,
  getMonthlyRollups,
  sumRollupDimension
} = await import('../services/UsageAggregator.js');

beforeEach(() => {
  files.clear();
  events = [];
});

const base = { uid: 'u1', app: 'chat', model: 'claude', src: 'provider' };

describe('daily rollups', () => {
  it('sums cache, reasoning and web-search counters into totals and every dimension', async () => {
    events = [
      {
        ...base,
        ts: '2026-09-01T10:00:00.000Z',
        type: 'chat_request',
        prov: 'anthropic',
        pt: 2000,
        cr: 1800,
        cw: 150
      },
      {
        ...base,
        ts: '2026-09-01T10:00:01.000Z',
        type: 'chat_response',
        prov: 'anthropic',
        ct: 50,
        rt: 10,
        ws: 1
      },
      // Written before provider/cache tracking: contributes zero, no provider.
      { ...base, ts: '2026-09-01T11:00:00.000Z', type: 'chat_request', model: 'gpt', pt: 500 }
    ];
    await generateDailyRollups();
    const [day] = await getDailyRollups('2026-09-01', '2026-09-01');

    expect(day.totals).toMatchObject({
      promptTokens: 2500,
      completionTokens: 50,
      cacheReadTokens: 1800,
      cacheWriteTokens: 150,
      reasoningTokens: 10,
      webSearchRequests: 1,
      messages: 3
    });
    expect(day.byModel.claude).toMatchObject({
      promptTokens: 2000,
      cacheReadTokens: 1800,
      cacheWriteTokens: 150
    });
    expect(day.byModel.gpt).toMatchObject({ promptTokens: 500, cacheReadTokens: 0 });
    expect(day.byApp.chat.cacheReadTokens).toBe(1800);
    expect(day.byUser.u1.cacheReadTokens).toBe(1800);
    expect(Object.keys(day.byProvider)).toEqual(['anthropic']);
    expect(day.byProvider.anthropic).toMatchObject({
      messages: 2,
      promptTokens: 2000,
      cacheReadTokens: 1800
    });
  });
});

describe('monthly rollups', () => {
  it('merge new daily files with ones written before the cache counters existed', async () => {
    files.set(
      '/data/usage-daily/2026-08-30.json',
      JSON.stringify({
        date: '2026-08-30',
        totals: { messages: 2, promptTokens: 100, completionTokens: 20, uniqueUsers: 1 },
        byUser: { u1: { messages: 2, promptTokens: 100, completionTokens: 20 } },
        byApp: { chat: { messages: 2, promptTokens: 100, completionTokens: 20 } },
        byModel: { claude: { messages: 2, promptTokens: 100, completionTokens: 20 } },
        tokenQuality: { provider: 0, estimate: 2 }
      })
    );
    events = [
      {
        ...base,
        ts: '2026-08-31T10:00:00.000Z',
        type: 'chat_request',
        prov: 'anthropic',
        pt: 1000,
        cr: 900
      }
    ];
    await generateDailyRollups();
    await generateMonthlyRollups();
    const [month] = await getMonthlyRollups('2026-08', '2026-08');

    expect(month.totals.promptTokens).toBe(1100);
    expect(month.totals.cacheReadTokens).toBe(900);
    expect(month.byModel.claude).toMatchObject({ promptTokens: 1100, cacheReadTokens: 900 });
    expect(month.byProvider.anthropic.cacheReadTokens).toBe(900);
  });
});

describe('sumRollupDimension', () => {
  it('sums a dimension across rollups, counting days on request', () => {
    const rollups = [
      {
        byModel: { m1: { messages: 1, promptTokens: 10, completionTokens: 1, cacheReadTokens: 8 } }
      },
      { byModel: { m1: { messages: 1, promptTokens: 5, completionTokens: 1 } } },
      {}
    ];
    expect(sumRollupDimension(rollups, 'byModel').m1).toMatchObject({
      messages: 2,
      promptTokens: 15,
      cacheReadTokens: 8,
      cacheWriteTokens: 0
    });
    expect(sumRollupDimension(rollups, 'byModel', { countDays: true }).m1.days).toBe(2);
  });
});
