/**
 * Tests for appendDocumentOnlyNotice (issue #1662): when a user turns on
 * "document only" mode for an app with file upload enabled, the system
 * prompt should gain a directive telling the model to stick to the
 * uploaded document(s) instead of blending in general knowledge.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendDocumentOnlyNotice } from '../services/chat/RequestBuilder.js';

function systemMessages(content) {
  return [
    { role: 'system', content },
    { role: 'user', content: 'Summarize the document' }
  ];
}

describe('appendDocumentOnlyNotice', () => {
  it('does nothing when the app has no upload configured', () => {
    const messages = systemMessages('You are a helpful assistant.');
    const appended = appendDocumentOnlyNotice(messages, { id: 'a', upload: undefined }, true);
    assert.equal(appended, false);
    assert.equal(messages[0].content, 'You are a helpful assistant.');
  });

  it('does nothing when documentOnlyEnabled is falsy', () => {
    const messages = systemMessages('You are a helpful assistant.');
    const app = { id: 'a', upload: { enabled: true } };
    assert.equal(appendDocumentOnlyNotice(messages, app, false), false);
    assert.equal(appendDocumentOnlyNotice(messages, app, undefined), false);
    assert.equal(messages[0].content, 'You are a helpful assistant.');
  });

  it('appends the notice when upload is enabled and the toggle is on', () => {
    const messages = systemMessages('You are a helpful assistant.');
    const app = { id: 'a', upload: { enabled: true } };
    const appended = appendDocumentOnlyNotice(messages, app, true);
    assert.equal(appended, true);
    assert.match(messages[0].content, /general knowledge/i);
    assert.match(messages[0].content, /uploaded document/i);
  });

  it('is idempotent — does not duplicate the notice on repeated calls', () => {
    const messages = systemMessages('You are a helpful assistant.');
    const app = { id: 'a', upload: { enabled: true } };
    appendDocumentOnlyNotice(messages, app, true);
    const secondCallAppended = appendDocumentOnlyNotice(messages, app, true);
    assert.equal(secondCallAppended, false);
    const occurrences = messages[0].content.split('general knowledge').length - 1;
    assert.equal(occurrences, 1);
  });

  it('no-ops when there is no system message to amend', () => {
    const messages = [{ role: 'user', content: 'Summarize the document' }];
    const app = { id: 'a', upload: { enabled: true } };
    assert.equal(appendDocumentOnlyNotice(messages, app, true), false);
  });
});
