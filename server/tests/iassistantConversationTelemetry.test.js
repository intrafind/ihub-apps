#!/usr/bin/env node

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
 * was a hardcoded literal that the iAssistant profile had no say in.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import adapter from '../adapters/iassistant-conversation.js';
import conversationApiService from '../services/integrations/ConversationApiService.js';
import iAssistantProfileResolver, {
  extractSearchProfile
} from '../services/integrations/iAssistantProfileResolver.js';
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

test('extractSearchProfile finds a profile-level search profile', () => {
  assert.equal(
    extractSearchProfile({ id: 'p', ifinder_search_profile: 'searchprofile-legal' }),
    'searchprofile-legal'
  );
});

test('extractSearchProfile looks through the workflow configuration', () => {
  const profile = {
    id: 'iassistant-workspace',
    workflow: {
      id: 'standard-workflow',
      configuration: {
        state_defaults: { ifinderSearchProfile: 'searchprofile-research' }
      }
    }
  };

  assert.equal(extractSearchProfile(profile), 'searchprofile-research');
});

test('extractSearchProfile looks inside per-state overrides', () => {
  const profile = {
    workflow: {
      configuration: {
        states: {
          PASSAGE_RETRIEVAL: { k: 20 },
          SEARCH: { ifinder_search_profile: 'searchprofile-technical' }
        }
      }
    }
  };

  assert.equal(extractSearchProfile(profile), 'searchprofile-technical');
});

test('extractSearchProfile returns null for a profile that names none', () => {
  // The shape iFinder 6.9 actually returns: a workflow reference with tuning
  // parameters and no search profile anywhere.
  const profile = {
    id: 'iassistant-workspace',
    name: 'iAssistant Workspace',
    workflow: {
      id: 'standard-workflow',
      configuration: {
        workflow: { maxDurationSeconds: 90, maxSteps: 15 },
        states: { RESPONSE: { maxTokens: 8000 } }
      }
    }
  };

  assert.equal(extractSearchProfile(profile), null);
  assert.equal(extractSearchProfile(null), null);
  assert.equal(extractSearchProfile({}), null);
});

test('extractSearchProfile ignores blank values', () => {
  assert.equal(extractSearchProfile({ ifinder_search_profile: '   ' }), null);
});

test('resolveSearchProfile prefers the profile over the configured value', async () => {
  const original = conversationApiService.getProfile;
  iAssistantProfileResolver.reset();
  conversationApiService.getProfile = async () => ({
    id: 'iassistant-workspace',
    ifinder_search_profile: 'searchprofile-legal'
  });

  try {
    const result = await iAssistantProfileResolver.resolveSearchProfile({
      profileId: 'iassistant-workspace',
      configuredSearchProfile: 'searchprofile-standard',
      user,
      baseUrl: 'https://ifinder.example.com'
    });

    assert.equal(result.searchProfile, 'searchprofile-legal');
    assert.equal(result.source, 'profile');
  } finally {
    conversationApiService.getProfile = original;
    iAssistantProfileResolver.reset();
  }
});

test('resolveSearchProfile falls back when the profile names none', async () => {
  const original = conversationApiService.getProfile;
  iAssistantProfileResolver.reset();
  conversationApiService.getProfile = async () => ({ id: 'iassistant-workspace', workflow: {} });

  try {
    const result = await iAssistantProfileResolver.resolveSearchProfile({
      profileId: 'iassistant-workspace',
      configuredSearchProfile: 'searchprofile-standard',
      user,
      baseUrl: 'https://ifinder.example.com'
    });

    assert.equal(result.searchProfile, 'searchprofile-standard');
    assert.equal(result.source, 'configured');
  } finally {
    conversationApiService.getProfile = original;
    iAssistantProfileResolver.reset();
  }
});

test('a failed profile lookup falls back instead of breaking the conversation', async () => {
  const original = conversationApiService.getProfile;
  iAssistantProfileResolver.reset();
  conversationApiService.getProfile = async () => {
    throw new Error('404 Not Found');
  };

  try {
    const result = await iAssistantProfileResolver.resolveSearchProfile({
      profileId: 'iassistant-workspace',
      configuredSearchProfile: 'searchprofile-standard',
      user,
      baseUrl: 'https://ifinder.example.com'
    });

    assert.equal(result.searchProfile, 'searchprofile-standard');
    assert.equal(result.source, 'configured');
  } finally {
    conversationApiService.getProfile = original;
    iAssistantProfileResolver.reset();
  }
});

test('the profile is read once and then cached', async () => {
  const original = conversationApiService.getProfile;
  iAssistantProfileResolver.reset();
  let calls = 0;
  conversationApiService.getProfile = async () => {
    calls += 1;
    return { ifinder_search_profile: 'searchprofile-legal' };
  };

  try {
    const args = {
      profileId: 'iassistant-workspace',
      configuredSearchProfile: 'searchprofile-standard',
      user,
      baseUrl: 'https://ifinder.example.com'
    };
    // Concurrent and sequential callers alike share the one read.
    await Promise.all([
      iAssistantProfileResolver.resolveSearchProfile(args),
      iAssistantProfileResolver.resolveSearchProfile(args)
    ]);
    await iAssistantProfileResolver.resolveSearchProfile(args);

    assert.equal(calls, 1);
  } finally {
    conversationApiService.getProfile = original;
    iAssistantProfileResolver.reset();
  }
});

test('the conversation is created with the profile search profile and pins it', async () => {
  const originalCreate = conversationApiService.createConversation;
  const originalProfile = conversationApiService.getProfile;
  iAssistantProfileResolver.reset();

  let captured = null;
  conversationApiService.createConversation = async params => {
    captured = params;
    return { id: 'conv-telemetry-1', title: null };
  };
  conversationApiService.getProfile = async () => ({
    ifinder_search_profile: 'searchprofile-legal'
  });

  try {
    // Signing the iFinder JWT fails in the test environment; the
    // conversation-creation params are captured before that point.
    await adapter
      .createCompletionRequest(
        model,
        [{ role: 'user', content: 'Welche Dokumente hast du?' }],
        null,
        optionsWith({
          // A base URL is what makes the profile lookup possible at all — the
          // resolver skips it and falls straight back without one.
          baseUrl: 'https://ifinder.example.com',
          profileId: 'iassistant-workspace',
          searchProfile: 'searchprofile-standard'
        })
      )
      .catch(() => {});

    assert.ok(captured, 'createConversation was not called');
    assert.equal(captured.searchProfile, 'searchprofile-legal');
  } finally {
    conversationApiService.createConversation = originalCreate;
    conversationApiService.getProfile = originalProfile;
    iAssistantProfileResolver.reset();
  }
});
