/**
 * Unit tests for the knowledge-source bookkeeping in
 * server/services/chat/ToolExecutor.js
 *
 * Regression coverage for the "Based on AI knowledge" badge bug in the tools
 * path: processChatWithTools detected Outlook email context / file uploads but
 * registered them on its *internal* StreamingHandler's map, while the
 * answer-source event at the end of the tool loop is emitted from the
 * executor's own map (getKnowledgeSources). The sources never met, so every
 * app with tools reported answers as LLM-only even when the whole prompt was
 * email + attachment content.
 *
 * The contract pinned here:
 *   - sources added on the executor are emitted
 *   - sources that land on the internal streaming handler (e.g. 'grounding'
 *     via processGroundingMetadata during the tool loop) are merged in too
 *   - reset clears both maps
 */

import { describe, it, expect, jest } from '@jest/globals';

// pathUtils resolves the app root via import.meta.url, which babel-jest's CJS
// transform cannot express — stub it with an equivalent that works under jest.
jest.mock('../../../server/pathUtils.js', () => ({
  getRootDir: () => require('path').join(__dirname, '../../../')
}));

// configCache drags in the whole config/auth loading stack (more import.meta
// modules). The bookkeeping under test never touches configuration.
jest.mock('../../../server/configCache.js', () => ({
  default: {
    getPlatform: () => ({}),
    getApps: () => ({ data: [] }),
    getModels: () => ({ data: [] })
  }
}));

// requestThrottler / httpConfig pull in ESM-only node-fetch, which jest's CJS
// transform can't load from node_modules. Never called by the bookkeeping
// under test.
jest.mock('../../../server/requestThrottler.js', () => ({
  throttledFetch: jest.fn()
}));
jest.mock('../../../server/utils/httpConfig.js', () => ({
  getSSLConfig: jest.fn(() => ({})),
  getProxyConfig: jest.fn(() => ({})),
  createAgent: jest.fn(),
  enhanceFetchOptions: jest.fn(options => options),
  httpFetch: jest.fn()
}));

// toolLoader reaches the MCP SDK (ESM-only in node_modules). No tools run in
// these tests.
jest.mock('../../../server/toolLoader.js', () => ({
  runTool: jest.fn(),
  getToolsForApp: jest.fn(async () => []),
  loadTools: jest.fn(async () => [])
}));

// usageTracker imports the shared tokenEstimator, which uses import.meta to
// lazily resolve its tokenizer. Token accounting is irrelevant here.
jest.mock('../../../server/usageTracker.js', () => ({
  estimateTokens: jest.fn(() => 0),
  recordChatRequest: jest.fn(),
  recordChatResponse: jest.fn()
}));

import ToolExecutor from '../../../server/services/chat/ToolExecutor.js';

describe('ToolExecutor knowledge-source bookkeeping', () => {
  it('emits sources registered on the executor itself (email/file detection path)', () => {
    const executor = new ToolExecutor();
    executor.addKnowledgeSource('chat-1', 'email');
    executor.addKnowledgeSource('chat-1', 'file');

    expect(executor.getKnowledgeSources('chat-1').sort()).toEqual(['email', 'file']);
  });

  it('merges sources collected by the internal streaming handler during the tool loop', () => {
    const executor = new ToolExecutor();
    executor.addKnowledgeSource('chat-1', 'websearch');
    // processGroundingMetadata / legacy callers add to the inner handler's map.
    executor.streamingHandler.addKnowledgeSource('chat-1', 'grounding');

    expect(executor.getKnowledgeSources('chat-1').sort()).toEqual(['grounding', 'websearch']);
  });

  it('deduplicates sources present in both maps', () => {
    const executor = new ToolExecutor();
    executor.addKnowledgeSource('chat-1', 'email');
    executor.streamingHandler.addKnowledgeSource('chat-1', 'email');

    expect(executor.getKnowledgeSources('chat-1')).toEqual(['email']);
  });

  it('keeps conversations isolated', () => {
    const executor = new ToolExecutor();
    executor.addKnowledgeSource('chat-1', 'email');

    expect(executor.getKnowledgeSources('chat-2')).toEqual([]);
  });

  it('reset clears both the executor map and the internal handler map', () => {
    const executor = new ToolExecutor();
    executor.addKnowledgeSource('chat-1', 'email');
    executor.streamingHandler.addKnowledgeSource('chat-1', 'grounding');

    executor.resetKnowledgeSources('chat-1');

    expect(executor.getKnowledgeSources('chat-1')).toEqual([]);
    expect(executor.streamingHandler.knowledgeSources.has('chat-1')).toBe(false);
  });
});
