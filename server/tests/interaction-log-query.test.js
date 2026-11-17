// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryForLog } from '../utils.js';

test('attached document text is not logged, only its length', () => {
  const doc = 'x'.repeat(782559);
  const query = `<content type="document" origin="upload" name="register.xlsx">${doc}</content>\nSummarize this.`;
  const logged = queryForLog(query);
  assert.equal(
    logged,
    '<content type="document" origin="upload" name="register.xlsx">[782559 characters omitted]</content>\nSummarize this.'
  );
});

test('a long query is cut to 1000 characters', () => {
  const logged = queryForLog('a'.repeat(1500));
  assert.equal(logged, `${'a'.repeat(1000)}…[500 more characters]`);
});

test('multimodal content keeps the text and names the other parts', () => {
  assert.equal(
    queryForLog([
      { type: 'text', text: 'What is on it?' },
      { type: 'image_url', image_url: { url: 'data:…' } }
    ]),
    'What is on it? [image_url]'
  );
  assert.equal(queryForLog(undefined), '');
});

test('several blocks are each replaced, the text between them stays', () => {
  assert.equal(
    queryForLog(
      '<content type="document" name="a">aaa</content> and <content type="email">bb</content> compare'
    ),
    '<content type="document" name="a">[3 characters omitted]</content> and <content type="email">[2 characters omitted]</content> compare'
  );
});

test('an unclosed block is left as it is (and cut like any long query)', () => {
  assert.equal(
    queryForLog('<content type="document">half a document'),
    '<content type="document">half a document'
  );
  assert.equal(
    queryForLog('<content type="document">x</content> then <content type="email">open'),
    '<content type="document">[1 characters omitted]</content> then <content type="email">open'
  );
});

test('a self-closing reference does not swallow the question after it', () => {
  assert.equal(
    queryForLog('<content type="document" id="f1" chars="900"/> What does it say?'),
    '<content type="document" id="f1" chars="900"/> What does it say?'
  );
  assert.equal(
    queryForLog('<content id="f1" /> Compare with <content type="document">text</content>'),
    '<content id="f1" /> Compare with <content type="document">[4 characters omitted]</content>'
  );
});

test('many unclosed openers do not block the event loop', () => {
  const hostile = [
    '<content x>'.repeat(20000) + 'y'.repeat(600000),
    '<content '.repeat(20000) + '</content>',
    '<content x>'.repeat(20000) + '</content>' + '<content x>'.repeat(20000),
    '<content a/>'.repeat(20000) + '</content>'
  ];
  for (const text of hostile) {
    const started = process.hrtime.bigint();
    queryForLog(text);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 200, `${ms.toFixed(0)} ms for ${text.slice(0, 20)}…`);
  }
});
