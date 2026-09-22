#!/usr/bin/env node

/**
 * PromptService.processMessageTemplates — text inserted for {{content}} must
 * reach the model exactly as written. The Outlook add-in and file uploads put
 * arbitrary third-party text there: an email quoting "$$" or "$&" must not be
 * altered by String.replace's replacement patterns, and a "{{user_name}}"
 * inside an email must not be expanded like a template placeholder.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import configCache from '../configCache.js';
import PromptService from '../services/PromptService.js';

Object.assign(configCache, {
  getPlatform: () => ({ defaultLanguage: 'en' }),
  getStyles: () => ({})
});

const app = { system: { en: 'You are a helpful assistant.' } };

async function renderUserMessage(message, user = null) {
  const result = await PromptService.processMessageTemplates(
    [message],
    app,
    null,
    null,
    'en',
    null,
    user
  );
  return result.find(m => m.role === 'user').content;
}

test('dollar patterns inside the inserted content are literal', async () => {
  const content = "Total: $$ 5 — see $& and $' and $` and $1 and $<name>.";
  const out = await renderUserMessage({
    role: 'user',
    content,
    promptTemplate: { en: 'Reply to:\n{{content}}' },
    variables: {}
  });
  assert.equal(out, `Reply to:\n${content}`);
});

test('placeholders inside the content are not expanded, template placeholders are', async () => {
  const out = await renderUserMessage(
    {
      role: 'user',
      content: 'The email says {{user_name}} and {{date}} and {{content}}.',
      promptTemplate: { en: 'From {{user_name}}: {{content}}' },
      variables: {}
    },
    { name: 'Ada Lovelace', email: 'ada@example.com' }
  );
  assert.equal(
    out,
    'From Ada Lovelace: The email says {{user_name}} and {{date}} and {{content}}.'
  );
});

test('app variables are substituted and may themselves contain dollar patterns', async () => {
  const out = await renderUserMessage({
    role: 'user',
    content: 'x',
    promptTemplate: { en: '{{tone}} / {{content}}' },
    variables: { tone: 'cost: $& please' }
  });
  assert.equal(out, 'cost: $& please / x');
});

test('a template that repeats {{content}} gets the content twice, unaltered', async () => {
  const out = await renderUserMessage({
    role: 'user',
    content: 'a $$ b',
    promptTemplate: { en: '{{content}} | {{content}}' },
    variables: {}
  });
  assert.equal(out, 'a $$ b | a $$ b');
});

test('messages without a template keep dollar patterns intact while global placeholders expand', async () => {
  const out = await renderUserMessage(
    { role: 'user', content: 'plain $& text for {{user_name}}' },
    { name: 'Ada' }
  );
  assert.equal(out, 'plain $& text for Ada');
});
