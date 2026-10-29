#!/usr/bin/env node

// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * iAssistant Conversation API wire specs for the iFinder 6.9 contract.
 *
 * iFinder 6.9 made `mode` mandatory on a sent message, added
 * `fallback_language`, three stream events (`TASK_CREATED`, `ARTIFACT_GROUPS`
 * and `intervening_message_ids` on `REQUEST_MESSAGE_ID`) and a 409 that names
 * the message a conversation now ends with. The search profiles of a user are
 * read from the internal API the searchbar uses.
 *
 * These specs build real requests, so they sign the iFinder JWT with a key
 * generated here. The key has to be in the environment before the config
 * module is first imported, hence the dynamic imports.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.IFINDER_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });

const { default: adapter, toFallbackLanguage } =
  await import('../adapters/iassistant-conversation.js');
const { default: conversationStateManager } =
  await import('../services/integrations/ConversationStateManager.js');
const { default: iFinderSearchProfiles, CONFIGURATION_PATH } =
  await import('../services/integrations/iFinderSearchProfiles.js');
const { LLMClient } = await import('../services/loop/LLMClient.js');

const user = { id: 'user_wire', name: 'Wire Test', email: 'wire@example.com' };
const model = {
  id: 'iassistant-conversation',
  modelId: 'iassistant-conversation',
  provider: 'iassistant-conversation',
  config: {}
};
const BASE_URL = 'https://ifinder.example.com';

/** Frame one SSE event the way the conversation API does. */
function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function chatOptions(chatId, extra = {}) {
  return {
    user,
    chatId,
    appConfig: { id: 'iassistant', iassistant: { baseUrl: BASE_URL } },
    ...extra
  };
}

// ── sending a message ───────────────────────────────────────────────────────

test('a message is sent as an APPEND after the last answer, with the UI language', async () => {
  conversationStateManager.setState('chat-wire-append', {
    conversationId: 'conv-1',
    lastParentId: 'msg-answer-1',
    ownerId: user.id
  });

  const request = await adapter.createCompletionRequest(
    model,
    [{ role: 'user', content: 'Und die Wartung?' }],
    null,
    chatOptions('chat-wire-append', { language: 'de' })
  );

  assert.equal(request.url, `${BASE_URL}/public-api/rag/api/v0/conversations/conv-1/messages`);
  assert.equal(request.body.mode, 'APPEND');
  assert.equal(request.body.parent_id, 'msg-answer-1');
  assert.equal(request.body.fallback_language, 'de');
  assert.match(request.headers.Authorization, /^Bearer /);
});

test('the first message of a conversation has no parent', async () => {
  conversationStateManager.setState('chat-wire-first', {
    conversationId: 'conv-2',
    lastParentId: null,
    ownerId: user.id
  });

  const request = await adapter.createCompletionRequest(
    model,
    [{ role: 'user', content: 'Hallo' }],
    null,
    chatOptions('chat-wire-first')
  );

  assert.equal(request.body.mode, 'APPEND');
  assert.equal('parent_id' in request.body, false);
  assert.equal('fallback_language' in request.body, false);
});

test('only well-formed language tags become the fallback language', () => {
  assert.equal(toFallbackLanguage('de'), 'de');
  assert.equal(toFallbackLanguage('en-US'), 'en-US');
  assert.equal(toFallbackLanguage('pt_BR'), 'pt-BR');
  assert.equal(toFallbackLanguage(''), undefined);
  assert.equal(toFallbackLanguage('de; DROP'), undefined);
  assert.equal(toFallbackLanguage('x'.repeat(36)), undefined);
  assert.equal(toFallbackLanguage(undefined), undefined);
});

// ── new stream events ───────────────────────────────────────────────────────

test('request_message_id keeps the messages iHub has not shown', () => {
  const result = adapter.processResponseBuffer(
    sse('request_message_id', { message_id: 'msg-7', intervening_message_ids: ['msg-5', 'msg-6'] })
  );

  assert.equal(result.requestMessageId, 'msg-7');
  assert.deepEqual(result.interveningMessageIds, ['msg-5', 'msg-6']);
});

test('task_created reports the task as a status', () => {
  const result = adapter.processResponseBuffer(sse('task_created', { task_id: 'task_789' }));

  assert.equal(result.taskId, 'task_789');
  assert.deepEqual(result.searchStatus, { event: 'task.created', taskId: 'task_789' });
  assert.equal(result.complete, false);
});

test('artifact_groups are kept on the result', () => {
  const groups = [{ artifact_group_id: 'g-1', skills: [{ skill_id: 'report', count: 2 }] }];
  const result = adapter.processResponseBuffer(sse('artifact_groups', { artifact_groups: groups }));

  assert.deepEqual(result.artifactGroups, groups);
});

// ── 409 recovery ────────────────────────────────────────────────────────────

function conflict(body) {
  return new Response(JSON.stringify(body), {
    status: 409,
    headers: { 'content-type': 'application/json' }
  });
}

test('CONVERSATION_ADVANCED is answered by appending after the last message', async () => {
  conversationStateManager.setState('chat-wire-409', {
    conversationId: 'conv-3',
    lastParentId: 'msg-old',
    ownerId: user.id
  });
  const request = {
    body: { message: { content: 'x' }, mode: 'APPEND', parent_id: 'msg-old' },
    _chatId: 'chat-wire-409',
    _conversationId: 'conv-3'
  };

  const revised = await adapter.reviseRequestAfterError(
    conflict({ code: 'CONVERSATION_ADVANCED', message: 'moved', last_message_id: 'msg-new' }),
    request
  );

  assert.equal(revised, true);
  assert.equal(request.body.parent_id, 'msg-new');
  assert.equal(conversationStateManager.getState('chat-wire-409').lastParentId, 'msg-new');

  // Once only: a second refusal of the revised request is the user's error.
  const again = await adapter.reviseRequestAfterError(
    conflict({ code: 'CONVERSATION_ADVANCED', message: 'moved', last_message_id: 'msg-newer' }),
    request
  );
  assert.equal(again, false);
});

