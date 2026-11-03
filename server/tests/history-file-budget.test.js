// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The files of earlier turns stay inline within a share of the context
 * window; an older one becomes a stub the model reads with `chat_files_read`
 * (`shared/historyFileBudget.js`). The turn being answered always keeps its
 * files.
 *
 * Run: node --test server/tests/history-file-budget.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_FILE_BUDGET_MIN_TOKENS,
  applyHistoryFileBudget,
  historyFileBudgetTokens
} from '../../shared/historyFileBudget.js';
import { OMITTED_FILES_RULE_TEXT, renderUserMessage } from '../../shared/promptContext.js';
import { conversationTokenFragments } from '../../shared/contextUsage.js';

/** A stored file of `tokens` estimated tokens (4 characters each). */
function file(id, tokens, extra = {}) {
  return {
    id,
    fileId: id,
    fileName: `${id}.txt`,
    name: `${id}.txt`,
    fileType: 'text/plain',
    type: 'document',
    origin: 'upload',
    content: 'x'.repeat(tokens * 4),
    ...extra
  };
}

test('the budget is a quarter of the context window, never below the floor', () => {
  assert.equal(historyFileBudgetTokens(200000), 50000);
  assert.equal(historyFileBudgetTokens(8000), HISTORY_FILE_BUDGET_MIN_TOKENS);
  assert.equal(historyFileBudgetTokens(undefined), null);
  assert.equal(historyFileBudgetTokens(0), null);
});

test('keeps the newest earlier files, stubs the older ones, never the current turn', () => {
  const messages = [
    { role: 'user', content: 'first', fileData: [file('old', 600)] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'second', fileData: [file('recent', 600)] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'now', fileData: [file('current', 5000)] }
  ];
  const { messages: out, omitted } = applyHistoryFileBudget(messages, { budgetTokens: 1000 });
  assert.equal(omitted, 1);
  assert.equal(out[0].fileData[0].omitted, true);
  assert.equal(out[0].fileData[0].id, 'old');
  assert.equal(out[0].fileData[0].textChars, 2400);
  assert.equal(out[0].fileData[0].content, undefined);
  assert.equal(out[2].fileData[0].content.length, 2400, 'the newer earlier file stays');
  assert.equal(out[4], messages[4], 'the turn being answered is untouched');
  assert.equal(messages[0].fileData[0].omitted, undefined, 'the input is not changed');
});

test('keeps files that cannot be read again and host items', () => {
  const messages = [
    {
      role: 'user',
      content: 'first',
      fileData: [
        { ...file('inline', 5000), id: undefined, fileId: undefined },
        file('mail', 5000, { origin: 'email' })
      ]
    },
    { role: 'user', content: 'now' }
  ];
  const { omitted } = applyHistoryFileBudget(messages, { budgetTokens: 10 });
  assert.equal(omitted, 0);
});

test('no context window, no budget', () => {
  const messages = [
    { role: 'user', content: 'a', fileData: [file('f', 100000)] },
    { role: 'user', content: 'b' }
  ];
  const result = applyHistoryFileBudget(messages, {});
  assert.equal(result.omitted, 0);
  assert.equal(result.messages, messages);
});

test('a stub renders as a named empty block with the rule to read it', () => {
  const [stubbed] = applyHistoryFileBudget(
    [
      { role: 'user', content: 'first', fileData: [file('file_abc', 600)] },
      { role: 'user', content: 'now' }
    ],
    { budgetTokens: 10 }
  ).messages;
  const text = renderUserMessage({ content: stubbed.content, files: stubbed.fileData });
  assert.match(
    text,
    /<content type="document" origin="upload" id="file_abc" name="file_abc.txt" format="text\/plain" omitted="true" chars="2400"\/>/
  );
  assert.ok(text.includes(OMITTED_FILES_RULE_TEXT));
  assert.ok(!text.includes('xxxx'));
  // Without a stub the rule is not added.
  const plain = renderUserMessage({ content: 'q', files: [file('f', 10)] });
  assert.ok(!plain.includes(OMITTED_FILES_RULE_TEXT));
});

test('the context meter counts a stubbed file as its stub', () => {
  const messages = [
    { role: 'user', content: 'first', fileData: [file('big', 100000)] },
    { role: 'assistant', content: 'ok' }
  ];
  const full = conversationTokenFragments(messages).join('');
  const budgeted = conversationTokenFragments(messages, { contextWindow: 32000 }).join('');
  assert.ok(full.length > 400000);
  assert.ok(budgeted.length < 2000);
  assert.match(budgeted, /omitted="true"/);
});
