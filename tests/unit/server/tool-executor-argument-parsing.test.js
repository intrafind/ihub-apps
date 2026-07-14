/**
 * Unit tests for the tool-call argument parsing/repair logic in
 * server/services/chat/ToolExecutor.js (executeToolCall).
 *
 * Regression coverage for issue #1802: the `}{` -> `,` repair heuristic used
 * to run unconditionally, BEFORE the first JSON.parse attempt. That corrupted
 * perfectly valid JSON whose string values legitimately contain the literal
 * substring `}{` (e.g. a code snippet or regex passed as a tool argument).
 * The fix tries JSON.parse on the raw, untouched string first and only falls
 * back to the repair heuristics when that fails.
 */

import { describe, it, expect, jest } from '@jest/globals';

// pathUtils resolves the app root via import.meta.url, which babel-jest's CJS
// transform cannot express — stub it with an equivalent that works under jest.
jest.mock('../../../server/pathUtils.js', () => ({
  getRootDir: () => require('path').join(__dirname, '../../../')
}));

// configCache drags in the whole config/auth loading stack (more import.meta
// modules). Argument parsing never touches configuration.
jest.mock('../../../server/configCache.js', () => ({
  default: {
    getPlatform: () => ({}),
    getApps: () => ({ data: [] }),
    getModels: () => ({ data: [] })
  }
}));

// requestThrottler / httpConfig pull in ESM-only node-fetch, which jest's CJS
// transform can't load from node_modules. Never called here.
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

// toolLoader reaches the MCP SDK (ESM-only in node_modules). runTool is
// mocked so we can inspect exactly what arguments executeToolCall parsed.
const mockRunTool = jest.fn(async () => ({ result: 'ok' }));
jest.mock('../../../server/toolLoader.js', () => ({
  runTool: (...args) => mockRunTool(...args),
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

// Avoid writing real interaction logs to disk during the test run.
jest.mock('../../../server/utils.js', () => ({
  logInteraction: jest.fn(async () => {}),
  getErrorDetails: jest.fn(error => ({ message: error?.message || String(error) }))
}));

// The real logger writes through winston's Console transport, which relies on
// setImmediate — unavailable in jest's jsdom test environment. Argument
// parsing doesn't need real logging.
jest.mock('../../../server/utils/logger.js', () => ({
  __esModule: true,
  default: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    http: jest.fn(),
    verbose: jest.fn(),
    debug: jest.fn(),
    silly: jest.fn()
  }
}));

import ToolExecutor from '../../../server/services/chat/ToolExecutor.js';

const TOOLS = [{ id: 'my_tool', parameters: { properties: {} } }];

function makeToolCall(args) {
  return {
    id: 'call-1',
    function: {
      name: 'my_tool',
      arguments: args
    }
  };
}

describe('ToolExecutor.executeToolCall argument parsing', () => {
  beforeEach(() => {
    mockRunTool.mockClear();
  });

  it('parses valid JSON containing a literal "}{" inside a string value without corrupting it', async () => {
    const executor = new ToolExecutor();
    const toolCall = makeToolCall('{"text":"}{"}');

    await executor.executeToolCall(toolCall, TOOLS, 'chat-1', () => ({}));

    expect(mockRunTool).toHaveBeenCalledTimes(1);
    const [, calledArgs] = mockRunTool.mock.calls[0];
    expect(calledArgs.text).toBe('}{');
  });

  it('still repairs concatenated streaming fragments like {"a":1}{"b":2}', async () => {
    const executor = new ToolExecutor();
    const toolCall = makeToolCall('{"a":1}{"b":2}');

    await executor.executeToolCall(toolCall, TOOLS, 'chat-1', () => ({}));

    const [, calledArgs] = mockRunTool.mock.calls[0];
    expect(calledArgs.a).toBe(1);
    expect(calledArgs.b).toBe(2);
  });

  it('falls back to empty args when arguments are unparseable even after repair', async () => {
    const executor = new ToolExecutor();
    const toolCall = makeToolCall('not json at all {{{');

    await executor.executeToolCall(toolCall, TOOLS, 'chat-1', () => ({}));

    const [, calledArgs] = mockRunTool.mock.calls[0];
    expect(calledArgs.chatId).toBe('chat-1');
    // No parsed properties beyond the ones executeToolCall injects itself.
    expect(Object.keys(calledArgs).sort()).toEqual(['appConfig', 'chatId', 'user']);
  });
});
