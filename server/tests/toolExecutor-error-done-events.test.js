/**
 * Regression tests for #1792: a failed LLM call inside the tool-calling loop
 * used to fire two 'error' SSE events for the same failure (one from
 * continueWithToolExecution's own catch, one from processChatWithTools' catch
 * after the re-throw) and never emitted a terminal 'done' event, leaving the
 * client stream open with no closing event after an error.
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
  // StreamingHandler (imported transitively by ToolExecutor) needs this export
  // to exist even though the error paths under test never reach it.
  getAdapter: () => {
    throw new Error('getAdapter should not be called in this test');
  }
}));

jest.unstable_mockModule('../requestThrottler.js', () => ({
  throttledFetch: async () => {
    throw new Error('simulated provider 500');
  }
}));

// usageTracker.js schedules an un-refed, module-scope setInterval (its
// periodic save-retry loop) that keeps the process alive forever once
// imported — StreamingHandler.js (a transitive dependency of ToolExecutor.js)
// imports it purely for token/usage recording, which this test never
// exercises, so stub it out rather than dragging that timer into the suite.
jest.unstable_mockModule('../usageTracker.js', () => ({
  estimateTokens: () => 0,
  recordChatRequest: async () => {},
  recordChatResponse: async () => {}
}));

const { throttledFetch } = await import('../requestThrottler.js');
const { actionTracker } = await import('../actionTracker.js');
const { default: ToolExecutor } = await import('../services/chat/ToolExecutor.js');

function collectFireSseEvents(chatId) {
  const events = [];
  const listener = payload => {
    if (payload.chatId === chatId) events.push(payload);
  };
  actionTracker.on('fire-sse', listener);
  return {
    events,
    stop: () => actionTracker.off('fire-sse', listener)
  };
}

describe('ToolExecutor tool-loop failure SSE events (#1792)', () => {
  test('continueWithToolExecution no longer tracks error/done itself on failure — it only cleans up and re-throws', async () => {
    const toolExecutor = new ToolExecutor();
    const chatId = 'test-chat-continue-failure';
    const { events, stop } = collectFireSseEvents(chatId);

    await expect(
      toolExecutor.continueWithToolExecution({
        model: { id: 'test-model', provider: 'openai' },
        llmMessages: [{ role: 'user', content: 'hi' }],
        apiKey: 'sk-test',
        temperature: 0.7,
        maxTokens: 100,
        tools: [],
        chatId,
        buildLogData: () => ({}),
        DEFAULT_TIMEOUT: 5000,
        getLocalizedError: async () => null,
        clientLanguage: 'en',
        user: { id: 'test-user' }
      })
    ).rejects.toThrow('simulated provider 500');

    stop();

    const errorEvents = events.filter(e => e.event === 'error');
    const doneEvents = events.filter(e => e.event === 'done');
    expect(errorEvents).toHaveLength(0);
    expect(doneEvents).toHaveLength(0);
  });

  test('processChatWithTools emits exactly one error event and one terminal done event on failure', async () => {
    const toolExecutor = new ToolExecutor();
    const chatId = 'test-chat-process-failure';
    const { events, stop } = collectFireSseEvents(chatId);

    await toolExecutor.processChatWithTools({
      prep: {
        request: { url: 'https://example.invalid/chat/completions', headers: {}, body: {} },
        model: { id: 'test-model', provider: 'openai' },
        llmMessages: [{ role: 'user', content: 'hi' }],
        tools: [],
        apiKey: 'sk-test',
        temperature: 0.7,
        maxTokens: 100,
        responseFormat: undefined,
        responseSchema: undefined,
        app: {},
        userFileData: null
      },
      chatId,
      buildLogData: () => ({}),
      DEFAULT_TIMEOUT: 5000,
      getLocalizedError: async () => null,
      clientLanguage: 'en',
      user: { id: 'test-user' }
    });

    stop();

    const errorEvents = events.filter(e => e.event === 'error');
    const doneEvents = events.filter(e => e.event === 'done');
    expect(errorEvents).toHaveLength(1);
    expect(doneEvents).toHaveLength(1);
    expect(doneEvents[0].finishReason).toBe('error');
  });
});

// Keep the mocked throttledFetch referenced so bundlers/linters don't flag the
// dynamic import as unused if the mock factory above is ever inlined.
void throttledFetch;
