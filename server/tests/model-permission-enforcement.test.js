/**
 * Regression tests for issue #1734: the chat flow (RequestBuilder.prepareChatRequest)
 * must enforce user/group model-level permissions (user.permissions.models), not just
 * app-level model constraints (allowedModels, tool support, settings.model.filter,
 * preferredModel).
 *
 * Before this fix, filterModelsForApp only considered app requirements, so a user whose
 * group restricted them to e.g. 'cheap-model' could still invoke 'expensive-model'
 * through any app that permitted it — either by requesting it explicitly, or simply by
 * hitting an app whose preferredModel/default model the user isn't permitted to use.
 * This is inconsistent with /api/models and the OpenAI-compatible proxy, which both
 * enforce user.permissions.models.
 *
 * Runs under the server's own native-ESM jest (see the `test:model-permissions` npm
 * script, which `test:quick` — and therefore CI — chains in).
 */

import { jest } from '@jest/globals';

const mockApps = [
  {
    id: 'general-app',
    name: { en: 'General App' },
    system: { en: 'You are a helpful assistant.' }
  },
  {
    id: 'preferred-expensive-app',
    name: { en: 'Preferred Expensive App' },
    system: { en: 'You are a helpful assistant.' },
    preferredModel: 'expensive-model'
  }
];

const mockModels = [
  { id: 'cheap-model', provider: 'iassistant-conversation', default: true },
  { id: 'expensive-model', provider: 'iassistant-conversation' }
];

jest.unstable_mockModule('../configCache.js', () => ({
  default: {
    getApps: () => ({ data: mockApps }),
    getModels: () => ({ data: mockModels }),
    getPlatform: () => ({ data: {} })
  }
}));

jest.unstable_mockModule('../adapters/index.js', () => ({
  createCompletionRequest: async () => ({ url: 'http://example.test', method: 'POST', body: {} })
}));

jest.unstable_mockModule('../toolLoader.js', () => ({
  getToolsForApp: async () => [],
  resolveAppNativeWebSearch: () => false
}));

const { default: RequestBuilder } = await import('../services/chat/RequestBuilder.js');

const identityTemplateProcessor = async messages => messages;

function userWithModels(modelIds) {
  return {
    id: 'restricted-user',
    groups: ['restricted'],
    permissions: { models: new Set(modelIds) }
  };
}

function baseRequest(overrides) {
  return {
    appId: 'general-app',
    messages: [{ role: 'user', content: 'hi' }],
    language: 'en',
    processMessageTemplates: identityTemplateProcessor,
    res: null,
    clientRes: null,
    chatId: 'chat-test',
    ...overrides
  };
}

describe('RequestBuilder model permission enforcement (issue #1734)', () => {
  let builder;

  beforeEach(() => {
    builder = new RequestBuilder();
  });

  test('rejects an explicitly requested model outside the user allowlist', async () => {
    const result = await builder.prepareChatRequest(
      baseRequest({
        modelId: 'expensive-model',
        user: userWithModels(['cheap-model'])
      })
    );

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('modelAccessDeniedForUser');
  });

  test('rejects an explicitly requested model outside the allowlist regardless of casing', async () => {
    const result = await builder.prepareChatRequest(
      baseRequest({
        modelId: 'EXPENSIVE-MODEL',
        user: userWithModels(['cheap-model'])
      })
    );

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('modelAccessDeniedForUser');
  });

  test('accepts an explicitly requested permitted model regardless of casing', async () => {
    const result = await builder.prepareChatRequest(
      baseRequest({
        modelId: 'CHEAP-model',
        user: userWithModels(['cheap-model'])
      })
    );

    expect(result.success).toBe(true);
    expect(result.data.model.id).toBe('cheap-model');
  });

  test('an unknown modelId is not treated as a permission denial and falls back normally', async () => {
    const result = await builder.prepareChatRequest(
      baseRequest({
        modelId: 'does-not-exist',
        user: userWithModels(['cheap-model'])
      })
    );

    expect(result.success).toBe(true);
    expect(result.data.model.id).toBe('cheap-model');
  });

  test('default resolution never falls back to a model outside the permitted set', async () => {
    const result = await builder.prepareChatRequest(
      baseRequest({
        modelId: undefined,
        user: userWithModels(['cheap-model'])
      })
    );

    expect(result.success).toBe(true);
    expect(result.data.model.id).toBe('cheap-model');
  });

  test("an app's preferredModel outside the user's allowlist is skipped for a permitted fallback, not silently used", async () => {
    const result = await builder.prepareChatRequest(
      baseRequest({
        appId: 'preferred-expensive-app',
        modelId: undefined,
        user: userWithModels(['cheap-model'])
      })
    );

    expect(result.success).toBe(true);
    expect(result.data.model.id).toBe('cheap-model');
  });

  test('surfaces noModelsForUser when the app-permitted and user-permitted sets do not intersect', async () => {
    const result = await builder.prepareChatRequest(
      baseRequest({
        modelId: undefined,
        user: userWithModels(['some-other-model'])
      })
    );

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('noModelsForUser');
  });

  test("wildcard ('*') permission is unaffected", async () => {
    const result = await builder.prepareChatRequest(
      baseRequest({
        modelId: 'expensive-model',
        user: userWithModels(['*'])
      })
    );

    expect(result.success).toBe(true);
    expect(result.data.model.id).toBe('expensive-model');
  });

  test('requests without a user/permissions object are unaffected (e.g. internal callers)', async () => {
    const result = await builder.prepareChatRequest(
      baseRequest({
        modelId: 'expensive-model',
        user: undefined
      })
    );

    expect(result.success).toBe(true);
    expect(result.data.model.id).toBe('expensive-model');
  });
});
