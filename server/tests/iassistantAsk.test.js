// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The iAssistant `ask` action (#2973): one iAssistant conversation turn as a
 * tool. The conversation client, the profile resolver and iFinder's lists
 * are stubbed; the definition, the connector, the tool runner, the scope
 * provider and the source producer are real.
 *
 * Run: node --test server/tests/iassistantAsk.test.js (part of `npm run test:server`)
 */
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import configCache from '../configCache.js';
import '../services/integrations/protocols/native/connectors/register.js';
import integrationRegistry from '../services/integrations/definitions/IntegrationRegistry.js';
import { getConnector } from '../services/integrations/protocols/native/connectors/index.js';
import { runIntegrationTool } from '../services/integrations/integrationTools.js';
import conversationApiService from '../services/integrations/ConversationApiService.js';
import iAssistantService from '../services/integrations/iAssistantService.js';
import iFinderService from '../services/integrations/iFinderService.js';
import iAssistantProfileResolver from '../services/integrations/iAssistantProfileResolver.js';
import iFinderAssistants, {
  AssistantNotAvailableError
} from '../services/integrations/iFinderAssistants.js';
import iFinderSearchProfiles from '../services/integrations/iFinderSearchProfiles.js';
import {
  askIAssistant,
  renumberCitations,
  ASK_CONVERSATION_LABEL
} from '../services/integrations/iAssistantAsk.js';
import { runToolCallScope } from '../services/sources/toolCallScope.js';
import { extractToolSources } from '../services/sources/index.js';
import { installationsFor } from './helpers/installedIFinder.js';

const BASE_URL = 'https://ifinder.example';
const USER = Object.freeze({
  id: 'user-1',
  email: 'u@example.com',
  groups: ['users'],
  permissions: { integrations: new Set(['*']) }
});
/** An app that binds the iAssistant and ticks `ask`. */
const APP = Object.freeze({
  id: 'research',
  integrations: { iassistant: { actions: ['ask'] } },
  iassistant: { profileId: 'conv-profile', searchProfile: 'contracts' }
});
const ASK_TOOL = Object.freeze({
  id: 'iassistant__ask',
  _integration: { instanceId: 'iassistant', action: 'ask', definition: 'com.intrafind/iassistant' }
});

/** One SSE event as the conversation API frames it. */
function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** An answer citing a result document, a passage and a document iHub does not list. */
const ANSWER_STREAM = [
  sse('answer', { delta: 'Travel needs approval <cite type="r">1</cite>' }),
  sse('answer', { delta: ' and receipts <cite type="s">1</cite>.' }),
  sse('answer', { delta: ' Untitled <cite type="r">2</cite>' }),
  sse('result_items', {
    result_items: [
      {
        document_id: 'doc-1',
        title: 'Travel policy',
        links: [{ type: 'ACCESS', searchProfile: 'contracts' }]
      },
      // iFinder sends such an item along with the real ones; it is not listed.
      { document_id: 'publicpush-x' }
    ]
  }),
  sse('references', {
    references: [
      { index: 1, document_id: 'doc-2', title: 'Expense rules', content: 'Receipts are required.' }
    ]
  }),
  sse('done', {})
].join('');

let created;
let sent;
let resolvedScopes;
let stream;
const originals = {};

function useInstallations() {
  const platform = {
    iFinder: { enabled: true, baseUrl: BASE_URL, defaultSearchProfile: 'searchprofile-standard' },
    iAssistant: {}
  };
  const data = installationsFor(platform);
  // The installations follow the shipped definitions' versions.
  for (const instance of data.installed) {
    instance.definitionVersion = integrationRegistry.get(instance.definition).definition.version;
  }
  configCache.setCacheEntry('config/integrations.json', data);
  configCache.getPlatform = () => platform;
  iFinderService.resetConfig();
  iAssistantService.resetConfig();
}

before(async () => {
  await integrationRegistry.ensureLoaded();
  configCache.setCacheEntry('config/groups.json', { groups: { users: {} } });
  originals.getPlatform = configCache.getPlatform;
});

