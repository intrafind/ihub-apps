#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * iAssistant Conversation adapter specs — search telemetry, terminal events,
 * grounded-only answering, and the search profile the conversation is created
 * with.
 *
 * Background: an iAssistant turn was cancelled after 60 s, and while looking
 * into that four adjacent gaps turned up in the same adapter. The iFinder
 * search events were parsed for their names and their payloads thrown away,
 * so iHub could not show what a turn searched for or how much it found the
 * way the iAssistant webapp does. `generation_stopped` had no case at all, so
 * a stopped turn never completed and hung until a timeout fired. There was no
 * way to confine an answer to the retrieved sources. And the search profile
 * was one configured value for every user, whether they had it or not.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import adapter from '../adapters/iassistant-conversation.js';
import conversationApiService from '../services/integrations/ConversationApiService.js';
import iAssistantProfileResolver from '../services/integrations/iAssistantProfileResolver.js';
import iAssistantService from '../services/integrations/iAssistantService.js';
import iFinderSearchProfiles, {
  parseSearchProfiles
} from '../services/integrations/iFinderSearchProfiles.js';
import iFinderAssistants, {
  AssistantNotAvailableError
} from '../services/integrations/iFinderAssistants.js';
import conversationStateManager from '../services/integrations/ConversationStateManager.js';
import { GROUNDED_ONLY_INSTRUCTION } from '../services/integrations/iAssistantGrounding.js';

const user = { id: 'user_tim', name: 'Tim Vossen', email: 'tim.vossen@intrafind.com' };
const model = { id: 'iassistant-conversation', modelId: 'iassistant-conversation', config: {} };

function optionsWith(iassistant, appConfig = {}) {
  return {
    user,
    chatId: `chat-${Math.random().toString(36).slice(2)}`,
    appConfig: { id: 'iassistant', iassistant, ...appConfig }
  };
}

/** Frame one SSE event the way the conversation API does. */
function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ── search telemetry ────────────────────────────────────────────────────────

test('ifinder_search_started keeps the executed queries', () => {
  const result = adapter.processResponseBuffer(
    sse('ifinder_search_started', {
      lexical_queries: ['E220 Wartung'],
      semantic_queries: ['Wartungsintervalle E220', 'E220 Wartung']
    })
  );

  assert.equal(result.searchStatus.event, 'search.started');
  assert.deepEqual(result.searchStatus.lexicalQueries, ['E220 Wartung']);
  assert.deepEqual(result.searchStatus.semanticQueries, [
    'Wartungsintervalle E220',
    'E220 Wartung'
  ]);
  // The union, de-duplicated: one question phrased twice is one search.
  assert.deepEqual(result.searchStatus.queries, ['E220 Wartung', 'Wartungsintervalle E220']);
});

test('ifinder_search_started tolerates a payload without queries', () => {
  const result = adapter.processResponseBuffer(sse('ifinder_search_started', {}));

  assert.equal(result.searchStatus.event, 'search.started');
  assert.deepEqual(result.searchStatus.queries, []);
});

test('ifinder_search_finished keeps the hit count, timing and provenance', () => {
  const result = adapter.processResponseBuffer(
    sse('ifinder_search_finished', {
      number_of_hits: 12,
      time_ms: 342,
      hits: [
        {
          document_id: 'doc_1',
          additional_document_metadata: { application: 'PDF', sourceName: 'SharePoint' }
        },
        {
          document_id: 'doc_2',
          // Array-valued metadata is normal in iFinder; the first entry wins.
          additional_document_metadata: { application: ['Word'], sourceName: ['SharePoint'] }
        },
        {
          document_id: 'doc_3',
          // Case differs only — still the same source, so not repeated.
          additional_document_metadata: { application: 'pdf', sourceName: 'Confluence' }
        }
      ]
    })
  );

  assert.equal(result.searchStatus.event, 'search.finished');
  assert.equal(result.searchStatus.numberOfHits, 12);
  assert.equal(result.searchStatus.timeMs, 342);
  assert.deepEqual(result.searchStatus.applications, ['PDF', 'Word']);
  assert.deepEqual(result.searchStatus.sources, ['SharePoint', 'Confluence']);
});

test('ifinder_search_finished falls back to counting the hits it was given', () => {
  const result = adapter.processResponseBuffer(
    sse('ifinder_search_finished', { hits: [{ document_id: 'doc_1' }, { document_id: 'doc_2' }] })
  );

  assert.equal(result.searchStatus.numberOfHits, 2);
  assert.deepEqual(result.searchStatus.applications, []);
});

test('an empty result set reports zero rather than nothing', () => {
  const result = adapter.processResponseBuffer(
    sse('ifinder_search_finished', { number_of_hits: 0, hits: [] })
  );

  assert.equal(result.searchStatus.numberOfHits, 0);
});

