import { jest } from '@jest/globals';

/**
 * Unit tests for usageTracker.js — the request/response collapse
 * (recordChatMessage), the shared rating helpers (computeAverageRating /
 * applyRating), and how a worker's counts are added to the usage.json every
 * worker shares. The shared file is an in-memory string here.
 */

// usage.json, as every worker sees it on disk.
let fileContents = null;

jest.unstable_mockModule('../utils/sharedJsonFile.js', () => ({
  createSharedJsonFile: ({ createDefault }) => {
    const readFile = () => (fileContents === null ? createDefault() : JSON.parse(fileContents));
    return {
      read: async () => readFile(),
      update: async mutate => {
        const data = readFile();
        const result = await mutate(data);
        fileContents = JSON.stringify(data, null, 2);
        return result;
      }
    };
  }
}));

jest.unstable_mockModule('../featureRegistry.js', () => ({
  isFeatureEnabled: () => true
}));

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getFeatures: () => ({}),
    getPlatform: () => ({ features: { usageTrackingMode: 'pseudonymous' } })
  }
}));

jest.unstable_mockModule('../services/UserFingerprint.js', () => ({
  resolveUserId: async userId => userId || 'anonymous'
}));

jest.unstable_mockModule('../services/UsageEventLog.js', () => ({
  logUsageEvent: () => {}
}));

jest.unstable_mockModule('../telemetry.js', () => ({
  recordTokenUsage: () => {}
}));

