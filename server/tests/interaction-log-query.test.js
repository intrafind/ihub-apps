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
