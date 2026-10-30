// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Integration scopes (#3050): the iFinder search profiles and iAssistants a
 * user can pick per chat, the fallback when iFinder cannot be asked, the check
 * of a picked scope, and the binding of the `iFinder_*` tools to it.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import configCache from '../configCache.js';
import iFinderService from '../services/integrations/iFinderService.js';
import iAssistantService from '../services/integrations/iAssistantService.js';
import iFinderSearchProfiles from '../services/integrations/iFinderSearchProfiles.js';
import iFinderAssistants from '../services/integrations/iFinderAssistants.js';
import {
  applicableScopeProviders,
  getScopeProvider,
  registerScopeProvider,
  resolveChatScopes
} from '../services/integrations/scopes/index.js';
import iFinderScopes, {
  resolveToolSearchProfile,
  SearchProfileNotAllowedError
} from '../services/integrations/scopes/iFinderScopes.js';
import iAssistantScopes, {
  conversationScopeOf,
  scopeToConversationConfig
} from '../services/integrations/scopes/iAssistantScopes.js';
import iFinderTool from '../tools/iFinder.js';
import { applyIntegrationScopes } from '../services/chat/RequestBuilder.js';
import { normalizeChatSettings } from '../services/chat/ChatRepository.js';
import { stripReservedToolContext } from '../utils/toolCallContext.js';
import { stubInstallations } from './helpers/installedIFinder.js';

const USER = { id: 'user-1', email: 'u@example.com' };
// Binds the iFinder installation (its actions are the app's iFinder tools).
const SEARCH_APP = {
  id: 'ifinder-search',
  tools: ['iFinder_search', 'iFinder_listProfiles'],
  integrations: { ifinder: {} }
};
const IASSISTANT_MODEL = { id: 'iassistant', provider: 'iassistant-conversation', config: {} };

const PROFILES = [
  { id: 'searchprofile-standard', name: 'Standard', isDefault: true },
  { id: 'contracts', name: 'Contracts', isDefault: false },
  { id: 'hr', name: 'HR policies', isDefault: false }
];

let platform;
let profileReads;
let profilesAnswer;
let assistantsAnswer;
const originals = {};

function setPlatform(next) {
  platform = next;
  iFinderService.resetConfig();
  iAssistantService.config = null;
}

beforeEach(() => {
  originals.getPlatform = configCache.getPlatform;
  originals.getUserSearchProfiles = iFinderSearchProfiles.getUserSearchProfiles;
  originals.listAssistants = iFinderAssistants.listAssistants;
  originals.search = iFinderService.search;
  originals.listProfiles = iFinderService.listProfiles;

  configCache.getPlatform = () => platform;
  originals.restoreInstallations = stubInstallations(configCache, () => platform);
  // In the server these two are registered with their installations
  // (integrationTools.syncIntegrationScopeProviders).
  registerScopeProvider(iFinderScopes);
  registerScopeProvider(iAssistantScopes);
  profileReads = 0;
  profilesAnswer = async () => PROFILES;
  assistantsAnswer = async () => [
    { id: 'legal', name: 'Legal assistant', description: 'Contracts and law' },
    { id: 'hr-bot', name: 'HR assistant', description: null }
  ];
  iFinderSearchProfiles.getUserSearchProfiles = async () => {
    profileReads += 1;
    return profilesAnswer();
  };
  iFinderAssistants.listAssistants = async () => assistantsAnswer();
  setPlatform({
    iFinder: {
      enabled: true,
      baseUrl: 'https://ifinder.example',
      defaultSearchProfile: 'searchprofile-standard'
    },
    iAssistant: {}
  });
});

afterEach(() => {
  configCache.getPlatform = originals.getPlatform;
  originals.restoreInstallations();
  iFinderSearchProfiles.getUserSearchProfiles = originals.getUserSearchProfiles;
  iFinderAssistants.listAssistants = originals.listAssistants;
  iFinderService.search = originals.search;
  iFinderService.listProfiles = originals.listProfiles;
  iFinderService.resetConfig();
  iAssistantService.config = null;
});

