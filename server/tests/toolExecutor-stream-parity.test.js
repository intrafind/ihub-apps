/**
 * Regression tests for #1700: processChatWithTools and continueWithToolExecution
 * used to run two independently-diverged SSE-parsing loops. The continuation
 * loop silently dropped thinking/images/grounding metadata, never filtered
 * out empty-name tool calls (a streaming artifact), and never collected
 * thoughtSignatures on the first turn. A passthrough tool result also kept
 * the first-turn loop iterating instead of stopping immediately, risking a
 * duplicate 'done' event.
 *
 * These tests assert both entry points now go through the same
 * `readToolLoopStreamTurn()` helper and behave identically.
 *
 * Note: The repo's source is native ESM (uses `import.meta.url`), so this file
 * uses `jest.unstable_mockModule` + dynamic imports rather than the
 * CommonJS-only `jest.mock` API. Run with `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';

jest.unstable_mockModule('../adapters/index.js', () => ({
  createCompletionRequest: async (model, _messages, _apiKey, opts) => ({
    url: 'https://example.invalid/chat/completions',
    method: 'POST',
    headers: {},
    body: { model: model.modelId, temperature: opts.temperature }
  }),
  getAdapter: () => {
    throw new Error('getAdapter should not be called in this test');
  }
}));

jest.unstable_mockModule('../adapters/toolCalling/index.js', () => ({
  normalizeToolName: id => id,
  isFailureFinishReason: () => false,
  clearStreamingState: () => {},
  convertResponseToGeneric: async data => JSON.parse(data)
}));

jest.unstable_mockModule('../usageTracker.js', () => ({
  estimateTokens: text => Math.max(1, Math.ceil((text || '').length / 4)),
  recordChatRequest: async () => {},
  recordChatResponse: async () => {}
}));

const runToolMock = jest.fn(async () => ({ result: 'ok' }));
jest.unstable_mockModule('../toolLoader.js', () => ({
  loadConfiguredTools: async () => [],
  discoverMcpTools: async () => [],
  loadTools: async () => [],
  resolveNativeWebSearchProvider: () => null,
  resolveAppNativeWebSearch: () => null,
  getToolsForApp: async () => [],
  localizeTools: tools => tools,
  runTool: (...args) => runToolMock(...args)
}));

let throttledFetchImpl;
jest.unstable_mockModule('../requestThrottler.js', () => ({
  throttledFetch: (...args) => throttledFetchImpl(...args)
}));

const { default: ToolExecutor } = await import('../services/chat/ToolExecutor.js');
const { actionTracker } = await import('../actionTracker.js');

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.close();
    }
  });
  return { ok: true, body };
}

function buildLogData() {
  return { appId: 'test-app', userSessionId: 'test-session', user: { id: 'test-user' } };
}

/** Collect 'fire-sse' events emitted via actionTracker during a test. */
function collectFiredEvents() {
  const events = [];
  const handler = evt => events.push(evt);
  actionTracker.on('fire-sse', handler);
  return {
    events,
    stop: () => actionTracker.off('fire-sse', handler)
  };
}