jest.unstable_mockModule('../telemetry/metrics.js', () => ({
  recordMagicPromptUsage: () => {},
  recordFeedbackEvent: () => {}
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));

// The flush to usage.json is timed; fake timers let tests drive it.
jest.useFakeTimers();

const { recordChatRequest, recordChatResponse, recordFeedback, getUsage, resetUsage, flushUsage } =
  await import('../usageTracker.js');

afterAll(() => {
  jest.useRealTimers();
});

beforeEach(async () => {
  fileContents = null;
  await resetUsage();
});

describe('recordChatRequest / recordChatResponse', () => {
  it('bump shared message/token counters and their own prompt/completion bucket independently', async () => {
    await recordChatRequest({ userId: 'u1', appId: 'a1', modelId: 'm1', tokens: 10 });
    await recordChatResponse({ userId: 'u1', appId: 'a1', modelId: 'm1', tokens: 25 });

    const usage = await getUsage();
    expect(usage.messages.total).toBe(2);
    expect(usage.tokens.total).toBe(35);
    expect(usage.tokens.prompt.total).toBe(10);
    expect(usage.tokens.completion.total).toBe(25);
    expect(usage.tokens.prompt.perUser.u1).toBe(10);
    expect(usage.tokens.completion.perUser.u1).toBe(25);
    expect(usage.tokens.perUser.u1).toBe(35);
  });

  it('records prompt-cache and reasoning counts per model, app, user and provider', async () => {
    await recordChatRequest({
      userId: 'u1',
      appId: 'a1',
      modelId: 'm1',
      provider: 'anthropic',
      tokens: 2000,
      tokenSource: 'provider',
      cacheReadTokens: 1800,
      cacheWriteTokens: 150
    });
    await recordChatResponse({
      userId: 'u1',
      appId: 'a1',
      modelId: 'm1',
      provider: 'anthropic',
      tokens: 40,
      tokenSource: 'provider',
      reasoningTokens: 12
    });

    const usage = await getUsage();
    expect(usage.tokens.prompt.total).toBe(2000);
    expect(usage.tokens.prompt.perProvider.anthropic).toBe(2000);
    expect(usage.tokens.cacheRead.total).toBe(1800);
    expect(usage.tokens.cacheRead.perModel.m1).toBe(1800);
    expect(usage.tokens.cacheRead.perApp.a1).toBe(1800);
    expect(usage.tokens.cacheRead.perUser.u1).toBe(1800);
    expect(usage.tokens.cacheRead.perProvider.anthropic).toBe(1800);
    expect(usage.tokens.cacheWrite.total).toBe(150);
    expect(usage.tokens.reasoning.total).toBe(12);
    // Cache counts are subsets of the prompt: they never add to the token total.
    expect(usage.tokens.total).toBe(2040);
    expect(usage.tokenSources.provider).toBe(2);
  });

  it('adds cache buckets to a usage.json written before they existed', async () => {
    const legacy = await getUsage();
    delete legacy.tokens.cacheRead;
    delete legacy.tokens.cacheWrite;
    delete legacy.tokens.reasoning;
    delete legacy.tokens.prompt.perProvider;
    fileContents = JSON.stringify(legacy, null, 2);

    await recordChatRequest({
      userId: 'u1',
      appId: 'a1',
      modelId: 'm1',
      provider: 'openai',
      tokens: 100,
      cacheReadTokens: 64
    });

    const usage = await getUsage();
    expect(usage.tokens.cacheRead.total).toBe(64);
    expect(usage.tokens.prompt.perProvider.openai).toBe(100);
  });

  it('leaves the cache buckets untouched when the provider reported no cache counts', async () => {
    await recordChatRequest({ userId: 'u1', appId: 'a1', modelId: 'm1', tokens: 10 });
    const usage = await getUsage();
    expect(usage.tokens.cacheRead.total).toBe(0);
    expect(usage.tokens.cacheRead.perModel.m1).toBeUndefined();
  });
});

describe('recordFeedback', () => {
  it('numeric rating updates top-level ratings/total/averageRating and matching per-* buckets consistently', async () => {
    await recordFeedback({ userId: 'u1', appId: 'a1', modelId: 'm1', rating: 5 });
    await recordFeedback({ userId: 'u2', appId: 'a1', modelId: 'm1', rating: 1 });

    const usage = await getUsage();
    expect(usage.feedback.total).toBe(2);
    expect(usage.feedback.ratings[5]).toBe(1);
    expect(usage.feedback.ratings[1]).toBe(1);
    expect(usage.feedback.averageRating).toBe(3);
    expect(usage.feedback.good).toBe(1);
    expect(usage.feedback.bad).toBe(1);

    // Per-app bucket must agree with the top-level totals it feeds into.
    expect(usage.feedback.perApp.a1.total).toBe(2);
    expect(usage.feedback.perApp.a1.averageRating).toBe(3);
  });

  it('legacy string rating only bumps good/bad, not ratings/total', async () => {
    await recordFeedback({ userId: 'u1', appId: 'a1', modelId: 'm1', rating: 'positive' });

    const usage = await getUsage();
    expect(usage.feedback.good).toBe(1);
    expect(usage.feedback.bad).toBe(0);
    expect(usage.feedback.total).toBe(0);
    expect(usage.feedback.perUser.u1.good).toBe(1);
  });
});

describe('several workers', () => {
  it('adds this worker’s counts to what other workers flushed, losing neither', async () => {
    await recordChatRequest({ userId: 'u1', appId: 'a1', modelId: 'm1', tokens: 10 });

    // Another worker flushed its own counts meanwhile.
    const onDisk = JSON.parse(fileContents);
    onDisk.messages.total += 5;
    onDisk.messages.perApp.a1 = (onDisk.messages.perApp.a1 || 0) + 5;
    onDisk.feedback.ratings[4] += 1;
    onDisk.feedback.total += 1;
    fileContents = JSON.stringify(onDisk);

    await recordFeedback({ userId: 'u1', appId: 'a1', modelId: 'm1', rating: 2 });
    const usage = await getUsage();
    expect(usage.messages.total).toBe(6);
    expect(usage.messages.perApp.a1).toBe(6);
    expect(usage.feedback.total).toBe(2);
    expect(usage.feedback.averageRating).toBe(3);

    // And once flushed, the file holds the sum.
    await jest.advanceTimersByTimeAsync(10000);
    const flushed = JSON.parse(fileContents);
    expect(flushed.messages.total).toBe(6);
    expect(flushed.feedback.averageRating).toBe(3);
  });

  it('drops counts gathered before another worker reset the usage', async () => {
    await recordChatRequest({ userId: 'u1', appId: 'a1', modelId: 'm1', tokens: 10 });

    // Another worker resets: the file is cleared and stamped.
    await jest.advanceTimersByTimeAsync(5);
    const cleared = JSON.parse(fileContents);
    cleared.messages = { total: 0, perUser: {}, perApp: {}, perModel: {} };
    cleared.lastReset = new Date(Date.now() + 1).toISOString();
    fileContents = JSON.stringify(cleared);

    expect((await getUsage()).messages.total).toBe(0);
    await jest.advanceTimersByTimeAsync(10000);
    expect(JSON.parse(fileContents).messages.total).toBe(0);

    // Counted after the reset is kept.
    await recordChatRequest({ userId: 'u1', appId: 'a1', modelId: 'm1', tokens: 10 });
    await jest.advanceTimersByTimeAsync(10000);
    expect(JSON.parse(fileContents).messages.total).toBe(1);
  });

  it('a usage.json without lastReset still takes this worker’s counts', async () => {
    const legacy = JSON.parse(fileContents);
    delete legacy.lastReset;
    fileContents = JSON.stringify(legacy);

    await recordChatRequest({ userId: 'u1', appId: 'a1', modelId: 'm1', tokens: 10 });
    await jest.advanceTimersByTimeAsync(10000);

    expect(JSON.parse(fileContents).messages.total).toBe(1);
  });

  it('flushUsage writes pending counts right away', async () => {
    await recordChatRequest({ userId: 'u1', appId: 'a1', modelId: 'm1', tokens: 10 });
    await flushUsage();
    expect(JSON.parse(fileContents).messages.total).toBe(1);
  });

  it('a reset is not undone by counts recorded before it', async () => {
    await recordChatRequest({ userId: 'u1', appId: 'a1', modelId: 'm1', tokens: 10 });
    await resetUsage();
    await jest.advanceTimersByTimeAsync(10000);

    expect(JSON.parse(fileContents).messages.total).toBe(0);
    expect((await getUsage()).messages.total).toBe(0);
  });
});

describe('getUsage', () => {
  it('reflects usage flushed by another worker instead of a permanently stale in-memory copy', async () => {
    const before = await getUsage();
    expect(before.messages.total).toBe(0);

    // Simulate a sibling worker process — separate in-memory cache, same
    // usage.json — having recorded and flushed its own usage independently.
    // Nothing local has been recorded here, so this worker is not dirty and
    // would otherwise keep serving the cached copy it loaded at start.
    const remoteUsage = { ...before, messages: { ...before.messages, total: 7 } };
    fileContents = JSON.stringify(remoteUsage, null, 2);

    const after = await getUsage();
    expect(after.messages.total).toBe(7);
  });
});