beforeEach(() => {
  useInstallations();
  created = [];
  sent = [];
  resolvedScopes = [];
  stream = ANSWER_STREAM;
  originals.createConversation = conversationApiService.createConversation;
  originals.sendMessage = conversationApiService.sendMessage;
  originals.resolveScope = iAssistantProfileResolver.resolveScope;
  originals.listAssistants = iFinderAssistants.listAssistants;
  originals.getUserSearchProfiles = iFinderSearchProfiles.getUserSearchProfiles;

  conversationApiService.createConversation = async params => {
    created.push(params);
    return { id: `conv-${created.length}` };
  };
  conversationApiService.sendMessage = async (conversationId, params) => {
    sent.push({ conversationId, ...params });
    return { text: async () => stream };
  };
  iAssistantProfileResolver.resolveScope = async params => {
    resolvedScopes.push(params);
    if (params.assistantId) {
      return {
        profileId: `${params.assistantId}-profile`,
        searchProfile: `${params.assistantId}-search`,
        source: 'assistant',
        assistantId: params.assistantId
      };
    }
    if (params.allSearchProfiles) {
      return {
        profileId: params.configuredProfileId,
        searchProfile: undefined,
        source: 'all-search-profiles'
      };
    }
    return {
      profileId: params.configuredProfileId,
      searchProfile: params.configuredSearchProfile,
      source: 'verified'
    };
  };
  iFinderAssistants.listAssistants = async () => [
    { id: 'legal', name: 'Legal assistant' },
    { id: 'hr-bot', name: 'HR assistant' }
  ];
  iFinderSearchProfiles.getUserSearchProfiles = async () => [
    { id: 'contracts', name: 'Contracts' },
    { id: 'searchprofile-standard', name: 'Standard' }
  ];
});

afterEach(() => {
  conversationApiService.createConversation = originals.createConversation;
  conversationApiService.sendMessage = originals.sendMessage;
  iAssistantProfileResolver.resolveScope = originals.resolveScope;
  iFinderAssistants.listAssistants = originals.listAssistants;
  iFinderSearchProfiles.getUserSearchProfiles = originals.getUserSearchProfiles;
});

after(() => {
  configCache.getPlatform = originals.getPlatform;
  iFinderService.resetConfig();
  iAssistantService.resetConfig();
  for (const timer of configCache.refreshTimers?.values?.() || []) clearTimeout(timer);
});

describe('the ask action of the iAssistant definition', () => {
  it('reads, stays internal, runs as the user and is bound only when named', () => {
    const { definition } = integrationRegistry.get('com.intrafind/iassistant');
    const ask = definition.actions.find(action => action.name === 'ask');
    assert.ok(ask, 'the definition declares ask');
    assert.equal(ask.sideEffect, 'read');
    assert.equal(ask.dataFlow, 'internal');
    assert.equal(ask.connection, 'user');
    assert.equal(ask.bindExplicitly, true);
    assert.equal(ask.toolId, undefined, 'a new action: the tool id is iassistant__ask');
    assert.ok(definition.capabilities.includes('model'), 'iAssistant stays a model');
    assert.ok(definition.capabilities.includes('tools'));
  });

  it('is implemented by the iAssistant connector with a question parameter', () => {
    const ask = getConnector('iassistant').actions.ask;
    assert.equal(typeof ask.run, 'function');
    assert.deepEqual(ask.parameters.required, ['question']);
    assert.ok(ask.parameters.properties.assistant, 'the model may name an iAssistant');
  });
});