// ── terminal events ─────────────────────────────────────────────────────────

test('generation_stopped completes the stream', () => {
  const result = adapter.processResponseBuffer(sse('generation_stopped', {}));

  assert.equal(result.complete, true);
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.generationStopped, true);
});

test('generation_stopped completes even with an empty data field', () => {
  // The API documents this event as carrying an empty data field, and the
  // buffer parser only dispatches an event that has data — so the realistic
  // framing is a bare `data:` line.
  const result = adapter.processResponseBuffer('event: generation_stopped\ndata: {}\n\n');

  assert.equal(result.complete, true);
});

// ── grounded-only answering ─────────────────────────────────────────────────

test('groundedOnly prepends the grounding rules to the extra context', () => {
  const config = adapter.resolveConfig(
    model,
    optionsWith({ groundedOnly: true, extraContext: 'Answer in the user language.' })
  );

  assert.ok(config.extraContext.startsWith(GROUNDED_ONLY_INSTRUCTION));
  assert.match(config.extraContext, /Answer in the user language\./);
  assert.equal(config.groundedOnly, true);
});

test('groundedOnly works without any configured extra context', () => {
  const config = adapter.resolveConfig(model, optionsWith({ groundedOnly: true }));

  assert.equal(config.extraContext, GROUNDED_ONLY_INSTRUCTION);
});

test('groundedOnly off leaves the extra context exactly as configured', () => {
  const config = adapter.resolveConfig(
    model,
    optionsWith({ groundedOnly: false, extraContext: 'Answer in the user language.' })
  );

  assert.equal(config.extraContext, 'Answer in the user language.');
});

test('the grounding rules cover the empty-result case', () => {
  // The refusal is the point of the setting: a model that answers from memory
  // when retrieval came back empty is the failure it exists to prevent.
  assert.match(GROUNDED_ONLY_INSTRUCTION, /no sources were retrieved/i);
  assert.match(GROUNDED_ONLY_INSTRUCTION, /world knowledge/i);
});

// ── search profile resolution ───────────────────────────────────────────────

const PROFILES = [
  { id: 'searchprofile-standard', name: 'Standard', isDefault: true },
  { id: 'searchprofile-legal', name: 'Legal', isDefault: false }
];

/**
 * Run `body` with the user's search profiles stubbed and the access check
 * configured as given, restoring both afterwards.
 */
async function withProfiles(responder, body, { verifySearchProfileAccess = true } = {}) {
  const originalGet = iFinderSearchProfiles.getUserSearchProfiles;
  const originalConfig = iAssistantService.config;
  const calls = [];
  iFinderSearchProfiles.getUserSearchProfiles = async args => {
    calls.push(args);
    return responder(args);
  };
  iAssistantService.config = {
    ...iAssistantService.getConfig(),
    verifySearchProfileAccess,
    searchProfileCacheTtlMs: 1000
  };
  try {
    await body(calls);
  } finally {
    iFinderSearchProfiles.getUserSearchProfiles = originalGet;
    iAssistantService.config = originalConfig;
  }
}

const RESOLVE = { user, baseUrl: 'https://ifinder.example.com' };

test('parseSearchProfiles decodes the profiles of a getconfiguration response', () => {
  const encode = id => Buffer.from(id, 'utf8').toString('base64');
  const profiles = parseSearchProfiles({
    results: [
      { roles: ['sb_iassistant'] },
      {
        sources: [
          { value: encode('searchprofile-standard'), name: 'Standard', default: true },
          { value: encode('searchprofile-legal'), name: '  ' },
          { value: encode('searchprofile-legal'), name: 'Duplicate' },
          { value: '', name: 'No id' },
          { name: 'No value' }
        ]
      },
      { customSearchProfiles: [] }
    ]
  });

  assert.deepEqual(profiles, [
    { id: 'searchprofile-standard', name: 'Standard', isDefault: true },
    { id: 'searchprofile-legal', name: 'searchprofile-legal', isDefault: false }
  ]);
});

test('parseSearchProfiles marks the first profile as default when none is', () => {
  const profiles = parseSearchProfiles({
    results: [{ sources: [{ value: Buffer.from('a').toString('base64'), name: 'A' }] }]
  });

  assert.equal(profiles[0].isDefault, true);
});

test('parseSearchProfiles tells an unknown response from an empty list', () => {
  assert.equal(parseSearchProfiles({ results: [{ roles: [] }] }), null);
  assert.equal(parseSearchProfiles(null), null);
  assert.deepEqual(parseSearchProfiles({ results: [{ sources: [] }] }), []);
});