test('other refusals are not retried', async () => {
  const request = () => ({ body: { mode: 'APPEND', parent_id: 'msg-1' } });

  assert.equal(
    await adapter.reviseRequestAfterError(
      conflict({ code: 'TURN_IN_PROGRESS', message: 'busy', last_message_id: 'msg-2' }),
      request()
    ),
    false
  );
  assert.equal(
    await adapter.reviseRequestAfterError(new Response('bad', { status: 400 }), request()),
    false
  );
  assert.equal(
    await adapter.reviseRequestAfterError(
      conflict({ code: 'CONVERSATION_ADVANCED', message: 'same', last_message_id: 'msg-1' }),
      request()
    ),
    false
  );
});

test('LLMClient sends the revised request once and streams its answer', async () => {
  const sent = [];
  const responses = [
    conflict({ code: 'CONVERSATION_ADVANCED', message: 'moved', last_message_id: 'msg-new' }),
    new Response(sse('answer', { delta: 'Hallo' }) + sse('done', {}), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })
  ];
  const client = new LLMClient({
    transport: async request => {
      sent.push(structuredClone(request.body));
      return responses.shift();
    },
    createRequest: async () => ({
      url: `${BASE_URL}/public-api/rag/api/v0/conversations/conv-4/messages`,
      method: 'POST',
      headers: {},
      body: { message: { content: 'Hallo?' }, mode: 'APPEND', parent_id: 'msg-old' },
      _conversationId: 'conv-4'
    }),
    apiKeyVerifier: { verifyApiKey: async () => ({ success: true, apiKey: 'k' }) },
    getModels: () => ({ data: [model] })
  });

  const result = await client.complete({
    model,
    messages: [{ role: 'user', content: 'Hallo?' }],
    telemetry: { autoRun: false }
  });

  assert.deepEqual(
    sent.map(body => body.parent_id),
    ['msg-old', 'msg-new']
  );
  assert.equal(result.content, 'Hallo');
});

// ── the user's search profiles ──────────────────────────────────────────────

function configurationResponse(ids) {
  return new Response(
    JSON.stringify({
      results: [
        {
          sources: ids.map((id, index) => ({
            value: Buffer.from(id).toString('base64'),
            name: id.toUpperCase(),
            default: index === 0
          }))
        }
      ]
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

test('the search profiles are read as the user from the internal API and cached', async () => {
  const originalFetch = iFinderSearchProfiles.fetch;
  iFinderSearchProfiles.reset();
  const calls = [];
  iFinderSearchProfiles.fetch = async (label, url, options) => {
    calls.push({ label, url, options });
    return configurationResponse(['searchprofile-standard', 'searchprofile-legal']);
  };

  try {
    const args = { user, baseUrl: `${BASE_URL}/`, ttlMs: 60000 };
    const [first] = await Promise.all([
      iFinderSearchProfiles.getUserSearchProfiles(args),
      iFinderSearchProfiles.getUserSearchProfiles(args)
    ]);
    await iFinderSearchProfiles.getUserSearchProfiles(args);

    assert.equal(calls.length, 1, 'concurrent and later callers share one read');
    assert.equal(calls[0].url, `${BASE_URL}${CONFIGURATION_PATH}?action=getconfiguration`);
    assert.match(calls[0].options.headers.Authorization, /^Bearer /);
    assert.deepEqual(first, [
      { id: 'searchprofile-standard', name: 'SEARCHPROFILE-STANDARD', isDefault: true },
      { id: 'searchprofile-legal', name: 'SEARCHPROFILE-LEGAL', isDefault: false }
    ]);

    // Another user is another read.
    await iFinderSearchProfiles.getUserSearchProfiles({ ...args, user: { ...user, id: 'other' } });
    assert.equal(calls.length, 2);
  } finally {
    iFinderSearchProfiles.fetch = originalFetch;
    iFinderSearchProfiles.reset();
  }
});

test('a refused profile read is an error, not an empty list', async () => {
  const originalFetch = iFinderSearchProfiles.fetch;
  iFinderSearchProfiles.reset();
  iFinderSearchProfiles.fetch = async () => new Response('Forbidden', { status: 403 });

  try {
    await assert.rejects(
      iFinderSearchProfiles.getUserSearchProfiles({ user, baseUrl: BASE_URL }),
      /403/
    );
    // A failure is not cached: the next turn asks again.
    iFinderSearchProfiles.fetch = async () => configurationResponse(['searchprofile-hr']);
    const profiles = await iFinderSearchProfiles.getUserSearchProfiles({ user, baseUrl: BASE_URL });
    assert.equal(profiles[0].id, 'searchprofile-hr');
  } finally {
    iFinderSearchProfiles.fetch = originalFetch;
    iFinderSearchProfiles.reset();
  }
});

test('the profiles of an anonymous user are never read', async () => {
  await assert.rejects(
    iFinderSearchProfiles.getUserSearchProfiles({ user: { id: 'anonymous' }, baseUrl: BASE_URL }),
    /signed-in user/
  );
});
