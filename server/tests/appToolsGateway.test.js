import { jest } from '@jest/globals';

/**
 * Tests for the shared App Tools Gateway (`services/chat/appToolsGateway.js`)
 * and its wiring into the chat-app tool pipeline (`toolLoader.js`):
 *
 *  - synthetic `app__<id>` descriptor generation (incl. permission filtering)
 *  - invokeAppTool guard rails: nesting, feature flag, user permissions
 *  - slim result shaping around ChatService.invokeAppInternal
 *  - getToolsForApp surfacing `app.apps` as tools (feature-gated, self-call
 *    filtered, suppressed for nested principals)
 *  - runTool dispatch of the `app__` prefix
 */

const appsFixture = [
  {
    id: 'concierge',
    name: { en: 'Concierge' },
    description: { en: 'Routes requests to specialist bots' },
    apps: ['specialist', 'hidden-app', 'concierge', 'missing-app', 'disabled-app'],
    enabled: true
  },
  {
    id: 'specialist',
    name: { en: 'Specialist' },
    description: { en: 'Answers domain questions' },
    enabled: true,
    variables: [{ name: 'tone', type: 'string', label: { en: 'Tone of the answer' } }]
  },
  {
    id: 'hidden-app',
    name: { en: 'Hidden' },
    description: { en: 'Restricted app' },
    enabled: true
  },
  {
    id: 'disabled-app',
    name: { en: 'Disabled' },
    description: { en: 'Turned off' },
    enabled: false
  }
];

// Mutable feature config the mocked configCache serves.
const featuresConfig = { value: { appAsTool: true } };

const invokeAppInternalMock = jest.fn();

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getApps: () => ({ data: appsFixture }),
    getFeatures: () => featuresConfig.value,
    getTools: () => ({ data: [] }),
    getModels: () => ({ data: [] }),
    getPlatform: () => ({}),
    getSources: () => ({ data: [] }),
    getWorkflowById: () => null
  }
}));

jest.unstable_mockModule('../services/chat/ChatService.js', () => ({
  default: class ChatServiceMock {
    async invokeAppInternal(opts) {
      return invokeAppInternalMock(opts);
    }
  }
}));

jest.unstable_mockModule('../services/mcp/McpClientManager.js', () => ({
  default: { listAllTools: async () => [], callTool: async () => ({}) }
}));

jest.unstable_mockModule('../sources/index.js', () => ({
  createSourceManager: () => ({ generateTools: () => [], getToolFunction: () => null })
}));

jest.unstable_mockModule('../services/skillLoader.js', () => ({
  getSkillContent: async () => null,
  getSkillResource: async () => null
}));

jest.unstable_mockModule('../actionTracker.js', () => ({
  actionTracker: { trackSkillActivation: () => {}, emit: () => {} }
}));

jest.unstable_mockModule('../utils/logger.js', () => ({
  default: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
}));

const { getAppAsTools, invokeAppTool, isAppInvocationAllowed } =
  await import('../services/chat/appToolsGateway.js');
const { getToolsForApp, runTool } = await import('../toolLoader.js');

const wildcardUser = () => ({ id: 'u-admin', permissions: { apps: new Set(['*']) } });
const restrictedUser = () => ({
  id: 'u-restricted',
  permissions: { apps: new Set(['concierge', 'specialist']) }
});
const bareAgent = () => ({ id: 'agent:helper', isAgent: true });

beforeEach(() => {
  featuresConfig.value = { appAsTool: true };
  invokeAppInternalMock.mockReset();
  invokeAppInternalMock.mockResolvedValue({
    status: 'ok',
    finalMessage: { role: 'assistant', content: '  the specialist answer  ' },
    toolCalls: [],
    citations: [],
    usage: { promptTokens: 11, completionTokens: 7 },
    finishReason: 'stop'
  });
});

describe('isAppInvocationAllowed', () => {
  it('enforces permissions for principals that carry them', () => {
    expect(isAppInvocationAllowed(restrictedUser(), 'specialist')).toBe(true);
    expect(isAppInvocationAllowed(restrictedUser(), 'hidden-app')).toBe(false);
    expect(isAppInvocationAllowed(wildcardUser(), 'hidden-app')).toBe(true);
  });

  it('passes bare principals without a permissions object (agents)', () => {
    expect(isAppInvocationAllowed(bareAgent(), 'hidden-app')).toBe(true);
    expect(isAppInvocationAllowed(null, 'hidden-app')).toBe(true);
  });
});

describe('getAppAsTools', () => {
  it('builds descriptors for known enabled apps and derives parameters from variables', async () => {
    const tools = await getAppAsTools(['specialist', 'missing-app', 'disabled-app'], 'en');
    expect(tools).toHaveLength(1);
    const [tool] = tools;
    expect(tool.id).toBe('app__specialist');
    expect(tool.isAppAsTool).toBe(true);
    expect(tool.name).toBe('App: Specialist');
    expect(tool.description).toBe('Answers domain questions');
    expect(tool.parameters.required).toEqual(['message']);
    expect(Object.keys(tool.parameters.properties)).toEqual(
      expect.arrayContaining(['message', 'tone'])
    );
  });

  it('omits apps the calling user may not access', async () => {
    const tools = await getAppAsTools(['specialist', 'hidden-app'], 'en', {
      user: restrictedUser()
    });
    expect(tools.map(t => t.id)).toEqual(['app__specialist']);
  });

  it('keeps all apps for principals without permissions (agents)', async () => {
    const tools = await getAppAsTools(['specialist', 'hidden-app'], 'en', { user: bareAgent() });
    expect(tools.map(t => t.id)).toEqual(['app__specialist', 'app__hidden-app']);
  });
});

