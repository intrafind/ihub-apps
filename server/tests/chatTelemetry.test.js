import { jest } from '@jest/globals';

/**
 * Unit tests for chatTelemetry.js (issue #2508): the request side of a model
 * call is recorded with the provider's prompt and prompt-cache counts when
 * the provider reported them, and with the estimate otherwise.
 */

const recorded = { request: [], response: [] };

jest.unstable_mockModule('../usageTracker.js', () => ({
  estimateTokens: text => Math.ceil((text || '').length / 4),
  recordChatRequest: jest.fn(async args => recorded.request.push(args)),
  recordChatResponse: jest.fn(async args => recorded.response.push(args))
}));

jest.unstable_mockModule('../telemetry/metrics.js', () => ({
  recordAppUsage: () => {},
  recordConversation: () => {},
  recordError: () => {},
  recordStreamOutcome: () => {}
}));

jest.unstable_mockModule('../telemetry/ActivityTracker.js', () => ({
  default: { recordActivity: () => {} }
}));

const { recordChatCallStart, recordChatCallEnd, recordChatCallRequest } =
  await import('../services/chat/chatTelemetry.js');

const baseLog = { appId: 'a1', userSessionId: 's1', user: { id: 'u1' } };
const model = { id: 'm1', provider: 'anthropic', modelId: 'claude' };

beforeEach(() => {
  recorded.request.length = 0;
  recorded.response.length = 0;
});

describe('recordChatCallStart', () => {
  it('returns the estimate without recording the request yet', async () => {
    const request = await recordChatCallStart({
      baseLog,
      chatId: 'c1',
      model,
      messages: [{ role: 'user', content: 'x'.repeat(40) }]
    });
    expect(request.promptTokens).toBeGreaterThan(0);
    expect(recorded.request).toHaveLength(0);
  });
});

describe('recordChatCallEnd', () => {
  it('records provider prompt tokens and cache counts on a completed call', async () => {
    await recordChatCallEnd({
      baseLog,
      model,
      request: { promptTokens: 12 },
      usage: {
        promptTokens: 2009,
        completionTokens: 57,
        cacheReadTokens: 1800,
        cacheWriteTokens: 188,
        reasoningTokens: 20,
        source: 'provider'
      },
      outcome: 'completed'
    });
    expect(recorded.request).toEqual([
      expect.objectContaining({
        tokens: 2009,
        tokenSource: 'provider',
        cacheReadTokens: 1800,
        cacheWriteTokens: 188,
        provider: 'anthropic',
        modelId: 'm1'
      })
    ]);
    expect(recorded.response).toEqual([
      expect.objectContaining({
        tokens: 57,
        tokenSource: 'provider',
        reasoningTokens: 20,
        provider: 'anthropic'
      })
    ]);
  });

  it('falls back to the estimate when the provider reported no usage', async () => {
    await recordChatCallEnd({
      baseLog,
      model,
      request: { promptTokens: 12 },
      usage: null,
      content: 'abcd',
      outcome: 'completed'
    });
    expect(recorded.request[0]).toMatchObject({ tokens: 12, tokenSource: 'estimate' });
    expect(recorded.request[0].cacheReadTokens).toBeUndefined();
    expect(recorded.response[0]).toMatchObject({ tokenSource: 'estimate' });
  });

  it('records the estimate for a call that was aborted mid-way, and no response', async () => {
    await recordChatCallEnd({
      baseLog,
      model,
      request: { promptTokens: 30 },
      outcome: 'aborted'
    });
    expect(recorded.request[0]).toMatchObject({ tokens: 30, tokenSource: 'estimate' });
    expect(recorded.response).toHaveLength(0);
  });

  it('records no request when none was pending (already recorded at stepEnd)', async () => {
    await recordChatCallEnd({ baseLog, model, outcome: 'error', error: new Error('x') });
    expect(recorded.request).toHaveLength(0);
  });
});

describe('recordChatCallRequest', () => {
  it('ignores usage marked as an estimate', async () => {
    await recordChatCallRequest({
      baseLog,
      model,
      request: { promptTokens: 7 },
      usage: { promptTokens: 999, cacheReadTokens: 5, source: 'estimate' }
    });
    expect(recorded.request[0]).toMatchObject({ tokens: 7, tokenSource: 'estimate' });
    expect(recorded.request[0].cacheReadTokens).toBeUndefined();
  });
});
