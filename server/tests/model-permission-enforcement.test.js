/**
 * Regression tests for issue #1734: the chat flow (RequestBuilder.prepareChatRequest)
 * must enforce user/group model-level permissions (user.permissions.models), not just
 * app-level model constraints (allowedModels, tool support, settings.model.filter).
 *
 * Before this fix, filterModelsForApp only considered app requirements, so a user whose
 * group restricted them to e.g. 'cheap-model' could still invoke 'expensive-model'
 * through any app that permitted it, inconsistent with /api/models and the
 * OpenAI-compatible proxy which both enforce user.permissions.models.
 *
 * Note: The repo's source is native ESM, so this file uses `jest.unstable_mockModule` +
 * dynamic imports rather than the CommonJS-only `jest.mock` API. Run with
 * `NODE_OPTIONS=--experimental-vm-modules`.
 */

import { jest } from '@jest/globals';

const mockApps = [
  {
    id: 'general-app',
    name: { en: 'General App' },
    system: { en: 'You are a helpful assistant.' }
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
