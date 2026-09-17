import { jest } from '@jest/globals';

/**
 * Unit tests for usageTracker.js — focused on the request/response collapse
 * (recordChatMessage) and the shared rating helpers (computeAverageRating /
 * applyRating) added to deduplicate what used to be three copies of the same
 * rating math. Disk I/O and dynamic config imports are mocked so tests run
 * against an in-memory usage object only.
 */

let fileContents = null;

jest.unstable_mockModule('fs/promises', () => ({
  default: {
    readFile: jest.fn(async () => {
      if (fileContents === null) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return fileContents;
    }),
    writeFile: jest.fn(async (_file, data) => {
      fileContents = data;
    }),
    mkdir: jest.fn(async () => {})
  }
}));

// debouncedJsonStore saves via atomicWriteJSON (write-temp-then-rename), which
// internally imports { promises as fs } from 'fs' rather than 'fs/promises' —
// mock the utility directly so tests never touch the real filesystem.
jest.unstable_mockModule('../utils/atomicWrite.js', () => ({
  atomicWriteJSON: jest.fn(async (_file, data) => {
    fileContents = JSON.stringify(data, null, 2);
  })
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

const { recordChatRequest, recordChatResponse, recordFeedback, getUsage, resetUsage } =
  await import('../usageTracker.js');

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