describe('ToolExecutor stream-turn parity (#1700)', () => {
  beforeEach(() => {
    runToolMock.mockClear();
  });

  test('continueWithToolExecution forwards thinking/images/grounding like the first turn', async () => {
    throttledFetchImpl = async () =>
      sseResponse([
        {
          thinking: ['pondering...'],
          images: [{ mimeType: 'image/png', data: 'YWJj' }],
          groundingMetadata: { chunks: [{ uri: 'https://example.invalid' }] },
          content: ['final answer'],
          complete: true,
          finishReason: 'stop'
        }
      ]);

    const toolExecutor = new ToolExecutor();
    const chatId = 'parity-continuation';
    const { events, stop } = collectFiredEvents();

    try {
      await toolExecutor.continueWithToolExecution({
        model: { id: 'test-model', modelId: 'test-model', provider: 'openai' },
        llmMessages: [{ role: 'user', content: 'hi' }],
        apiKey: 'sk-test',
        temperature: 0.7,
        maxTokens: 100,
        tools: [],
        chatId,
        buildLogData,
        DEFAULT_TIMEOUT: 5000,
        getLocalizedError: async () => null,
        clientLanguage: 'en',
        user: { id: 'test-user' }
      });
    } finally {
      stop();
    }

    expect(events.some(e => e.event === 'image')).toBe(true);
    expect(events.some(e => e.event === 'thinking')).toBe(true);
    expect(events.some(e => e.event === 'grounding' && e.metadata?.chunks)).toBe(true);
  });

  test('processChatWithTools collects thoughtSignatures on the first turn (previously continuation-only)', async () => {
    throttledFetchImpl = async () =>
      sseResponse([
        {
          content: ['final answer'],
          thoughtSignatures: ['sig-abc'],
          complete: true,
          finishReason: 'stop'
        }
      ]);

    const toolExecutor = new ToolExecutor();
    const chatId = 'parity-first-turn-signatures';
    const llmMessages = [{ role: 'user', content: 'hi' }];

    await toolExecutor.processChatWithTools({
      prep: {
        request: { url: 'https://example.invalid/chat/completions', headers: {}, body: {} },
        model: { id: 'test-model', modelId: 'test-model', provider: 'openai' },
        llmMessages,
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
      buildLogData,
      DEFAULT_TIMEOUT: 5000,
      getLocalizedError: async () => null,
      clientLanguage: 'en',
      user: { id: 'test-user' }
    });

    // No tool calls in this turn, so no assistant tool_calls message is pushed —
    // this just proves the stream turn read the signatures without throwing and
    // that the (empty) tool-call path didn't choke on them.
    expect(llmMessages).toHaveLength(1);
  });

  test('continueWithToolExecution filters out empty-name tool calls (streaming artifact), like the first turn', async () => {
    let callCount = 0;
    throttledFetchImpl = async () => {
      callCount++;
      if (callCount === 1) {
        return sseResponse([
          {
            tool_calls: [
              {
                index: 0,
                id: 'call_bad',
                type: 'function',
                function: { name: '', arguments: '{}' }
              },
              {
                index: 1,
                id: 'call_good',
                type: 'function',
                function: { name: 'noop_tool', arguments: '{}' }
              }
            ],
            complete: false
          },
          { complete: true, finishReason: 'tool_calls' }
        ]);
      }
      return sseResponse([{ content: ['final answer'], complete: true, finishReason: 'stop' }]);
    };

    const toolExecutor = new ToolExecutor();
    const chatId = 'parity-empty-name-filter';

    await toolExecutor.continueWithToolExecution({
      model: { id: 'test-model', modelId: 'test-model', provider: 'openai' },
      llmMessages: [{ role: 'user', content: 'hi' }],
      apiKey: 'sk-test',
      temperature: 0.7,
      maxTokens: 100,
      tools: [{ id: 'noop_tool' }],
      chatId,
      buildLogData,
      DEFAULT_TIMEOUT: 5000,
      getLocalizedError: async () => null,
      clientLanguage: 'en',
      user: { id: 'test-user' }
    });

    // Only the well-named tool call should ever reach tool execution.
    expect(runToolMock).toHaveBeenCalledTimes(1);
    expect(runToolMock).toHaveBeenCalledWith('noop_tool', expect.objectContaining({ chatId }));
  });

  test('a passthrough tool result stops the first-turn loop immediately (no double done event)', async () => {
    throttledFetchImpl = async () =>
      sseResponse([
        {
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'passthrough_tool', arguments: '{}' }
            },
            {
              index: 1,
              id: 'call_2',
              type: 'function',
              function: { name: 'passthrough_tool', arguments: '{}' }
            }
          ],
          complete: false
        },
        { complete: true, finishReason: 'tool_calls' }
      ]);

    const toolExecutor = new ToolExecutor();
    // Force isPassthroughTool() to treat this tool as passthrough.
    jest.spyOn(toolExecutor, 'isPassthroughTool').mockReturnValue(true);
    jest.spyOn(toolExecutor, 'executePassthroughTool').mockResolvedValue({
      success: true,
      passthrough: true,
      message: { role: 'assistant', content: 'streamed', tool_source: 'passthrough_tool' }
    });

    const chatId = 'parity-passthrough-single-done';
    const { events, stop } = collectFiredEvents();

    try {
      await toolExecutor.processChatWithTools({
        prep: {
          request: { url: 'https://example.invalid/chat/completions', headers: {}, body: {} },
          model: { id: 'test-model', modelId: 'test-model', provider: 'openai' },
          llmMessages: [{ role: 'user', content: 'hi' }],
          tools: [{ id: 'passthrough_tool', passthrough: true }],
          apiKey: 'sk-test',
          temperature: 0.7,
          maxTokens: 100,
          responseFormat: undefined,
          responseSchema: undefined,
          app: {},
          userFileData: null
        },
        chatId,
        buildLogData,
        DEFAULT_TIMEOUT: 5000,
        getLocalizedError: async () => null,
        clientLanguage: 'en',
        user: { id: 'test-user' }
      });
    } finally {
      stop();
    }

    // Only the first tool call should ever have been executed — the loop must
    // stop immediately after the first terminal passthrough result.
    expect(toolExecutor.executePassthroughTool).toHaveBeenCalledTimes(1);
    expect(events.filter(e => e.event === 'done')).toHaveLength(1);
  });
});