describe('asking the iAssistant', () => {
  it('runs one turn of an ephemeral conversation with the app’s settings', async () => {
    const result = await askIAssistant({
      question: '  What do I need for a business trip?  ',
      user: USER,
      appConfig: APP,
      language: 'de'
    });
    assert.equal(created.length, 1);
    assert.equal(created[0].ephemeral, true);
    assert.equal(created[0].searchProfile, 'contracts');
    assert.equal(created[0].baseUrl, BASE_URL);
    assert.equal(created[0].fallbackLanguage, 'de');
    assert.deepEqual(created[0].labels, ['ihub', ASK_CONVERSATION_LABEL, 'research']);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].conversationId, 'conv-1');
    assert.equal(sent[0].content, 'What do I need for a business trip?');
    assert.equal(sent[0].profileId, 'conv-profile');
    assert.equal(resolvedScopes[0].assistantId, undefined);
    assert.equal(result.searchProfile, 'contracts');
    assert.equal(result.scope.integrationId, 'iassistant');
    assert.equal(result.scope.id, 'configured');
    assert.equal(result.scope.action, 'ask');
  });

  it('renumbers the citations onto passage numbers reserved for this call', async () => {
    const reported = [];
    // Four passages were numbered by earlier tool calls of the same answer.
    const turn = { passageMarkers: 4 };
    const result = await runToolCallScope(
      reported,
      () => askIAssistant({ question: 'Trip?', user: USER, appConfig: APP }),
      turn
    );
    assert.equal(
      result.answer,
      'Travel needs approval <cite type="s">5</cite> and receipts <cite type="s">6</cite>. Untitled '
    );
    assert.equal(turn.passageMarkers, 6);
    assert.deepEqual(
      result.documents.map(doc => [doc.n, doc.title, doc.documentId]),
      [
        [[5], 'Travel policy', 'doc-1'],
        [[6], 'Expense rules', 'doc-2']
      ]
    );
    assert.equal(result.documents[1].excerpt, 'Receipts are required.');
    assert.match(result.note, /<cite type="s">5<\/cite>/);
    // The sources go beside the result, with the renumbered markers.
    assert.equal(reported.length, 2);
    assert.equal(reported[0].provider, 'ifinder');
    assert.deepEqual(reported[0].ref, { id: 'doc-1', scope: 'contracts' });
    assert.equal(reported[0].scopeName, 'Contracts');
    assert.deepEqual(reported[0].markers, ['s:5']);
    assert.deepEqual(reported[1].markers, ['s:6']);
    assert.equal(reported[1].passages[0].marker, 's:6');
  });

  it('becomes the answer’s sources with the scope it asked, like an iAssistant chat answer', async () => {
    const reported = [];
    const result = await runToolCallScope(reported, () =>
      askIAssistant({ question: 'Trip?', user: USER, appConfig: APP })
    );
    const frame = extractToolSources({
      toolId: ASK_TOOL.id,
      toolDef: ASK_TOOL,
      args: { question: 'Trip?' },
      result: JSON.stringify(result),
      reported
    });
    assert.deepEqual(
      frame.items.map(item => item.title),
      ['Travel policy', 'Expense rules']
    );
    assert.ok(frame.items.every(item => item.private === true));
    assert.equal(frame.scopes.length, 1);
    assert.equal(frame.scopes[0].integrationId, 'iassistant');
    assert.equal(frame.scopes[0].id, 'configured');
    assert.equal(
      extractToolSources({ toolId: ASK_TOOL.id, toolDef: ASK_TOOL, result: '', failed: true }),
      null
    );
  });

  it('refuses an anonymous user and an empty question without calling iFinder', async () => {
    await assert.rejects(
      askIAssistant({ question: 'x', user: { id: 'anonymous' }, appConfig: APP }),
      error => error.code === 'NOT_SIGNED_IN'
    );
    await assert.rejects(
      askIAssistant({ question: ' ', user: USER, appConfig: APP }),
      error => error.code === 'INVALID_QUESTION'
    );
    assert.equal(created.length, 0);
  });

  it('refuses while the iFinder connection is off', async () => {
    const platform = { iFinder: { enabled: false, baseUrl: BASE_URL }, iAssistant: {} };
    configCache.setCacheEntry('config/integrations.json', installationsFor(platform));
    iFinderService.resetConfig();
    iAssistantService.resetConfig();
    await assert.rejects(
      askIAssistant({ question: 'x', user: USER, appConfig: APP }),
      error => error.code === 'NOT_AVAILABLE'
    );
  });

  it('reports an iAssistant error event as a failed answer', async () => {
    stream = sse('error', { type: 'TECHNICAL', message: 'Index offline' });
    await assert.rejects(
      askIAssistant({ question: 'x', user: USER, appConfig: APP }),
      error => error.code === 'ANSWER_FAILED' && /Index offline/.test(error.message)
    );
  });

  it('says so when the user may not use the named iAssistant in iFinder', async () => {
    iAssistantProfileResolver.resolveScope = async () => {
      throw new AssistantNotAvailableError('legal');
    };
    await assert.rejects(
      askIAssistant({
        question: 'x',
        user: USER,
        appConfig: { ...APP, iassistant: { assistantId: 'legal' } }
      }),
      error => error.code === 'ASSISTANT_NOT_AVAILABLE'
    );
  });
});

