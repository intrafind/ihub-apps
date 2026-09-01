/**
 * Regression tests for #1724: ToolExecutor (the path taken by every
 * tool-enabled app) never recorded usage tokens for its LLM round-trips —
 * every app with `tools` configured was invisible in usage tracking. These
 * tests assert `recordChatRequest`/`recordChatResponse` now fire once per LLM
 * call, including once per iteration of the tool-calling loop.
 *
 * Note: The repo's source is native ESM (uses `import.meta.url`), so this file
 * uses `jest.unstable_mockModule` + dynamic imports rather than the
 * CommonJS-only `jest.mock` API. Run with `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';

const recordChatRequestMock = jest.fn(async () => {});
const recordChatResponseMock = jest.fn(async () => {});

jest.unstable_mockModule('../adapters/index.js', () => ({
  createCompletionRequest: async (model, _messages, _apiKey, opts) => ({
    url: 'https://example.invalid/chat/completions',
    method: 'POST',
    headers: {},
    body: { model: model.modelId, temperature: opts.temperature }
  }),
  // ToolExecutor now delegates stream parsing to the provider adapter (like
  // StreamingHandler already did) instead of hand-rolling SSE parsing, so the
  // fake adapter just replays the pre-built generic result chunks directly —
  // bypassing real provider-specific wire-format parsing, which isn't what's
  // under test here.
  getAdapter: () => ({
    parseResponseStream: async function* (response) {
      for (const chunk of response.chunks) {
        yield chunk;
      }
    }
  })
}));

jest.unstable_mockModule('../adapters/toolCalling/index.js', () => ({
  normalizeToolName: id => id,
  isFailureFinishReason: () => false,
  clearStreamingState: () => {},
  // Unused by ToolExecutor directly, but utils.js (a transitive dependency)
  // statically imports it, so the mock module must still provide it.
  convertResponseToGeneric: async () => ({})
}));

// usageTracker.js also schedules an un-refed, module-scope setInterval (its
// periodic save-retry loop) that keeps the process alive forever once
// imported for real — stub it out with spies so these tests can assert on it
// without dragging that timer into the suite.
jest.unstable_mockModule('../usageTracker.js', () => ({
  estimateTokens: text => Math.max(1, Math.ceil((text || '').length / 4)),
  recordChatRequest: recordChatRequestMock,
  recordChatResponse: recordChatResponseMock
}));

jest.unstable_mockModule('../toolLoader.js', () => ({
  // Other modules transitively imported by ToolExecutor.js (e.g. configCache.js)
  // statically import several of these named exports, so they all need to
  // exist even though this suite only exercises runTool.
  loadConfiguredTools: async () => [],
  discoverMcpTools: async () => [],
  loadTools: async () => [],
  resolveNativeWebSearchProvider: () => null,
  resolveAppNativeWebSearch: () => null,
  getToolsForApp: async () => [],
  localizeTools: tools => tools,
  runTool: async () => ({ result: 'ok' })
}));

let throttledFetchImpl;
jest.unstable_mockModule('../requestThrottler.js', () => ({
  throttledFetch: (...args) => throttledFetchImpl(...args)
}));

const { default: ToolExecutor } = await import('../services/chat/ToolExecutor.js');

/**
 * Build a fetch-like Response carrying the pre-built generic result chunks
 * that the fake adapter (mocked above) replays as-is via parseResponseStream.
 */
function sseResponse(chunks) {
  return { ok: true, chunks };
}

function buildLogData() {
  return { appId: 'test-app', userSessionId: 'test-session', user: { id: 'test-user' } };
}

describe('ToolExecutor usage/telemetry recording (#1724)', () => {
  beforeEach(() => {
    recordChatRequestMock.mockClear();
    recordChatResponseMock.mockClear();
  });

  test('processChatWithTools records one request/response pair for a no-tool-call turn', async () => {
    throttledFetchImpl = async () =>
      sseResponse([{ content: ['hi there'], complete: true, finishReason: 'stop' }]);

    const toolExecutor = new ToolExecutor();
    const chatId = 'telemetry-no-tools';

    await toolExecutor.processChatWithTools({
      prep: {
        request: { url: 'https://example.invalid/chat/completions', headers: {}, body: {} },
        model: { id: 'test-model', modelId: 'test-model', provider: 'openai' },
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
      buildLogData,
      DEFAULT_TIMEOUT: 5000,
      getLocalizedError: async () => null,
      clientLanguage: 'en',
      user: { id: 'test-user' }
    });

    expect(recordChatRequestMock).toHaveBeenCalledTimes(1);
    expect(recordChatResponseMock).toHaveBeenCalledTimes(1);
  });

  test('continueWithToolExecution records one request/response pair per LLM call, not once per conversation', async () => {
    let callCount = 0;
    throttledFetchImpl = async () => {
      callCount++;
      if (callCount === 1) {
        // First iteration: model asks for a tool call.
        return sseResponse([
          {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'noop_tool', arguments: '{}' }
              }
            ],
            complete: false
          },
          { complete: true, finishReason: 'tool_calls' }
        ]);
      }
      // Second iteration: model returns the final answer.
      return sseResponse([{ content: ['final answer'], complete: true, finishReason: 'stop' }]);
    };

    const toolExecutor = new ToolExecutor();
    const chatId = 'telemetry-tool-loop';

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

    expect(callCount).toBe(2);
    expect(recordChatRequestMock).toHaveBeenCalledTimes(2);
    expect(recordChatResponseMock).toHaveBeenCalledTimes(2);
  });
});