test('a configured search profile the user has is kept', async () => {
  await withProfiles(
    () => PROFILES,
    async calls => {
      const result = await iAssistantProfileResolver.resolveSearchProfile({
        ...RESOLVE,
        configuredSearchProfile: 'searchprofile-legal'
      });

      assert.deepEqual(result, { searchProfile: 'searchprofile-legal', source: 'configured' });
      assert.equal(calls[0].user, user);
      assert.equal(calls[0].ttlMs, 1000);
    }
  );
});

test('a configured search profile the user lacks is replaced by their default', async () => {
  await withProfiles(
    () => [
      { id: 'searchprofile-hr', name: 'HR', isDefault: true },
      { id: 'searchprofile-legal', name: 'Legal', isDefault: false }
    ],
    async () => {
      const result = await iAssistantProfileResolver.resolveSearchProfile({
        ...RESOLVE,
        configuredSearchProfile: 'searchprofile-standard'
      });

      assert.deepEqual(result, { searchProfile: 'searchprofile-hr', source: 'user-default' });
    }
  );
});

test('a profile list that cannot be read keeps the configured profile', async () => {
  await withProfiles(
    () => {
      throw new Error('Reading the iFinder search profiles failed (403)');
    },
    async () => {
      const result = await iAssistantProfileResolver.resolveSearchProfile({
        ...RESOLVE,
        configuredSearchProfile: 'searchprofile-standard'
      });

      assert.deepEqual(result, { searchProfile: 'searchprofile-standard', source: 'unverified' });
    }
  );
});

test('a user without any search profile keeps the configured profile', async () => {
  await withProfiles(
    () => [],
    async () => {
      const result = await iAssistantProfileResolver.resolveSearchProfile({
        ...RESOLVE,
        configuredSearchProfile: 'searchprofile-standard'
      });

      assert.equal(result.searchProfile, 'searchprofile-standard');
      assert.equal(result.source, 'unverified');
    }
  );
});

test('the check is skipped when switched off', async () => {
  await withProfiles(
    () => PROFILES,
    async calls => {
      const result = await iAssistantProfileResolver.resolveSearchProfile({
        ...RESOLVE,
        configuredSearchProfile: 'searchprofile-unknown'
      });

      assert.deepEqual(result, { searchProfile: 'searchprofile-unknown', source: 'unverified' });
      assert.equal(calls.length, 0);
    },
    { verifySearchProfileAccess: false }
  );
});

test('the conversation is created with the user default profile and pins it', async () => {
  const originalCreate = conversationApiService.createConversation;
  let captured = null;
  conversationApiService.createConversation = async params => {
    captured = params;
    return { id: 'conv-telemetry-1', title: null };
  };

  try {
    await withProfiles(
      () => [{ id: 'searchprofile-hr', name: 'HR', isDefault: true }],
      async () => {
        // Signing the iFinder JWT fails in the test environment; the
        // conversation-creation params are captured before that point.
        await adapter
          .createCompletionRequest(
            model,
            [{ role: 'user', content: 'Welche Dokumente hast du?' }],
            null,
            {
              ...optionsWith({
                // A base URL is what makes the check possible at all — the
                // resolver skips it and keeps the configured value without one.
                baseUrl: 'https://ifinder.example.com',
                profileId: 'iassistant-workspace',
                searchProfile: 'searchprofile-standard'
              }),
              language: 'de'
            }
          )
          .catch(() => {});
      }
    );

    assert.ok(captured, 'createConversation was not called');
    assert.equal(captured.searchProfile, 'searchprofile-hr');
    assert.equal(captured.fallbackLanguage, 'de');
  } finally {
    conversationApiService.createConversation = originalCreate;
  }
});

// ── iFinder iAssistants and all search profiles ─────────────────────────────

/** Run `body` with iFinderAssistants.getAssistant stubbed, restoring it afterwards. */
async function withAssistant(responder, body) {
  const original = iFinderAssistants.getAssistant;
  const calls = [];
  iFinderAssistants.getAssistant = async args => {
    calls.push(args);
    return responder(args);
  };
  try {
    await body(calls);
  } finally {
    iFinderAssistants.getAssistant = original;
  }
}

test('an iAssistant supplies both profiles and skips the profile check', async () => {
  await withProfiles(
    () => {
      throw new Error('the profile list must not be read');
    },
    () =>
      withAssistant(
        () => ({
          id: 'legal-advisor',
          name: 'Legal',
          conversationProfileId: 'iassistant-legal',
          searchProfileId: 'searchprofile-legal'
        }),
        async calls => {
          const scope = await iAssistantProfileResolver.resolveScope({
            ...RESOLVE,
            assistantId: 'legal-advisor',
            allSearchProfiles: true,
            configuredProfileId: 'iassistant-workspace',
            configuredSearchProfile: 'searchprofile-standard'
          });

          assert.deepEqual(scope, {
            profileId: 'iassistant-legal',
            searchProfile: 'searchprofile-legal',
            source: 'assistant',
            assistantId: 'legal-advisor'
          });
          assert.equal(calls[0].assistantId, 'legal-advisor');
          assert.equal(calls[0].user, user);
        }
      )
  );
});

