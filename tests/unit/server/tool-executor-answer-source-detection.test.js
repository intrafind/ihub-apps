/**
 * @jest-environment node
 *
 * End-to-end detection coverage for the "answer source" badge on the TOOLS
 * path (processChatWithTools).
 *
 * Apps with tools enabled route through ToolExecutor, not StreamingHandler.
 * The tool loop reads the LLM stream via a Web ReadableStream reader, which
 * needs the Node environment (jsdom lacks setImmediate). This drives the real
 * loop with a mocked (no-tool-call) LLM stream and asserts that a fileData /
 * imageData message produces an answer.source event with ['file'].
 *
 * Regression guard: processChatWithTools handles the INITIAL LLM call. When the
 * model answers directly from an upload (no tool call) it took a terminal path
 * that emitted 'done' WITHOUT the answer-source badge, so tool-enabled apps
 * reported "Based on AI knowledge" for uploaded files. continueWithToolExecution
 * (the multi-iteration loop) was already fixed; this guards the first-call path.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../../server/pathUtils.js', () => ({
  getRootDir: () => require('path').join(__dirname, '../../../')
}));

jest.mock('../../../server/configCache.js', () => ({
  default: {
    getPlatform: () => ({}),
    getApps: () => ({ data: [] }),
    getModels: () => ({ data: [] })
  }
}));

jest.mock('../../../server/requestThrottler.js', () => ({
  throttledFetch: jest.fn(async () => ({
    ok: true,
    body: (() => {
      const encoder = new TextEncoder();
      return new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"final":true}\n\n'));
          controller.close();
        }
      });
    })()
  }))
}));

jest.mock('../../../server/adapters/toolCalling/index.js', () => ({
  clearStreamingState: jest.fn(),
  normalizeToolName: x => x,
  // Unused by ToolExecutor directly, but utils.js (a transitive dependency)
  // statically imports it, so the mock module must still provide it.
  convertResponseToGeneric: jest.fn(async () => ({}))
}));

// ToolExecutor delegates stream parsing to the provider adapter's
// parseResponseStream(); yield a final answer with no tool calls so the loop
// terminates immediately.
jest.mock('../../../server/adapters/index.js', () => ({
  createCompletionRequest: jest.fn(),
  getAdapter: () => ({
    parseResponseStream: async function* () {
      yield {
        content: ['Here is your answer.'],
        finishReason: 'stop',
        complete: true,
        tool_calls: []
      };
    }
  })
}));

jest.mock('../../../server/toolLoader.js', () => ({
  runTool: jest.fn(),
  getToolsForApp: jest.fn(async () => []),
  loadTools: jest.fn(async () => [])
}));

jest.mock('../../../server/tools/askUser.js', () => ({
  MAX_CLARIFICATIONS_PER_CONVERSATION: 5,
  validateAskUserParams: jest.fn()
}));

jest.mock('../../../server/utils.js', () => ({
  logInteraction: jest.fn(),
  getErrorDetails: jest.fn(() => ({ message: 'err', code: 'ERR' }))
}));

jest.mock('../../../server/usageTracker.js', () => ({
  estimateTokens: jest.fn(() => 0),
  recordChatRequest: jest.fn(),
  recordChatResponse: jest.fn()
}));

jest.mock('../../../server/telemetry.js', () => ({
  getGenAIInstrumentation: () => ({ isEnabled: () => false })
}));

jest.mock('../../../server/telemetry/metrics.js', () => ({
  recordAppUsage: jest.fn(),
  recordConversation: jest.fn(),
  recordError: jest.fn(),
  recordStreamOutcome: jest.fn()
}));

jest.mock('../../../server/telemetry/ActivityTracker.js', () => ({
  __esModule: true,
  default: { recordActivity: jest.fn() }
}));

jest.mock('../../../server/telemetry/providerMap.js', () => ({
  resolveProviderName: () => 'openai',
  resolveOperation: () => 'chat'
}));

jest.mock('../../../server/services/integrations/ConversationStateManager.js', () => ({
  __esModule: true,
  default: { updateParentId: jest.fn() }
}));

jest.mock('../../../server/services/PromptService.js', () => ({
  __esModule: true,
  default: {
    getPromptSources: jest.fn(() => []),
    resetPromptSources: jest.fn()
  }
}));

import ToolExecutor from '../../../server/services/chat/ToolExecutor.js';
import { actionTracker } from '../../../server/actionTracker.js';

async function captureEvents(fn) {
  const events = [];
  const listener = e => events.push(e);
  actionTracker.on('fire-sse', listener);
  try {
    await fn();
  } finally {
    actionTracker.off('fire-sse', listener);
  }
  return events;
}

function prep(llmMessages) {
  return {
    request: { url: 'https://example.test/v1/chat', headers: {}, body: {} },
    model: { id: 'gpt-test', provider: 'openai', modelId: 'gpt-test' },
    llmMessages,
    tools: [{ id: 'noop' }],
    apiKey: 'k',
    temperature: 0.7,
    maxTokens: 1024,
    responseFormat: 'markdown',
    responseSchema: null,
    app: { id: 'test-app' },
    userFileData: null
  };
}

describe('ToolExecutor answer-source detection (tools path)', () => {
  let executor;
  beforeEach(() => {
    executor = new ToolExecutor();
  });

  it('emits answer.source ["file"] for a document upload in an app with tools', async () => {
    const llmMessages = [
      {
        role: 'user',
        content: '[File: report.txt (TXT)]\n\nnumbers...\n\nSummarize',
        fileData: { fileName: 'report.txt', fileType: 'text/plain', content: 'numbers...' }
      }
    ];

    const events = await captureEvents(() =>
      executor.processChatWithTools({
        prep: prep(llmMessages),
        chatId: 'chat-tools-file',
        buildLogData: () => ({ appId: 'test-app', userSessionId: 's', user: { id: 'u' } }),
        DEFAULT_TIMEOUT: 30000,
        getLocalizedError: async k => `err:${k}`,
        clientLanguage: 'en',
        user: { id: 'u' }
      })
    );

    const answerSource = events.find(e => e.event === 'answer.source');
    expect(answerSource).toBeDefined();
    expect(answerSource.sources).toEqual(['file']);
  });

  it('emits answer.source ["file"] for an image upload in an app with tools', async () => {
    const llmMessages = [
      {
        role: 'user',
        content: 'Describe this',
        imageData: { base64: 'AAAA', fileType: 'image/png', type: 'image' }
      }
    ];

    const events = await captureEvents(() =>
      executor.processChatWithTools({
        prep: prep(llmMessages),
        chatId: 'chat-tools-img',
        buildLogData: () => ({ appId: 'test-app', userSessionId: 's', user: { id: 'u' } }),
        DEFAULT_TIMEOUT: 30000,
        getLocalizedError: async k => `err:${k}`,
        clientLanguage: 'en',
        user: { id: 'u' }
      })
    );

    const answerSource = events.find(e => e.event === 'answer.source');
    expect(answerSource).toBeDefined();
    expect(answerSource.sources).toEqual(['file']);
  });
});
