import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';

/**
 * `invokeAppNonStreaming` — the MCP gateway's request/response path into an
 * iHub app. Input validation runs before any config lookup; the model call
 * must go through `LLMClient.complete()` (mocked here) with the request
 * RequestBuilder prepared.
 */

const completeMock = jest.fn();
const prepareChatRequestMock = jest.fn();

jest.unstable_mockModule('../../services/loop/LLMClient.js', () => ({
  __esModule: true,
  default: { complete: completeMock }
}));

jest.unstable_mockModule('../../services/chat/RequestBuilder.js', () => ({
  __esModule: true,
  default: class RequestBuilder {
    prepareChatRequest(params) {
      return prepareChatRequestMock(params);
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

jest.unstable_mockModule('../../serverHelpers.js', () => ({
  __esModule: true,
  processMessageTemplates: jest.fn(messages => messages)
}));

jest.unstable_mockModule('../../utils/logger.js', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() }
}));

let invokeAppNonStreaming;

beforeAll(async () => {
  ({ invokeAppNonStreaming } = await import('../../services/mcp/appInvoker.js'));
});

const preparedRequest = () => ({
  success: true,
  data: {
    app: { id: 'chat' },
    model: { id: 'm1', provider: 'openai', modelId: 'gpt-x' },
    llmMessages: [
      { role: 'system', content: 'You are Chat.' },
      { role: 'user', content: 'hi' }
    ],
    tools: [],
    apiKey: 'sk-test',
    temperature: 0.3,
    maxTokens: 512
  }
});

describe('invokeAppNonStreaming — input validation', () => {
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
    expect(prepareChatRequestMock).not.toHaveBeenCalled();
    expect(completeMock).not.toHaveBeenCalled();
  });
});

describe('invokeAppNonStreaming — LLMClient wiring', () => {
  beforeEach(() => {
    prepareChatRequestMock.mockResolvedValue(preparedRequest());
    completeMock.mockResolvedValue({ content: 'hello back', finishReason: 'stop', toolCalls: [] });
  });

  it('forwards the prepared request to llmClient.complete and returns the text', async () => {
    const user = { id: 'u1' };
    const text = await invokeAppNonStreaming({
      appId: 'chat',
      args: { message: 'hi', modelId: 'm1', tone: 'formal' },
      user,
      timeoutMs: 1234
    });

    expect(text).toBe('hello back');

    // Non-reserved args become app variables; modelId is passed as the override.
    const prepParams = prepareChatRequestMock.mock.calls[0][0];
    expect(prepParams.appId).toBe('chat');
    expect(prepParams.modelId).toBe('m1');
    expect(prepParams.messages[0].variables).toEqual({ tone: 'formal' });
    expect(prepParams.res).toBeNull();

    expect(completeMock).toHaveBeenCalledTimes(1);
    const call = completeMock.mock.calls[0][0];
    expect(call).toMatchObject({
      model: { id: 'm1', provider: 'openai' },
      apiKey: 'sk-test',
      messages: preparedRequest().data.llmMessages,
      options: { temperature: 0.3, maxTokens: 512 },
      stream: false,
      timeoutMs: 1234,
      telemetry: { kind: 'subagent', purpose: 'mcp-app-invoke', user, refs: { appId: 'chat' } }
    });
    expect(call.options.tools).toBeUndefined();
  });

  it('forwards app tools when RequestBuilder loaded any', async () => {
    const prep = preparedRequest();
    prep.data.tools = [{ type: 'function', function: { name: 'lookup' } }];
    prepareChatRequestMock.mockResolvedValue(prep);

    await invokeAppNonStreaming({ appId: 'chat', args: { message: 'hi' }, user: {} });

    expect(completeMock.mock.calls[0][0].options.tools).toEqual(prep.data.tools);
  });

  it('returns an empty string when the model produced no text', async () => {
    completeMock.mockResolvedValue({ content: '', finishReason: 'stop', toolCalls: [] });
    await expect(
      invokeAppNonStreaming({ appId: 'chat', args: { message: 'hi' }, user: {} })
    ).resolves.toBe('');
  });

  it('surfaces RequestBuilder failures with their code', async () => {
    prepareChatRequestMock.mockResolvedValue({
      success: false,
      error: Object.assign(new Error('no key'), { code: 'AUTH_FAILED' })
    });
    await expect(
      invokeAppNonStreaming({ appId: 'chat', args: { message: 'hi' }, user: {} })
    ).rejects.toMatchObject({ message: 'no key', code: 'AUTH_FAILED' });
    expect(completeMock).not.toHaveBeenCalled();
  });

  it('propagates LLMClient errors untouched', async () => {
    const llmError = Object.assign(new Error('rate limited'), {
      name: 'LLMError',
      code: 'RATE_LIMITED',
      status: 429
    });
    completeMock.mockRejectedValue(llmError);
    await expect(
      invokeAppNonStreaming({ appId: 'chat', args: { message: 'hi' }, user: {} })
    ).rejects.toBe(llmError);
  });
});