test('an iAssistant the user cannot see is an error, not another corpus', async () => {
  await withAssistant(
    ({ assistantId }) => {
      throw new AssistantNotAvailableError(assistantId);
    },
    async () => {
      await assert.rejects(
        iAssistantProfileResolver.resolveScope({ ...RESOLVE, assistantId: 'legal-advisor' }),
        AssistantNotAvailableError
      );
    }
  );
});

test('all search profiles sends none and keeps the conversation profile', async () => {
  await withProfiles(
    () => {
      throw new Error('the profile list must not be read');
    },
    async () => {
      const scope = await iAssistantProfileResolver.resolveScope({
        ...RESOLVE,
        allSearchProfiles: true,
        configuredProfileId: 'iassistant-workspace',
        configuredSearchProfile: 'searchprofile-standard'
      });

      assert.deepEqual(scope, {
        profileId: 'iassistant-workspace',
        searchProfile: undefined,
        source: 'all-search-profiles'
      });
    }
  );
});

test('without either, the configured search profile is checked as before', async () => {
  await withProfiles(
    () => PROFILES,
    async () => {
      const scope = await iAssistantProfileResolver.resolveScope({
        ...RESOLVE,
        configuredProfileId: 'iassistant-workspace',
        configuredSearchProfile: 'searchprofile-legal'
      });

      assert.deepEqual(scope, {
        profileId: 'iassistant-workspace',
        searchProfile: 'searchprofile-legal',
        source: 'configured'
      });
    }
  );
});

test('a conversation for an iAssistant is created with its profiles and pins them', async () => {
  const originalCreate = conversationApiService.createConversation;
  let captured = null;
  conversationApiService.createConversation = async params => {
    captured = params;
    return { id: 'conv-assistant-1', title: null };
  };
  const options = optionsWith({
    baseUrl: 'https://ifinder.example.com',
    assistantId: 'legal-advisor',
    profileId: 'iassistant-workspace',
    searchProfile: 'searchprofile-standard'
  });

  try {
    await withAssistant(
      () => ({
        id: 'legal-advisor',
        name: 'Legal',
        conversationProfileId: 'iassistant-legal',
        searchProfileId: 'searchprofile-legal'
      }),
      async () => {
        await adapter
          .createCompletionRequest(model, [{ role: 'user', content: 'Frist?' }], null, options)
          .catch(() => {});
      }
    );

    assert.equal(captured.searchProfile, 'searchprofile-legal');
    const state = conversationStateManager.getState(options.chatId);
    assert.equal(state.profileId, 'iassistant-legal');
    assert.equal(state.assistantId, 'legal-advisor');
    assert.equal(state.searchScope, 'profile');
  } finally {
    conversationApiService.createConversation = originalCreate;
  }
});

test('an unavailable iAssistant stops the turn with a message for the user', async () => {
  const originalCreate = conversationApiService.createConversation;
  let created = false;
  conversationApiService.createConversation = async () => {
    created = true;
    return { id: 'never' };
  };

  try {
    await withAssistant(
      ({ assistantId }) => {
        throw new AssistantNotAvailableError(assistantId);
      },
      async () => {
        await assert.rejects(
          adapter.createCompletionRequest(
            model,
            [{ role: 'user', content: 'Frist?' }],
            null,
            optionsWith({ baseUrl: 'https://ifinder.example.com', assistantId: 'legal-advisor' })
          ),
          /not available to you/
        );
      }
    );
    assert.equal(created, false);
  } finally {
    conversationApiService.createConversation = originalCreate;
  }
});

test('a conversation over all search profiles is created without one', async () => {
  const originalCreate = conversationApiService.createConversation;
  let captured = null;
  conversationApiService.createConversation = async params => {
    captured = params;
    return { id: 'conv-all-1', title: null };
  };
  const options = optionsWith({
    baseUrl: 'https://ifinder.example.com',
    allSearchProfiles: true,
    searchProfile: 'searchprofile-standard'
  });

  try {
    await adapter
      .createCompletionRequest(model, [{ role: 'user', content: 'Frist?' }], null, options)
      .catch(() => {});

    assert.ok(captured, 'createConversation was not called');
    assert.equal(captured.searchProfile, undefined);
    const state = conversationStateManager.getState(options.chatId);
    assert.equal(state.searchProfile, null);
    assert.equal(state.searchScope, 'all');
  } finally {
    conversationApiService.createConversation = originalCreate;
  }
});
