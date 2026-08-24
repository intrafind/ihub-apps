/**
 * Regression test for #1727: ToolExecutor is a process-wide singleton and its
 * clarificationCounts Map (chatId -> count) had no eviction, so it grew
 * unbounded for the life of the process. This mirrors searchCache.js's
 * bounded, insertion-ordered, evict-oldest pattern instead.
 *
 * Note: The repo's source is native ESM (uses `import.meta.url`), so this file
 * uses `jest.unstable_mockModule` + dynamic imports rather than the
 * CommonJS-only `jest.mock` API. Run with `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';

jest.unstable_mockModule('../adapters/index.js', () => ({
  createCompletionRequest: async () => ({
    url: 'https://example.invalid/chat/completions',
    method: 'POST',
    headers: {},
    body: {}
  }),
  getAdapter: () => {
    throw new Error('getAdapter should not be called in this test');
  }
}));

jest.unstable_mockModule('../requestThrottler.js', () => ({
  throttledFetch: async () => {
    throw new Error('should not be called in this test');
  }
}));

jest.unstable_mockModule('../usageTracker.js', () => ({
  estimateTokens: () => 0,
  recordChatRequest: async () => {},
  recordChatResponse: async () => {}
}));

const { default: ToolExecutor } = await import('../services/chat/ToolExecutor.js');

const MAX_CHAT_ENTRIES = 5000;

describe('ToolExecutor clarificationCounts cap (#1727)', () => {
  test('evicts the oldest chatId once the cap is exceeded instead of growing unbounded', () => {
    const toolExecutor = new ToolExecutor();

    for (let i = 0; i < MAX_CHAT_ENTRIES; i++) {
      toolExecutor.incrementClarificationCount(`chat-${i}`);
    }
    expect(toolExecutor.clarificationCounts.size).toBe(MAX_CHAT_ENTRIES);
    expect(toolExecutor.getClarificationCount('chat-0')).toBe(1);

    toolExecutor.incrementClarificationCount('chat-overflow');

    expect(toolExecutor.clarificationCounts.size).toBe(MAX_CHAT_ENTRIES);
    expect(toolExecutor.getClarificationCount('chat-0')).toBe(0);
    expect(toolExecutor.getClarificationCount('chat-overflow')).toBe(1);
  });

  test('re-incrementing an existing chatId does not evict and keeps counting', () => {
    const toolExecutor = new ToolExecutor();

    toolExecutor.incrementClarificationCount('chat-a');
    toolExecutor.incrementClarificationCount('chat-b');
    toolExecutor.incrementClarificationCount('chat-a');

    expect(toolExecutor.getClarificationCount('chat-a')).toBe(2);
    expect(toolExecutor.getClarificationCount('chat-b')).toBe(1);
    expect(toolExecutor.clarificationCounts.size).toBe(2);
  });
});
