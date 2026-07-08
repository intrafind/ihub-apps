/**
 * @jest-environment node
 *
 * Regression coverage for issue #1802: executeToolCall used to run
 * `arguments.replace(/}{/g, ',')` unconditionally, BEFORE the first JSON.parse
 * attempt. That corrupted otherwise-valid JSON whose string values legitimately
 * contain the literal substring "}{" (e.g. a code snippet or regex argument).
 *
 * The fix tries JSON.parse on the raw string first, and only falls back to the
 * "}{ -> ," merge heuristic (then bracket-wrapping) when the raw parse fails.
 */

import { describe, it, expect, jest } from '@jest/globals';

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
  throttledFetch: jest.fn()
}));
jest.mock('../../../server/utils/httpConfig.js', () => ({
  getSSLConfig: jest.fn(() => ({})),
  getProxyConfig: jest.fn(() => ({})),
  createAgent: jest.fn(),
  enhanceFetchOptions: jest.fn(options => options),
  httpFetch: jest.fn()
}));

const mockRunTool = jest.fn(async () => ({ result: 'ok' }));
jest.mock('../../../server/toolLoader.js', () => ({
  runTool: (...args) => mockRunTool(...args),
  getToolsForApp: jest.fn(async () => []),
  loadTools: jest.fn(async () => [])
}));

jest.mock('../../../server/usageTracker.js', () => ({
  estimateTokens: jest.fn(() => 0),
  recordChatRequest: jest.fn(),
  recordChatResponse: jest.fn()
}));

jest.mock('../../../server/utils.js', () => ({
  logInteraction: jest.fn(async () => {}),
  getErrorDetails: jest.fn(() => ({ message: 'err', code: 'ERR' }))
}));

import ToolExecutor from '../../../server/services/chat/ToolExecutor.js';

const TOOLS = [{ id: 'echo', parameters: { properties: {} } }];

function makeToolCall(argsString) {
  return {
    id: 'call-1',
    function: { name: 'echo', arguments: argsString }
  };
}

describe('ToolExecutor.executeToolCall argument parsing', () => {
  beforeEach(() => {
    mockRunTool.mockClear();
  });

  it('parses plain valid JSON arguments unchanged', async () => {
    await new ToolExecutor().executeToolCall(
      makeToolCall('{"query":"hello"}'),
      TOOLS,
      'chat-1',
      () => ({}),
      { id: 'u' },
      { id: 'app' }
    );

    expect(mockRunTool).toHaveBeenCalledWith('echo', expect.objectContaining({ query: 'hello' }));
  });

  it('does not corrupt valid JSON whose string value contains the literal "}{"', async () => {
    await new ToolExecutor().executeToolCall(
      makeToolCall('{"text":"}{"}'),
      TOOLS,
      'chat-1',
      () => ({}),
      { id: 'u' },
      { id: 'app' }
    );

    expect(mockRunTool).toHaveBeenCalledWith('echo', expect.objectContaining({ text: '}{' }));
  });

  it('still repairs concatenated streaming fragments like {"a":1}{"b":2}', async () => {
    await new ToolExecutor().executeToolCall(
      makeToolCall('{"a":1}{"b":2}'),
      TOOLS,
      'chat-1',
      () => ({}),
      { id: 'u' },
      { id: 'app' }
    );

    expect(mockRunTool).toHaveBeenCalledWith('echo', expect.objectContaining({ a: 1, b: 2 }));
  });

  it('falls back to empty args when arguments are unparseable even after repair', async () => {
    await new ToolExecutor().executeToolCall(
      makeToolCall('not json at all'),
      TOOLS,
      'chat-1',
      () => ({}),
      { id: 'u' },
      { id: 'app' }
    );

    const callArgs = mockRunTool.mock.calls[0][1];
    expect(callArgs.query).toBeUndefined();
    expect(callArgs.chatId).toBe('chat-1');
  });
});
