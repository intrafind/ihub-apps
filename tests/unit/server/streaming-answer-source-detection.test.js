/**
 * @jest-environment node
 *
 * End-to-end detection coverage for the "answer source" badge on the standard
 * (no-tools) streaming path.
 *
 * The existing tool-executor-knowledge-sources test only exercises the
 * bookkeeping helpers (addKnowledgeSource / getKnowledgeSources /
 * finalizeAnswerSource). It never drives executeStreamingResponse, so the
 * actual detection — "does a message carrying fileData/imageData produce an
 * answer.source event with ['file']?" — has been untested. That detection is
 * exactly where the recurring "Based on AI knowledge" regression lives.
 *
 * This test drives the real StreamingHandler.executeStreamingResponse with a
 * mocked LLM stream and asserts the emitted answer.source payload.
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

// A fake adapter whose parseResponseStream yields a single completed chunk.
const fakeAdapter = {
  parseResponseStream: async function* () {
    yield { content: ['Hello from the model.'], complete: true, finishReason: 'stop' };
  }
};

jest.mock('../../../server/adapters/index.js', () => ({
  getAdapter: () => fakeAdapter
}));

jest.mock('../../../server/requestThrottler.js', () => ({
  throttledFetch: jest.fn(async () => ({ ok: true, body: {} }))
}));

jest.mock('../../../server/utils.js', () => ({
  logInteraction: jest.fn()
}));

jest.mock('../../../server/usageTracker.js', () => ({
  estimateTokens: jest.fn(() => 0),
  recordChatRequest: jest.fn(),
  recordChatResponse: jest.fn()
}));

jest.mock('../../../server/utils/streamUtils.js', () => ({
  getReadableStream: jest.fn(x => x)
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

import StreamingHandler from '../../../server/services/chat/StreamingHandler.js';
import { actionTracker } from '../../../server/actionTracker.js';

/**
 * Capture every SSE event emitted while `fn` runs. Returns all payloads so a
 * test can assert on both the answer.source event and the terminal done event.
 */
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

function baseArgs(overrides = {}) {
  return {
    request: { url: 'https://example.test/v1/chat', headers: {}, body: {} },
    chatId: overrides.chatId || 'chat-detect-1',
    buildLogData: () => ({ appId: 'test-app', userSessionId: 'sess-1', user: { id: 'u1' } }),
    model: { id: 'gpt-test', provider: 'openai', modelId: 'gpt-test' },
    llmMessages: overrides.llmMessages || [],
    DEFAULT_TIMEOUT: 30000,
    getLocalizedError: async key => `err:${key}`,
    clientLanguage: 'en'
  };
}

describe('StreamingHandler answer-source detection (no-tools path)', () => {
  let handler;
  beforeEach(() => {
    handler = new StreamingHandler();
  });

  it('emits answer.source ["file"] for a single-document upload (fileData with content)', async () => {
    const llmMessages = [
      {
        role: 'user',
        content: '[File: report.txt (TXT)]\n\nquarterly numbers...\n\nSummarize this',
        // preprocessMessagesWithFileData preserves fileData on the message
        fileData: {
          fileName: 'report.txt',
          fileType: 'text/plain',
          content: 'quarterly numbers...'
        }
      }
    ];

    const events = await captureEvents(() =>
      handler.executeStreamingResponse(baseArgs({ llmMessages, chatId: 'chat-file' }))
    );

    const answerSource = events.find(e => e.event === 'answer.source');
    expect(answerSource).toBeDefined();
    expect(answerSource.sources).toEqual(['file']);
  });

  it('emits answer.source ["file"] for a single image upload (imageData object)', async () => {
    const llmMessages = [
      {
        role: 'user',
        content: 'What is in this image?',
        imageData: { base64: 'AAAA', fileType: 'image/png', type: 'image' }
      }
    ];

    const events = await captureEvents(() =>
      handler.executeStreamingResponse(baseArgs({ llmMessages, chatId: 'chat-img' }))
    );

    const answerSource = events.find(e => e.event === 'answer.source');
    expect(answerSource).toBeDefined();
    expect(answerSource.sources).toEqual(['file']);
  });

  it('emits answer.source ["file"] for multiple document uploads (fileData array)', async () => {
    const llmMessages = [
      {
        role: 'user',
        content: 'Compare these',
        fileData: [
          { fileName: 'a.txt', fileType: 'text/plain', content: 'aaa' },
          { fileName: 'b.txt', fileType: 'text/plain', content: 'bbb' }
        ]
      }
    ];

    const events = await captureEvents(() =>
      handler.executeStreamingResponse(baseArgs({ llmMessages, chatId: 'chat-multi' }))
    );

    const answerSource = events.find(e => e.event === 'answer.source');
    expect(answerSource).toBeDefined();
    expect(answerSource.sources).toEqual(['file']);
  });

  it('does NOT emit answer.source when the turn is plain text (no upload)', async () => {
    const llmMessages = [{ role: 'user', content: 'Hello, what is the capital of France?' }];

    const events = await captureEvents(() =>
      handler.executeStreamingResponse(baseArgs({ llmMessages, chatId: 'chat-plain' }))
    );

    const answerSource = events.find(e => e.event === 'answer.source');
    expect(answerSource).toBeUndefined();
  });
});
