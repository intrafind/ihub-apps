/**
 * Unit tests for client/src/features/office/utilities/replyForm.js
 *
 * Regression coverage for issue #1447 ("[Outlook] Auto-insert assistant reply
 * into the email"):
 *   - `silent: true` must suppress every user-facing `window.alert` (auto-insert
 *     runs after every completed reply and must never interrupt the chat with a
 *     popup), while still logging failures to the console.
 *   - Without `silent`, the manual "Insert" button keeps its existing alerts.
 *   - `autoInsertOnceRef` gates the read-mode branch (which opens a brand-new
 *     reply window on every call) to fire only once; compose mode has no such
 *     gate since repeated prepends are safe.
 */

import '@testing-library/jest-dom';

const {
  displayReplyFormWithAssistantResponse
} = require('../../../client/src/features/office/utilities/replyForm');

const SUCCEEDED = 'succeeded';
const FAILED = 'failed';

function installOfficeMock() {
  global.Office = {
    AsyncResultStatus: { Succeeded: SUCCEEDED, Failed: FAILED },
    CoercionType: { Html: 'html' },
    context: { mailbox: { item: null } }
  };
  return global.Office;
}

function makeComposeItem() {
  const calls = [];
  return {
    calls,
    item: {
      body: {
        prependAsync: (html, opts, cb) => {
          calls.push({ html, opts });
          cb({ status: SUCCEEDED });
        }
      }
    }
  };
}

function makeReadItem() {
  const calls = [];
  return {
    calls,
    item: {
      displayReplyFormAsync: (opts, cb) => {
        calls.push(opts);
        cb({ status: SUCCEEDED });
      }
    }
  };
}

describe('displayReplyFormWithAssistantResponse — auto-insert (issue #1447)', () => {
  let alertSpy;
  let errorSpy;

  beforeEach(() => {
    installOfficeMock();
    alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    alertSpy.mockRestore();
    errorSpy.mockRestore();
    delete global.Office;
  });

  test('silent suppresses window.alert when no Outlook item is available, but still logs', () => {
    global.Office = undefined;

    displayReplyFormWithAssistantResponse('hello', { silent: true });

    expect(alertSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  test('without silent, missing Outlook item still alerts (manual Insert unchanged)', () => {
    global.Office = undefined;

    displayReplyFormWithAssistantResponse('hello');

    expect(alertSpy).toHaveBeenCalledTimes(1);
  });

  test('compose mode inserts on every call regardless of silent — no gating', () => {
    const { item, calls } = makeComposeItem();
    global.Office.context.mailbox.item = item;

    displayReplyFormWithAssistantResponse('first reply', { silent: true });
    displayReplyFormWithAssistantResponse('second reply', { silent: true });

    expect(calls).toHaveLength(2);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  test('read mode: autoInsertOnceRef fires displayReplyFormAsync only once per conversation', () => {
    const { item, calls } = makeReadItem();
    global.Office.context.mailbox.item = item;
    const onceRef = { current: false };

    displayReplyFormWithAssistantResponse('first reply', {
      silent: true,
      autoInsertOnceRef: onceRef
    });
    displayReplyFormWithAssistantResponse('second reply', {
      silent: true,
      autoInsertOnceRef: onceRef
    });

    expect(calls).toHaveLength(1);
    expect(onceRef.current).toBe(true);
  });

  test('read mode: manual insert (no autoInsertOnceRef) fires every time', () => {
    const { item, calls } = makeReadItem();
    global.Office.context.mailbox.item = item;

    displayReplyFormWithAssistantResponse('first reply');
    displayReplyFormWithAssistantResponse('second reply');

    expect(calls).toHaveLength(2);
  });

  test('a fresh autoInsertOnceRef (new conversation) fires again after reset', () => {
    const { item, calls } = makeReadItem();
    global.Office.context.mailbox.item = item;
    const firstConversationRef = { current: false };
    const secondConversationRef = { current: false };

    displayReplyFormWithAssistantResponse('first reply', {
      silent: true,
      autoInsertOnceRef: firstConversationRef
    });
    displayReplyFormWithAssistantResponse('reply in new conversation', {
      silent: true,
      autoInsertOnceRef: secondConversationRef
    });

    expect(calls).toHaveLength(2);
  });
});
