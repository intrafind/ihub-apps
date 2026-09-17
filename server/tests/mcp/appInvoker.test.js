import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';

/**
 * `invokeAppNonStreaming` — the MCP gateway's request/response path into an
 * iHub app. Input validation runs before any config lookup; the app itself
 * runs headlessly through `ChatService.invokeAppInternal` (mocked here), which
 * owns request preparation, the tool loop and the model calls.
 */

const invokeAppInternalMock = jest.fn();

jest.unstable_mockModule('../../services/chat/ChatService.js', () => ({
  __esModule: true,
  default: class ChatServiceMock {
    invokeAppInternal(opts) {
      return invokeAppInternalMock(opts);
    }
  }
}));

jest.unstable_mockModule('../../configCache.js', () => ({
  __esModule: true,
  default: {
    getApps: () => ({ data: [{ id: 'chat', name: { en: 'Chat' }, enabled: true }] }),
    getPlatform: () => ({ defaultLanguage: 'en' })
  }
}));

jest.unstable_mockModule('../../utils/logger.js', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() }
}));

let invokeAppNonStreaming;

beforeAll(async () => {
  ({ invokeAppNonStreaming } = await import('../../services/mcp/appInvoker.js'));
});

const okResult = (content = 'hello back') => ({
  status: 'ok',
  finalMessage: { role: 'assistant', content },
  toolCalls: [],
  citations: [],
  usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
  finishReason: 'stop',
  model: 'm1'
});

describe('invokeAppNonStreaming — input validation', () => {
  beforeEach(() => invokeAppInternalMock.mockReset());

  it('throws when message is missing', async () => {
    await expect(invokeAppNonStreaming({ appId: 'chat', args: {}, user: {} })).rejects.toThrow(
      /Missing required argument/
    );
  });

  it('throws when message is empty', async () => {
    await expect(
      invokeAppNonStreaming({ appId: 'chat', args: { message: '   ' }, user: {} })
    ).rejects.toThrow(/Missing required argument/);
  });

  it('throws when message is not a string', async () => {
    await expect(
      invokeAppNonStreaming({ appId: 'chat', args: { message: 42 }, user: {} })
    ).rejects.toThrow(/Missing required argument/);
  });

  it('rejects path-traversal appIds before any config lookup', async () => {
    await expect(
      invokeAppNonStreaming({ appId: '../etc/passwd', args: { message: 'hi' }, user: {} })
    ).rejects.toThrow(/Invalid app id/);
  });

  it('rejects appIds with slashes', async () => {
    await expect(
      invokeAppNonStreaming({ appId: 'chat/../../etc', args: { message: 'hi' }, user: {} })
    ).rejects.toThrow(/Invalid app id/);
  });

  it('rejects unknown apps', async () => {
    await expect(
      invokeAppNonStreaming({ appId: 'nope', args: { message: 'hi' }, user: {} })
    ).rejects.toThrow(/App not found/);
    expect(invokeAppInternalMock).not.toHaveBeenCalled();
  });
});

describe('invokeAppNonStreaming — ChatService wiring', () => {
  beforeEach(() => {
    invokeAppInternalMock.mockReset();
    invokeAppInternalMock.mockResolvedValue(okResult());
  });

  it('runs the app headlessly through ChatService and returns the text', async () => {
    const user = { id: 'u1' };
    const text = await invokeAppNonStreaming({
      appId: 'chat',
      args: { message: 'hi', modelId: 'm1', tone: 'formal' },
      user,
      language: 'de',
      timeoutMs: 1234
    });

    expect(text).toBe('hello back');
    expect(invokeAppInternalMock).toHaveBeenCalledTimes(1);
    const call = invokeAppInternalMock.mock.calls[0][0];
    expect(call).toMatchObject({
      appId: 'chat',
      user,
      messages: [{ role: 'user', content: 'hi' }],
      // Non-reserved args become app variables; modelId is the override.
      variables: { tone: 'formal' },
      modelOverride: 'm1',
      language: 'de',
      timeoutMs: 1234
    });
    expect(call.runId).toMatch(/^mcp-/);
  });

  it('falls back to the platform default language', async () => {
    await invokeAppNonStreaming({ appId: 'chat', args: { message: 'hi' }, user: {} });
    expect(invokeAppInternalMock.mock.calls[0][0].language).toBe('en');
    expect(invokeAppInternalMock.mock.calls[0][0].modelOverride).toBeUndefined();
  });

  it('returns an empty string when the model produced no text', async () => {
    invokeAppInternalMock.mockResolvedValue(okResult(''));
    await expect(
      invokeAppNonStreaming({ appId: 'chat', args: { message: 'hi' }, user: {} })
    ).resolves.toBe('');
  });

  it('surfaces preparation failures with their code', async () => {
    invokeAppInternalMock.mockResolvedValue({
      status: 'error',
      error: Object.assign(new Error('no key'), { code: 'AUTH_FAILED' }),
      finalMessage: null,
      toolCalls: []
    });
    await expect(
      invokeAppNonStreaming({ appId: 'chat', args: { message: 'hi' }, user: {} })
    ).rejects.toMatchObject({ message: 'no key', code: 'AUTH_FAILED' });
  });

  it('surfaces loop failures with their code', async () => {
    invokeAppInternalMock.mockResolvedValue({
      status: 'error',
      error: { message: 'rate limited', code: 'RATE_LIMITED' },
      finalMessage: null,
      toolCalls: []
    });
    await expect(
      invokeAppNonStreaming({ appId: 'chat', args: { message: 'hi' }, user: {} })
    ).rejects.toMatchObject({ message: 'rate limited', code: 'RATE_LIMITED' });
  });

  it('uses a generic code when the failure carries none', async () => {
    invokeAppInternalMock.mockResolvedValue({ status: 'error', error: {}, finalMessage: null });
    await expect(
      invokeAppNonStreaming({ appId: 'chat', args: { message: 'hi' }, user: {} })
    ).rejects.toMatchObject({ code: 'APP_INVOCATION_FAILED' });
  });
});