describe('whom ask asks: the chat scope overrides the model’s argument', () => {
  it('asks the chat’s iAssistant even when the model names another one', async () => {
    const result = await runIntegrationTool(ASK_TOOL, {
      question: 'Notice period?',
      assistant: 'hr-bot',
      integrationScopes: { iassistant: 'assistant:legal' },
      user: USER,
      chatId: 'chat-1',
      appConfig: APP
    });
    assert.equal(resolvedScopes.length, 1);
    assert.equal(resolvedScopes[0].assistantId, 'legal');
    assert.equal(sent[0].profileId, 'legal-profile');
    assert.equal(created[0].searchProfile, 'legal-search');
    assert.equal(result.scope.id, 'assistant:legal');
    assert.equal(result.scope.name, 'Legal assistant');
  });

  it('asks every search profile when the chat picked “all my search profiles”', async () => {
    const result = await runIntegrationTool(ASK_TOOL, {
      question: 'x',
      assistant: 'hr-bot',
      integrationScopes: { iassistant: 'all' },
      user: USER,
      appConfig: APP
    });
    assert.equal(resolvedScopes[0].assistantId, undefined);
    assert.equal(resolvedScopes[0].allSearchProfiles, true);
    assert.equal(created[0].searchProfile, undefined);
    assert.equal(result.searchProfile, undefined);
    assert.equal(result.scope.id, 'all');
  });

  it('asks the scope the app pins whatever the model names', async () => {
    await askIAssistant({
      question: 'x',
      assistant: 'hr-bot',
      user: USER,
      appConfig: {
        ...APP,
        integrations: { iassistant: { actions: ['ask'], pinnedScope: 'assistant:legal' } }
      }
    });
    assert.equal(resolvedScopes[0].assistantId, 'legal');
  });

  it('asks the iAssistant the model names when the chat has no scope', async () => {
    await askIAssistant({ question: 'x', assistant: 'hr-bot', user: USER, appConfig: APP });
    assert.equal(resolvedScopes[0].assistantId, 'hr-bot');
  });

  it('refuses an iAssistant the user cannot see, before creating a conversation', async () => {
    await assert.rejects(
      askIAssistant({ question: 'x', assistant: 'board', user: USER, appConfig: APP }),
      error => error.code === 'SCOPE_NOT_ALLOWED'
    );
    assert.equal(created.length, 0);
  });
});

describe('renumberCitations', () => {
  it('drops a citation of a document the sources do not list and keeps text without tags', () => {
    const { answer, items } = renumberCitations('A <cite type="r">9</cite>. B', []);
    assert.equal(answer, 'A . B');
    assert.deepEqual(items, []);
  });

  it('numbers from 1 outside a tool call and does not change its inputs', () => {
    const input = [{ title: 'Doc', markers: ['r:1'] }];
    const { answer, items } = renumberCitations('See <cite type="R"> 1 </cite>', input);
    assert.equal(answer, 'See <cite type="s">1</cite>');
    assert.deepEqual(items[0].markers, ['s:1']);
    assert.deepEqual(input[0].markers, ['r:1']);
  });
});