describe('scope registry', () => {
  it('registers the iFinder and iAssistant providers', () => {
    assert.equal(getScopeProvider('ifinder'), iFinderScopes);
    assert.equal(getScopeProvider('iassistant'), iAssistantScopes);
    assert.equal(getScopeProvider('nope'), null);
  });

  it('offers iFinder scopes only to apps that bind iFinder, and only when iFinder is on', () => {
    assert.deepEqual(
      applicableScopeProviders({ app: SEARCH_APP }).map(p => p.id),
      ['ifinder']
    );
    assert.deepEqual(applicableScopeProviders({ app: { id: 'x', tools: ['other'] } }), []);
    setPlatform({ iFinder: { enabled: false } });
    assert.deepEqual(applicableScopeProviders({ app: SEARCH_APP }), []);
  });

  it('offers iAssistant scopes to a chat whose model is an iAssistant', () => {
    assert.deepEqual(
      applicableScopeProviders({ app: { id: 'a' }, model: IASSISTANT_MODEL }).map(p => p.id),
      ['iassistant']
    );
  });
});

describe('iFinder scopes', () => {
  it('lists the user’s search profiles with their display names', async () => {
    const listing = await iFinderScopes.listScopes({ user: USER, app: SEARCH_APP });
    assert.equal(listing.source, 'ifinder');
    assert.equal(listing.fixed, false);
    assert.equal(listing.defaultScope, 'searchprofile-standard');
    assert.deepEqual(
      listing.scopes.map(scope => [scope.id, scope.name, scope.isDefault]),
      [
        ['searchprofile-standard', 'Standard', true],
        ['contracts', 'Contracts', false],
        ['hr', 'HR policies', false]
      ]
    );
  });

  it('narrows the list to the admin allow-list, keeping the default', async () => {
    setPlatform({
      iFinder: {
        enabled: true,
        baseUrl: 'https://ifinder.example',
        defaultSearchProfile: 'searchprofile-standard',
        allowedSearchProfiles: ['contracts']
      }
    });
    const listing = await iFinderScopes.listScopes({ user: USER, app: SEARCH_APP });
    assert.deepEqual(
      listing.scopes.map(scope => scope.id),
      ['searchprofile-standard', 'contracts']
    );
  });

  it('falls back to the configured default when iFinder answers 403', async () => {
    profilesAnswer = async () => {
      const error = new Error('Reading the iFinder search profiles failed (403)');
      error.status = 403;
      throw error;
    };
    const listing = await iFinderScopes.listScopes({ user: USER, app: SEARCH_APP });
    assert.equal(listing.source, 'configured-default');
    assert.equal(listing.hint, 'forbidden');
    assert.deepEqual(listing.scopes, [
      { id: 'searchprofile-standard', name: 'searchprofile-standard', isDefault: true }
    ]);
  });

  it('falls back to the default and the allow-list when iFinder is down', async () => {
    profilesAnswer = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    setPlatform({
      iFinder: {
        enabled: true,
        baseUrl: 'https://ifinder.example',
        defaultSearchProfile: 'searchprofile-standard',
        allowedSearchProfiles: ['contracts', 'hr']
      }
    });
    const listing = await iFinderScopes.listScopes({ user: USER, app: SEARCH_APP });
    assert.equal(listing.hint, 'unavailable');
    assert.deepEqual(
      listing.scopes.map(scope => scope.id),
      ['searchprofile-standard', 'contracts', 'hr']
    );
  });

  it('never lists nothing: a user without any allowed profile gets the default', async () => {
    profilesAnswer = async () => [{ id: 'private', name: 'Private', isDefault: true }];
    setPlatform({
      iFinder: {
        enabled: true,
        baseUrl: 'https://ifinder.example',
        defaultSearchProfile: 'searchprofile-standard',
        allowedSearchProfiles: ['contracts']
      }
    });
    const listing = await iFinderScopes.listScopes({ user: USER, app: SEARCH_APP });
    assert.equal(listing.scopes.length, 1);
    assert.equal(listing.defaultScope, 'searchprofile-standard');
  });

  it('does not ask iFinder for an anonymous user', async () => {
    const listing = await iFinderScopes.listScopes({ user: { id: 'anonymous' }, app: SEARCH_APP });
    assert.equal(profileReads, 0);
    assert.equal(listing.scopes.length, 1);
  });

  it('starts with the app’s default scope', async () => {
    const app = { ...SEARCH_APP, integrations: { ifinder: { defaultScope: 'hr' } } };
    const listing = await iFinderScopes.listScopes({ user: USER, app });
    assert.equal(listing.defaultScope, 'hr');
  });

  it('pins the app’s scope', async () => {
    const app = { ...SEARCH_APP, integrations: { ifinder: { pinnedScope: 'contracts' } } };
    const listing = await iFinderScopes.listScopes({ user: USER, app });
    assert.equal(listing.fixed, true);
    assert.deepEqual(listing.scopes, [{ id: 'contracts', name: 'Contracts', isDefault: true }]);
  });

  it('pins the default when users may not change the profile', async () => {
    setPlatform({
      iFinder: {
        enabled: true,
        baseUrl: 'https://ifinder.example',
        defaultSearchProfile: 'searchprofile-standard',
        allowUserSearchProfileChange: false
      }
    });
    const result = await iFinderScopes.validateScope({
      scopeId: 'contracts',
      user: USER,
      app: SEARCH_APP
    });
    assert.deepEqual(result, { ok: true, scopeId: 'searchprofile-standard', fixed: true });
  });

  it('rejects a profile the user does not have', async () => {
    const result = await iFinderScopes.validateScope({
      scopeId: 'board-minutes',
      user: USER,
      app: SEARCH_APP
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INTEGRATION_SCOPE_NOT_ALLOWED');
  });

  it('rejects a profile of the user that is not on the allow-list', async () => {
    setPlatform({
      iFinder: {
        enabled: true,
        baseUrl: 'https://ifinder.example',
        defaultSearchProfile: 'searchprofile-standard',
        allowedSearchProfiles: ['contracts']
      }
    });
    const result = await iFinderScopes.validateScope({
      scopeId: 'hr',
      user: USER,
      app: SEARCH_APP
    });
    assert.equal(result.ok, false);
  });

  it('passes an unverifiable profile on when no allow-list narrows it', async () => {
    profilesAnswer = async () => {
      throw new Error('down');
    };
    const result = await iFinderScopes.validateScope({
      scopeId: 'contracts',
      user: USER,
      app: SEARCH_APP
    });
    assert.deepEqual(result, { ok: true, scopeId: 'contracts', fixed: false });
  });
});

describe('iFinder tools bound to the chat scope', () => {
  let searched;
  beforeEach(() => {
    searched = [];
    iFinderService.search = async params => {
      searched.push(params.searchProfile);
      return { results: [] };
    };
  });

  it('searches the chat’s scope even when the model names another profile', async () => {
    await iFinderTool.search({
      query: 'notice period',
      searchProfile: 'hr',
      integrationScopes: { ifinder: 'contracts' },
      user: USER,
      chatId: 'chat-1',
      appConfig: SEARCH_APP
    });
    assert.deepEqual(searched, ['contracts']);
  });

  it('lets the model pick one of the user’s profiles when the chat has no scope', async () => {
    await iFinderTool.search({
      query: 'x',
      searchProfile: 'hr',
      user: USER,
      chatId: 'chat-1',
      appConfig: SEARCH_APP
    });
    assert.deepEqual(searched, ['hr']);
  });

  it('refuses a model-supplied profile the user does not have', async () => {
    await assert.rejects(
      iFinderTool.search({
        query: 'x',
        searchProfile: 'board-minutes',
        user: USER,
        chatId: 'chat-1',
        appConfig: SEARCH_APP
      }),
      SearchProfileNotAllowedError
    );
    assert.deepEqual(searched, []);
  });

  it('refuses a chat scope the user may not use', async () => {
    await assert.rejects(
      resolveToolSearchProfile({
        integrationScopes: { ifinder: 'board-minutes' },
        user: USER,
        appConfig: SEARCH_APP
      }),
      SearchProfileNotAllowedError
    );
  });

  it('searches the default without asking iFinder when nothing is named', async () => {
    const result = await resolveToolSearchProfile({ user: USER, appConfig: SEARCH_APP });
    assert.deepEqual(result, { searchProfile: 'searchprofile-standard', fixed: false });
    assert.equal(profileReads, 0);
  });

  it('reports a fixed profile from iFinder_listProfiles', async () => {
    let listed = false;
    iFinderService.listProfiles = async () => {
      listed = true;
      return {};
    };
    const result = await iFinderTool.listProfiles({
      integrationScopes: { ifinder: 'contracts' },
      user: USER,
      chatId: 'chat-1',
      appConfig: SEARCH_APP
    });
    assert.equal(listed, false);
    assert.equal(result.fixed, true);
    assert.deepEqual(result.profiles, [{ id: 'contracts', name: 'Contracts', isDefault: true }]);
  });

  it('keeps integrationScopes out of what an external caller can set', () => {
    assert.deepEqual(
      stripReservedToolContext({ query: 'x', integrationScopes: { ifinder: 'a' } }),
      {
        query: 'x'
      }
    );
  });
});

describe('iAssistant scopes', () => {
  it('lists the configured setup, the user’s iAssistants and, when allowed, all profiles', async () => {
    const app = { id: 'ask', integrations: { iassistant: { allowAllSearchProfiles: true } } };
    const listing = await iAssistantScopes.listScopes({
      user: USER,
      app,
      model: IASSISTANT_MODEL
    });
    assert.deepEqual(
      listing.scopes.map(scope => scope.id),
      ['configured', 'assistant:legal', 'assistant:hr-bot', 'all']
    );
    assert.equal(listing.defaultScope, 'configured');
  });

  it('starts with the iAssistant the app names, and does not offer the configured setup', async () => {
    const app = { id: 'ask', iassistant: { assistantId: 'legal' } };
    const listing = await iAssistantScopes.listScopes({
      user: USER,
      app,
      model: IASSISTANT_MODEL
    });
    assert.equal(listing.defaultScope, 'assistant:legal');
    assert.ok(!listing.scopes.some(scope => scope.id === 'configured'));
    assert.ok(!listing.scopes.some(scope => scope.id === 'all'));
  });

  it('keeps the app’s own iAssistant as the default when iFinder does not list it', async () => {
    const app = { id: 'ask', iassistant: { assistantId: 'contracts-bot' } };
    const listing = await iAssistantScopes.listScopes({
      user: USER,
      app,
      model: IASSISTANT_MODEL
    });
    assert.equal(listing.defaultScope, 'assistant:contracts-bot');
    assert.deepEqual(
      listing.scopes.map(scope => scope.id),
      ['assistant:contracts-bot', 'assistant:legal', 'assistant:hr-bot']
    );
  });

  it('falls back to the app’s setup when the iAssistants cannot be listed', async () => {
    assistantsAnswer = async () => {
      throw new Error('Listing the iFinder iAssistants failed (500)');
    };
    const app = { id: 'ask', iassistant: { assistantId: 'legal' } };
    const listing = await iAssistantScopes.listScopes({
      user: USER,
      app,
      model: IASSISTANT_MODEL
    });
    assert.equal(listing.source, 'configured-default');
    assert.deepEqual(
      listing.scopes.map(scope => scope.id),
      ['assistant:legal']
    );
  });

  it('rejects an iAssistant the user cannot see', async () => {
    const result = await iAssistantScopes.validateScope({
      scopeId: 'assistant:secret',
      user: USER,
      app: { id: 'ask' },
      model: IASSISTANT_MODEL
    });
    assert.equal(result.ok, false);
  });

  it('rejects "all my search profiles" when the app does not offer it', async () => {
    const result = await iAssistantScopes.validateScope({
      scopeId: 'all',
      user: USER,
      app: { id: 'ask' },
      model: IASSISTANT_MODEL
    });
    assert.equal(result.ok, false);
  });

  it('maps scopes onto the adapter settings', () => {
    assert.deepEqual(scopeToConversationConfig('assistant:legal'), {
      assistantId: 'legal',
      allSearchProfiles: false
    });
    assert.deepEqual(scopeToConversationConfig('all'), {
      assistantId: undefined,
      allSearchProfiles: true
    });
    assert.deepEqual(scopeToConversationConfig('configured'), {
      assistantId: undefined,
      allSearchProfiles: false
    });
    assert.equal(scopeToConversationConfig('assistant:'), null);
    assert.equal(scopeToConversationConfig('other'), null);
  });

  it('tells which scope a stored conversation runs in', () => {
    assert.equal(conversationScopeOf({ scopeId: 'all' }), 'all');
    assert.equal(conversationScopeOf({ assistantId: 'legal' }), 'assistant:legal');
    assert.equal(conversationScopeOf({ searchScope: 'all' }), 'all');
    assert.equal(conversationScopeOf({ searchScope: 'profile' }), 'configured');
  });
});

describe('resolveChatScopes', () => {
  it('keeps a scope the user may pick and drops scopes of integrations the app does not use', async () => {
    const result = await resolveChatScopes({
      requested: { ifinder: 'contracts', iassistant: 'assistant:legal', other: 'x' },
      user: USER,
      app: SEARCH_APP
    });
    assert.deepEqual(result, { ok: true, scopes: { ifinder: 'contracts' } });
  });

  it('refuses a scope the user may not use', async () => {
    const result = await resolveChatScopes({
      requested: { ifinder: 'board-minutes' },
      user: USER,
      app: SEARCH_APP
    });
    assert.equal(result.ok, false);
    assert.equal(result.integrationId, 'ifinder');
    assert.equal(result.code, 'INTEGRATION_SCOPE_NOT_ALLOWED');
  });

  it('refuses a value that is not a scope id', async () => {
    const result = await resolveChatScopes({
      requested: { ifinder: { $ne: 1 } },
      user: USER,
      app: SEARCH_APP
    });
    assert.equal(result.code, 'INVALID_INTEGRATION_SCOPE');
  });

  it('applies a pinned scope whatever the request says', async () => {
    const app = { ...SEARCH_APP, integrations: { ifinder: { pinnedScope: 'hr' } } };
    const result = await resolveChatScopes({ requested: {}, user: USER, app });
    assert.deepEqual(result, { ok: true, scopes: { ifinder: 'hr' } });
  });
});

describe('model guidance and chat settings', () => {
  it('hides iFinder_listProfiles and tells the model the profile is fixed', () => {
    const messages = [{ role: 'system', content: 'Use iFinder_listProfiles to switch.' }];
    const tools = applyIntegrationScopes(
      messages,
      [{ id: 'iFinder_search' }, { id: 'iFinder_listProfiles' }],
      { ifinder: 'contracts' }
    );
    assert.deepEqual(
      tools.map(tool => tool.id),
      ['iFinder_search']
    );
    assert.match(messages[0].content, /"contracts", which is fixed for this chat/);
  });

  it('changes nothing without a scope', () => {
    const messages = [{ role: 'system', content: 'Prompt' }];
    const tools = [{ id: 'iFinder_listProfiles' }];
    assert.equal(applyIntegrationScopes(messages, tools, {}), tools);
    assert.equal(messages[0].content, 'Prompt');
  });

  it('stores the scopes with the chat settings', () => {
    assert.deepEqual(
      normalizeChatSettings({ integrationScopes: { ifinder: 'contracts', 'bad key!': 'x' } }),
      { integrationScopes: { ifinder: 'contracts' } }
    );
    assert.equal(normalizeChatSettings({ integrationScopes: { ifinder: 42 } }), null);
    assert.equal(normalizeChatSettings({ integrationScopes: ['contracts'] }), null);
  });
});

describe('chat request schema', () => {
  it('keeps integrationScopes in the validated body', async () => {
    const { chatPostSchema } = await import('../validators/index.js');
    const body = chatPostSchema.body.parse({
      messages: [],
      integrationScopes: { ifinder: 'contracts', iassistant: 'assistant:legal' }
    });
    assert.deepEqual(body.integrationScopes, {
      ifinder: 'contracts',
      iassistant: 'assistant:legal'
    });
    assert.throws(() =>
      chatPostSchema.body.parse({ messages: [], integrationScopes: { ifinder: 42 } })
    );
  });
});
