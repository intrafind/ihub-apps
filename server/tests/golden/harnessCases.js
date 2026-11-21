// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The harness's own cases: two chat turns driven in-process through
 * `ChatService.prepareChatRequest` and `ChatService.runTurn`. They exist so
 * that the harness, the normaliser and the determinism test have something
 * real to record. They are not the characterization of a surface: the cases of
 * the seven surfaces (`surfaces/*.js`) are recorded through each surface's own
 * entry point.
 *
 * @module tests/golden/harnessCases
 */
import { defineCase } from './harness.js';
import { fixtureInstallation, fixtureTool } from '../helpers/integrationToolFixture.js';
import { turn } from '../helpers/scriptedModel.js';

const MODELS = [
  {
    id: 'golden-model',
    provider: 'openai',
    modelId: 'gpt-golden',
    url: 'https://model.invalid/v1/chat/completions',
    autoDiscovery: false,
    supportsTools: 'auto',
    default: true
  }
];

const APPS = [
  {
    id: 'desk',
    name: { en: 'Desk' },
    description: { en: 'Answers questions about records' },
    system: { en: 'You answer questions about records.' },
    integrations: { lookup: {} },
    preferredModel: 'golden-model',
    enabled: true
  }
];

const GROUPS = {
  groups: {
    users: {
      id: 'users',
      permissions: { apps: ['desk'], models: ['*'], prompts: [], integrations: ['lookup'] }
    }
  }
};

const TOOLS = [
  fixtureTool('lookup', {
    description: 'Look up a record',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', description: 'The key of the record' } },
      required: ['key']
    },
    run: args => ({ key: args.key, value: `record ${args.key}` })
  })
];

/** What every case of this file runs on. Exported for the tests that change one detail of it. */
export function harnessConfig() {
  return {
    features: { chatPersistence: true },
    platform: {
      chats: { enabled: true },
      auth: {},
      // The sentence the date rule of the normaliser is for.
      globalPromptVariables: { context: 'The current date is {{date}}.' }
    },
    apps: APPS,
    models: MODELS,
    groups: GROUPS,
    tools: TOOLS,
    integrations: () => ({
      installed: [fixtureInstallation('lookup')],
      security: { blockPrivateIps: true, allowedHosts: [] }
    })
  };
}

/** One chat turn on the default `ChatService`, as the chat route runs it after preparing the request. */
export async function runChatTurn(env, { chatId, message, appId = 'desk' }) {
  const user = env.principal({ id: 'golden-user', name: 'Golden User', groups: ['users'] });
  const prepared = await env.chatService.prepareChatRequest({
    appId,
    modelId: 'golden-model',
    messages: [{ role: 'user', content: message }],
    language: 'en',
    user,
    chatId
  });
  if (!prepared.success)
    throw new Error(`the request was not prepared: ${prepared.error?.message}`);
  const summary = await env.chatService.runTurn({
    prep: prepared.data,
    chatId,
    streaming: true,
    buildLogData: (streaming, extra = {}) => ({
      appId,
      user,
      userSessionId: chatId,
      sessionId: chatId,
      streaming,
      ...extra
    }),
    language: 'en',
    user,
    getLocalizedError: async () => null
  });
  const { status, finishReason, content, usage, knowledgeSources, answerBasis, provenance } =
    summary;
  return {
    result: { status, finishReason, content, usage, knowledgeSources, answerBasis, provenance }
  };
}

export const harnessCases = [
  defineCase({
    surface: 'harness',
    name: 'chat-turn-plain',
    title: 'A chat turn without tools: the answer streams in deltas and the run ends as completed.',
    config: harnessConfig,
    script: () => [
      turn.text(['Record ', 'A-1 ', 'is ', 'open.'], {
        usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 }
      })
    ],
    run: env => runChatTurn(env, { chatId: 'golden-chat-plain', message: 'What about record A-1?' })
  }),
  defineCase({
    surface: 'harness',
    name: 'chat-turn-tool',
    title:
      'A chat turn with one tool call: the tool runs on the server and the model answers from its result.',
    config: harnessConfig,
    script: () => [
      turn.toolCalls([{ name: 'lookup', args: { key: 'A-1' } }], {
        usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 }
      }),
      turn.text(['Record A-1 ', 'is open.'], {
        usage: { prompt_tokens: 62, completion_tokens: 5, total_tokens: 67 }
      })
    ],
    run: env => runChatTurn(env, { chatId: 'golden-chat-tool', message: 'Look up record A-1.' })
  })
];
