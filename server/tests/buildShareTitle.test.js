// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildShareTitle } from '../services/chat/chatSharing.js';

describe('buildShareTitle', () => {
  it('names a chat share after the chat', () => {
    assert.equal(buildShareTitle({ chat: { title: 'Q3 budget review' } }), 'Q3 budget review');
  });

  it('falls back to the first user message for an untitled chat', () => {
    const messages = [
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: '  Plan a   trip to Lisbon \n next spring ' }
    ];
    assert.equal(
      buildShareTitle({ chat: { title: '' }, messages }),
      'Plan a trip to Lisbon next spring'
    );
  });

  it('returns an empty string when nothing is usable', () => {
    assert.equal(buildShareTitle({ chat: {}, messages: [] }), '');
    assert.equal(buildShareTitle(), '');
  });

  it('names an artifact share after the chat and the file', () => {
    assert.equal(
      buildShareTitle({ chat: { title: 'Bakery landing page' }, artifact: { name: 'page.html' } }),
      'Bakery landing page – page.html'
    );
  });

  it('uses the chat name alone for an unnamed artifact, and the file name alone without a chat name', () => {
    assert.equal(
      buildShareTitle({ chat: { title: 'Logo ideas' }, artifact: { kind: 'image' } }),
      'Logo ideas'
    );
    assert.equal(buildShareTitle({ chat: {}, artifact: { name: 'chart.png' } }), 'chart.png');
  });

  it('does not repeat a file name that equals the chat title', () => {
    assert.equal(
      buildShareTitle({ chat: { title: 'report.pdf' }, artifact: { name: 'report.pdf' } }),
      'report.pdf'
    );
  });

  it('keeps the file name whole and shortens a long chat title', () => {
    const title = buildShareTitle({
      chat: { title: 'x'.repeat(200) },
      artifact: { name: 'page.html' }
    });
    assert.ok(title.length <= 200);
    assert.ok(title.endsWith(' – page.html'));
  });
});