describe('invokeAppTool', () => {
  it('invokes the app through ChatService with a nested-marked principal', async () => {
    const result = await invokeAppTool({
      toolId: 'app__specialist',
      args: { message: 'How do I file a claim?', tone: 'formal' },
      user: restrictedUser(),
      chatId: 'chat-1',
      language: 'de',
      callerAppId: 'concierge'
    });

    expect(invokeAppInternalMock).toHaveBeenCalledTimes(1);
    const call = invokeAppInternalMock.mock.calls[0][0];
    expect(call.appId).toBe('specialist');
    expect(call.language).toBe('de');
    expect(call.messages).toEqual([{ role: 'user', content: 'How do I file a claim?' }]);
    expect(call.variables).toEqual({ tone: 'formal' });
    expect(call.user.isInvokedViaAppAsTool).toBe(true);
    expect(call.user.id).toBe('u-restricted');

    // Slim payload: trimmed content, no empty citations key, usage passed through.
    expect(result).toEqual({
      content: 'the specialist answer',
      usage: { promptTokens: 11, completionTokens: 7 },
      finishReason: 'stop'
    });
  });

  it('rejects nested app-to-app calls', async () => {
    const nestedUser = { ...wildcardUser(), isInvokedViaAppAsTool: true };
    const result = await invokeAppTool({
      toolId: 'app__specialist',
      args: { message: 'hi' },
      user: nestedUser,
      chatId: 'chat-1'
    });
    expect(result.error).toBe(true);
    expect(result.message).toMatch(/nested/i);
    expect(invokeAppInternalMock).not.toHaveBeenCalled();
  });

  it('rejects when the appAsTool feature is disabled', async () => {
    featuresConfig.value = { appAsTool: false };
    const result = await invokeAppTool({
      toolId: 'app__specialist',
      args: { message: 'hi' },
      user: wildcardUser(),
      chatId: 'chat-1'
    });
    expect(result.error).toBe(true);
    expect(result.message).toMatch(/appAsTool/);
    expect(invokeAppInternalMock).not.toHaveBeenCalled();
  });

  it('rejects apps the calling user may not access', async () => {
    const result = await invokeAppTool({
      toolId: 'app__hidden-app',
      args: { message: 'hi' },
      user: restrictedUser(),
      chatId: 'chat-1'
    });
    expect(result.error).toBe(true);
    expect(result.message).toMatch(/permission/);
    expect(invokeAppInternalMock).not.toHaveBeenCalled();
  });

  it('reports unknown and disabled apps as tool errors', async () => {
    const missing = await invokeAppTool({
      toolId: 'app__missing-app',
      args: { message: 'hi' },
      user: wildcardUser(),
      chatId: 'chat-1'
    });
    expect(missing.error).toBe(true);

    const disabled = await invokeAppTool({
      toolId: 'app__disabled-app',
      args: { message: 'hi' },
      user: wildcardUser(),
      chatId: 'chat-1'
    });
    expect(disabled.error).toBe(true);
    expect(invokeAppInternalMock).not.toHaveBeenCalled();
  });

  it('surfaces callee pipeline errors as slim error payloads', async () => {
    invokeAppInternalMock.mockResolvedValueOnce({
      status: 'error',
      error: { message: 'model exploded' },
      finalMessage: null,
      toolCalls: []
    });
    const result = await invokeAppTool({
      toolId: 'app__specialist',
      args: { message: 'hi' },
      user: wildcardUser(),
      chatId: 'chat-1'
    });
    expect(result).toEqual({ error: true, message: 'model exploded' });
  });
});

describe('getToolsForApp (app.apps wiring)', () => {
  const conciergeApp = appsFixture[0];

  it('surfaces configured apps as app__ tools, excluding self-references', async () => {
    const tools = await getToolsForApp(conciergeApp, 'en', { user: wildcardUser() });
    const appToolIds = tools.filter(t => t.isAppAsTool).map(t => t.id);
    // 'concierge' (self), 'missing-app' and 'disabled-app' are dropped.
    expect(appToolIds).toEqual(['app__specialist', 'app__hidden-app']);
  });

  it('filters app tools by the calling user permissions', async () => {
    const tools = await getToolsForApp(conciergeApp, 'en', { user: restrictedUser() });
    const appToolIds = tools.filter(t => t.isAppAsTool).map(t => t.id);
    expect(appToolIds).toEqual(['app__specialist']);
  });

  it('generates no app tools when the feature is disabled', async () => {
    featuresConfig.value = { appAsTool: false };
    const tools = await getToolsForApp(conciergeApp, 'en', { user: wildcardUser() });
    expect(tools.filter(t => t.isAppAsTool)).toHaveLength(0);
  });

  it('generates no app tools for principals already serving an app-as-tool call', async () => {
    const nestedUser = { ...wildcardUser(), isInvokedViaAppAsTool: true };
    const tools = await getToolsForApp(conciergeApp, 'en', { user: nestedUser });
    expect(tools.filter(t => t.isAppAsTool)).toHaveLength(0);
  });
});

describe('runTool (app__ dispatch)', () => {
  it('routes app__ tool ids through the gateway, separating args from context', async () => {
    const result = await runTool('app__specialist', {
      message: 'Summarize the incident',
      tone: 'brief',
      chatId: 'chat-9',
      user: wildcardUser(),
      appConfig: { id: 'concierge' },
      language: 'en'
    });

    expect(invokeAppInternalMock).toHaveBeenCalledTimes(1);
    const call = invokeAppInternalMock.mock.calls[0][0];
    expect(call.appId).toBe('specialist');
    expect(call.messages).toEqual([{ role: 'user', content: 'Summarize the incident' }]);
    // Context params must not leak into the callee's variables.
    expect(call.variables).toEqual({ tone: 'brief' });
    expect(result.content).toBe('the specialist answer');
  });
});
