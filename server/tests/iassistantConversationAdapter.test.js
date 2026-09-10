#!/usr/bin/env node

/**
 * iAssistant Conversation adapter specs — global prompt variables in
 * `extraContext` and `systemPromptPreamble` (issue #1384, second half).
 *
 * The first half of #1384 wired global variables into user/system prompts via
 * PromptService. The iassistant response-generation options were left out, so
 * a hardcoded extraContext ("My name is Daniel …") was sent verbatim for every
 * user. These specs pin the adapter-side substitution: `{{user_name}}`,
 * `{{user_email}}`, `{{date}}` etc. resolve against the requesting user before
 * the conversation is created.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import adapter from '../adapters/iassistant-conversation.js';
import conversationApiService from '../services/integrations/ConversationApiService.js';

const user = {
  id: 'user_tim',
  name: 'Tim Vossen',
  email: 'tim.vossen@intrafind.com'
};

const model = { id: 'iassistant-conversation', modelId: 'iassistant-conversation', config: {} };

function optionsWith(iassistant) {
  return {
    user,
    chatId: `chat-${Math.random().toString(36).slice(2)}`,
    appConfig: { id: 'iassistant', iassistant }
  };
}

test('resolveConfig substitutes user variables in extraContext', () => {
  const config = adapter.resolveConfig(
    model,
    optionsWith({
      extraContext: 'You are talking to {{user_name}} ({{user_email}}). Today is {{date_iso}}.'
    })
  );

  assert.match(config.extraContext, /Tim Vossen/);
  assert.match(config.extraContext, /tim\.vossen@intrafind\.com/);
  // date_iso resolves to a concrete YYYY-MM-DD
  assert.match(config.extraContext, /Today is \d{4}-\d{2}-\d{2}\./);
  assert.doesNotMatch(config.extraContext, /\{\{user_name\}\}|\{\{user_email\}\}|\{\{date_iso\}\}/);
});

test('resolveConfig substitutes variables in systemPromptPreamble', () => {
  const config = adapter.resolveConfig(
    model,
    optionsWith({ systemPromptPreamble: 'Address the user as {{user_name}}.' })
  );

  assert.equal(config.systemPromptPreamble, 'Address the user as Tim Vossen.');
});

test('static text without placeholders passes through unchanged', () => {
  const config = adapter.resolveConfig(
    model,
    optionsWith({ extraContext: 'Answer strictly from the knowledge base.' })
  );

  assert.equal(config.extraContext, 'Answer strictly from the knowledge base.');
});

test('unknown placeholders are left intact (same semantics as system prompts)', () => {
  const config = adapter.resolveConfig(
    model,
    optionsWith({ extraContext: 'Company: {{no_such_variable}}, user: {{user_name}}' })
  );

  assert.equal(config.extraContext, 'Company: {{no_such_variable}}, user: Tim Vossen');
});

test('unset extraContext stays unset', () => {
  const config = adapter.resolveConfig(model, optionsWith({}));
  assert.equal(config.extraContext, undefined);
});

test('createCompletionRequest sends the substituted extra_context to the conversation API', async () => {
  const originalCreate = conversationApiService.createConversation;
  let captured = null;
  conversationApiService.createConversation = async params => {
    captured = params;
    return { id: 'conv-test-1', title: null };
  };

  try {
    // The call fails later at JWT signing (no iFinder key in the test env);
    // the conversation-creation params are captured before that.
    await adapter
      .createCompletionRequest(
        model,
        [{ role: 'user', content: 'Welche Dokumente hast du?' }],
        null,
        optionsWith({
          extraContext: 'You are talking to {{user_name}} ({{user_email}}).',
          systemPromptPreamble: 'Greet {{user_name}} once.'
        })
      )
      .catch(() => {});

    assert.ok(captured, 'createConversation was not called');
    assert.equal(
      captured.responseGeneration.extra_context,
      'You are talking to Tim Vossen (tim.vossen@intrafind.com).'
    );
    assert.equal(captured.responseGeneration.system_prompt_preamble, 'Greet Tim Vossen once.');
  } finally {
    conversationApiService.createConversation = originalCreate;
  }
});
