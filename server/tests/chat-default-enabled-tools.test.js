// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * A chat request that names no `enabledTools` (an API call) starts from the
 * app's defaults when a binding is available only (`enabledByDefault: false`),
 * and is not narrowed at all when no binding is. Covers the step in
 * RequestBuilder.prepareChatRequest that hands the defaults to the tool loader.
 */

import { jest } from '@jest/globals';

const mockApps = [
  {
    id: 'mixed',
    name: { en: 'Mixed' },
    system: { en: 'You are a helpful assistant.' },
    integrations: {
      drawio: {},
      jira: { enabledByDefault: false },
      nextcloud: { enabledByDefault: true },
      iassistant: { actions: ['ask'] }
    }
  },
  {
    id: 'all-on',
    name: { en: 'All on' },
    system: { en: 'You are a helpful assistant.' },
    integrations: { jira: {}, nextcloud: {} }
  }
];
const mockModels = [
  { id: 'm', provider: 'iassistant-conversation', supportsTools: 'auto', default: true }
];

const getToolsForApp = jest.fn(async () => []);

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
jest.unstable_mockModule('../services/tools/appTools.js', () => ({ getToolsForApp }));
jest.unstable_mockModule('../services/tools/webSearchResolver.js', () => ({
  resolveAppNativeWebSearch: () => false,
  READ_URL_TOOL_ID: 'read_url'
}));

const { default: RequestBuilder } = await import('../services/chat/RequestBuilder.js');

const request = overrides => ({
  messages: [{ role: 'user', content: 'hi' }],
  language: 'en',
  processMessageTemplates: async messages => messages,
  res: null,
  clientRes: null,
  chatId: 'chat-test',
  user: { id: 'u', groups: [], permissions: { models: new Set(['m']) } },
  ...overrides
});

/** The `enabledTools` the tool loader received for the last request. */
const enabledToolsSeen = () => getToolsForApp.mock.calls.at(-1)[2].enabledTools;

describe('prepareChatRequest without enabledTools', () => {
  beforeEach(() => getToolsForApp.mockClear());

  test('starts from the app defaults when a binding is available only', async () => {
    await new RequestBuilder().prepareChatRequest(request({ appId: 'mixed' }));
    expect(enabledToolsSeen()).toEqual(['drawio', 'nextcloud', 'iassistant']);
  });

  test('does not narrow an app without an available-only binding', async () => {
    await new RequestBuilder().prepareChatRequest(request({ appId: 'all-on' }));
    expect(enabledToolsSeen()).toBeUndefined();
  });

  test('leaves a list the chat sent alone', async () => {
    await new RequestBuilder().prepareChatRequest(
      request({ appId: 'mixed', enabledTools: ['jira'] })
    );
    expect(enabledToolsSeen()).toEqual(['jira']);
  });
});
