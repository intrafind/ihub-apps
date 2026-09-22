/**
 * Unit tests for client/src/features/office/utilities/outlookMailActions.js
 *
 * Issue #2446 collapsed four field reports into one rework, and these tests
 * pin what each of them was about:
 *
 * - #2447 — "Answer all" must call `displayReplyAllFormAsync`. The old pane
 *   only ever opened a reply-to-sender form, so every other `To:` and all
 *   `CC:` recipients of a thread silently disappeared.
 * - #2458 — inserting into an open draft must write into the body
 *   (`setSelectedDataAsync` / `prependAsync`) rather than hand Office a full
 *   `htmlBody`, which replaces the draft and takes the signature with it.
 * - #2449 — "New email" from a compose surface must not be offered at all:
 *   `displayNewMessageFormAsync` is read mode only, which is why it failed
 *   from a Forward draft with an undiagnosable alert.
 * - the rebuilt Forward, which has no Office.js API behind it.
 *
 * Plus the rule that replaced `window.alert`: a rejected call comes back as a
 * result naming the Office error, and the answer is rescued to the clipboard
 * wherever it could otherwise be lost.
 */

import '@testing-library/jest-dom';

const MODULE_PATH = '../../../client/src/features/office/utilities/outlookMailActions';

function loadModule() {
  let mod;
  jest.isolateModules(() => {
    mod = require(MODULE_PATH);
  });
  return mod;
}

const SUCCESS = { status: 'succeeded' };
const failure = error => ({ status: 'failed', error });

/** The Office.js surface these calls touch, nothing more. */
function installOffice({ item = null, mailbox = {} } = {}) {
  global.Office = {
    AsyncResultStatus: { Succeeded: 'succeeded', Failed: 'failed' },
    CoercionType: { Html: 'html', Text: 'text' },
    context: {
      mailbox: {
        item,
        ...mailbox
      }
    }
  };
  return global.Office;
}

/** A message selected in the reading pane. */
function readModeItem(overrides = {}) {
  return {
    itemId: 'AAMkAD-original',
    subject: 'Quarterly report',
    normalizedSubject: 'Quarterly report',
    from: { displayName: 'Alice', emailAddress: 'alice@example.com' },
    to: [{ displayName: 'Bob', emailAddress: 'bob@example.com' }],
    cc: [{ displayName: 'Carol', emailAddress: 'carol@example.com' }],
    dateTimeCreated: new Date('2026-09-21T14:02:00Z'),
    attachments: [],
    body: {
      getAsync: jest.fn((_coercion, cb) => cb({ ...SUCCESS, value: '<p>Original body</p>' }))
    },
    displayReplyFormAsync: jest.fn((_form, cb) => cb(SUCCESS)),
    displayReplyAllFormAsync: jest.fn((_form, cb) => cb(SUCCESS)),
    ...overrides
  };
}

/** A draft the user is already composing. */
function composeModeItem(overrides = {}) {
  return {
    body: {
      setSelectedDataAsync: jest.fn((_data, _opts, cb) => cb(SUCCESS)),
      prependAsync: jest.fn((_data, _opts, cb) => cb(SUCCESS))
    },
    ...overrides
  };
}

let consoleError;

beforeEach(() => {
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  delete global.Office;
});

describe('mode detection', () => {
  test('a reading-pane item is read mode, a draft is compose mode', () => {
    const m = loadModule();

    installOffice({ item: readModeItem() });
    expect(m.detectOutlookMode()).toBe('read');

    installOffice({ item: composeModeItem() });
    expect(m.detectOutlookMode()).toBe('compose');
  });

  test('no mailbox and no item mean no Outlook mail surface', () => {
    const m = loadModule();
    delete global.Office;
    expect(m.detectOutlookMode()).toBeNull();

    installOffice({ item: null });
    expect(m.detectOutlookMode()).toBeNull();
  });
});

describe('answer / answer all', () => {
  test('answer all calls displayReplyAllFormAsync, so no recipient is dropped (#2447)', async () => {
    const m = loadModule();
    const item = readModeItem();
    installOffice({ item });

    const result = await m.runOutlookMailAction('answerAll', 'Sounds good.');

    expect(result.ok).toBe(true);
    expect(item.displayReplyAllFormAsync).toHaveBeenCalledTimes(1);
    expect(item.displayReplyFormAsync).not.toHaveBeenCalled();
    expect(item.displayReplyAllFormAsync.mock.calls[0][0].htmlBody).toContain('Sounds good.');
  });

  test('answer calls displayReplyFormAsync — the two are no longer the same handler', async () => {
    const m = loadModule();
    const item = readModeItem();
    installOffice({ item });

    const result = await m.runOutlookMailAction('answer', 'Sounds good.');

    expect(result.ok).toBe(true);
    expect(item.displayReplyFormAsync).toHaveBeenCalledTimes(1);
    expect(item.displayReplyAllFormAsync).not.toHaveBeenCalled();
  });

  test('a rejected call reports the Office error instead of alerting', async () => {
    const m = loadModule();
    const item = readModeItem({
      displayReplyAllFormAsync: jest.fn((_form, cb) =>
        cb(failure({ name: 'GenericResponseError', code: 9002, message: 'Item not saved' }))
      )
    });
    installOffice({ item });
    const alert = jest.spyOn(window, 'alert').mockImplementation(() => {});

    const result = await m.runOutlookMailAction('answerAll', 'Sounds good.');

    expect(result.ok).toBe(false);
    // The name and the code are what a field report needs to be diagnosable.
    expect(result.message).toContain('GenericResponseError');
    expect(result.message).toContain('9002');
    expect(alert).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  test('an answer past the form limit opens an empty reply rather than throwing', async () => {
    const m = loadModule();
    const item = readModeItem();
    installOffice({ item });

    const result = await m.runOutlookMailAction('answer', 'x'.repeat(m.MAX_FORM_BODY_CHARS + 100));

    expect(result.ok).toBe(false);
    expect(result.message).toContain(String(m.MAX_FORM_BODY_CHARS));
    // Outlook still builds the reply — recipients, signature, quoted thread.
    expect(item.displayReplyFormAsync).toHaveBeenCalledTimes(1);
    expect(item.displayReplyFormAsync.mock.calls[0][0]).toEqual({});
  });
});

describe('insert', () => {
  test('writes into the open draft at the cursor, leaving the signature alone (#2458)', async () => {
    const m = loadModule();
    const item = composeModeItem();
    installOffice({ item });

    const result = await m.runOutlookMailAction('insert', 'Hello there.');

    expect(result.ok).toBe(true);
    expect(item.body.setSelectedDataAsync).toHaveBeenCalledTimes(1);
    const [html, options] = item.body.setSelectedDataAsync.mock.calls[0];
    expect(html).toContain('Hello there.');
    expect(options).toEqual({ coercionType: 'html' });
    // Never a full-body replace: that is what drops the signature.
    expect(item.body.prependAsync).not.toHaveBeenCalled();
  });

  test('falls back to prepending when there is no insertion point', async () => {
    const m = loadModule();
    const item = composeModeItem({
      body: {
        setSelectedDataAsync: jest.fn((_d, _o, cb) =>
          cb(failure({ name: 'InvalidSelection', code: 2000, message: 'No selection' }))
        ),
        prependAsync: jest.fn((_d, _o, cb) => cb(SUCCESS))
      }
    });
    installOffice({ item });

    const result = await m.runOutlookMailAction('insert', 'Hello there.');

    expect(result.ok).toBe(true);
    expect(item.body.prependAsync).toHaveBeenCalledTimes(1);
  });

  test('is refused in read mode, where there is no draft to insert into', async () => {
    const m = loadModule();
    installOffice({ item: readModeItem() });

    const result = await m.runOutlookMailAction('insert', 'Hello there.');

    expect(result.ok).toBe(false);
  });
});

describe('new email', () => {
  test('opens the new-message form in read mode', async () => {
    const m = loadModule();
    const displayNewMessageFormAsync = jest.fn((_form, cb) => cb(SUCCESS));
    installOffice({ item: readModeItem(), mailbox: { displayNewMessageFormAsync } });

    const result = await m.runOutlookMailAction('new', 'Hello there.');

    expect(result.ok).toBe(true);
    expect(displayNewMessageFormAsync.mock.calls[0][0].htmlBody).toContain('Hello there.');
  });

  test('is not attempted from a compose surface — the API is read mode only (#2449)', async () => {
    const m = loadModule();
    const displayNewMessageFormAsync = jest.fn((_form, cb) => cb(SUCCESS));
    installOffice({ item: composeModeItem(), mailbox: { displayNewMessageFormAsync } });

    const result = await m.runOutlookMailAction('new', 'Hello there.');

    expect(result.ok).toBe(false);
    expect(displayNewMessageFormAsync).not.toHaveBeenCalled();
    // The pane explains the mode instead of surfacing an Office exception.
    expect(result.message).toMatch(/composing/i);
  });
});

describe('forward', () => {
  test('rebuilds a forward: FW: subject, the answer, and the original quoted', async () => {
    const m = loadModule();
    const displayNewMessageFormAsync = jest.fn((_form, cb) => cb(SUCCESS));
    installOffice({ item: readModeItem(), mailbox: { displayNewMessageFormAsync } });

    const result = await m.runOutlookMailAction('forward', 'Passing this on.');

    expect(result.ok).toBe(true);
    const form = displayNewMessageFormAsync.mock.calls[0][0];
    expect(form.subject).toBe('FW: Quarterly report');
    expect(form.htmlBody).toContain('Passing this on.');
    expect(form.htmlBody).toContain('alice@example.com');
    expect(form.htmlBody).toContain('carol@example.com');
    expect(form.htmlBody).toContain('Original body');
    // Nothing to rescue, so no item attachment and no notice.
    expect(form.attachments).toBeUndefined();
    expect(result.notice).toBeNull();
  });

  test('attaches the original when it carries attachments the rebuild cannot re-attach', async () => {
    const m = loadModule();
    const displayNewMessageFormAsync = jest.fn((_form, cb) => cb(SUCCESS));
    installOffice({
      item: readModeItem({
        attachments: [
          { id: '1', name: 'report.pdf', isInline: false },
          { id: '2', name: 'logo.png', isInline: true }
        ]
      }),
      mailbox: { displayNewMessageFormAsync }
    });

    const result = await m.runOutlookMailAction('forward', 'Passing this on.');

    expect(result.ok).toBe(true);
    expect(displayNewMessageFormAsync.mock.calls[0][0].attachments).toEqual([
      { type: 'item', itemId: 'AAMkAD-original', name: 'Quarterly report' }
    ]);
    // The user is told why, rather than wondering where the files went.
    expect(result.notice.message).toBeTruthy();
  });

  test('an inline image alone is not a reason to attach the original', async () => {
    const m = loadModule();
    const displayNewMessageFormAsync = jest.fn((_form, cb) => cb(SUCCESS));
    installOffice({
      item: readModeItem({ attachments: [{ id: '2', name: 'logo.png', isInline: true }] }),
      mailbox: { displayNewMessageFormAsync }
    });

    await m.runOutlookMailAction('forward', 'Passing this on.');

    expect(displayNewMessageFormAsync.mock.calls[0][0].attachments).toBeUndefined();
  });

  test('drops the quote and attaches the original when the body would exceed the cap', async () => {
    const m = loadModule();
    const displayNewMessageFormAsync = jest.fn((_form, cb) => cb(SUCCESS));
    const huge = `<p>${'y'.repeat(m.MAX_FORM_BODY_CHARS)}</p>`;
    installOffice({
      item: readModeItem({
        body: { getAsync: jest.fn((_c, cb) => cb({ ...SUCCESS, value: huge })) }
      }),
      mailbox: { displayNewMessageFormAsync }
    });

    const result = await m.runOutlookMailAction('forward', 'Passing this on.');

    expect(result.ok).toBe(true);
    const form = displayNewMessageFormAsync.mock.calls[0][0];
    expect(form.htmlBody.length).toBeLessThanOrEqual(m.MAX_FORM_BODY_CHARS);
    expect(form.htmlBody).not.toContain('yyyy');
    // Nothing is lost — the whole original rides along instead.
    expect(form.attachments[0].type).toBe('item');
  });
});

describe('buildForwardBody', () => {
  test('quotes the original under a forward header block', () => {
    const { buildForwardBody } = loadModule();

    const { htmlBody, quoted, tooLarge } = buildForwardBody({
      answerHtml: '<p>Answer</p>',
      original: {
        subject: 'Quarterly report',
        from: { displayName: 'Alice', emailAddress: 'alice@example.com' },
        to: [{ displayName: 'Bob', emailAddress: 'bob@example.com' }],
        sentAt: new Date('2026-09-21T14:02:00Z'),
        bodyHtml: '<html><body><p>Original body</p></body></html>'
      }
    });

    expect(quoted).toBe(true);
    expect(tooLarge).toBe(false);
    expect(htmlBody).toContain('Forwarded message');
    expect(htmlBody).toContain('Alice &lt;alice@example.com&gt;');
    expect(htmlBody).toContain('<p>Original body</p>');
    // The document wrapper is unwrapped, not nested into the new draft.
    expect(htmlBody).not.toContain('<html>');
  });

  test('escapes header values so a crafted subject cannot inject markup', () => {
    const { buildForwardBody } = loadModule();

    const { htmlBody } = buildForwardBody({
      answerHtml: '<p>Answer</p>',
      original: { subject: '<img src=x onerror=alert(1)>', bodyHtml: '' }
    });

    expect(htmlBody).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(htmlBody).not.toContain('<img');
  });

  test('reports an answer that alone exceeds the cap instead of truncating it', () => {
    const { buildForwardBody, MAX_FORM_BODY_CHARS } = loadModule();

    const { quoted, tooLarge } = buildForwardBody({
      answerHtml: 'x'.repeat(MAX_FORM_BODY_CHARS + 1),
      original: { subject: 'Quarterly report', bodyHtml: '<p>Original</p>' }
    });

    expect(tooLarge).toBe(true);
    expect(quoted).toBe(false);
  });
});

describe('buildForwardSubject', () => {
  test('prefixes FW: once, whatever the original carried', () => {
    const { buildForwardSubject } = loadModule();
    expect(buildForwardSubject('Quarterly report')).toBe('FW: Quarterly report');
    expect(buildForwardSubject('FW: Quarterly report')).toBe('FW: Quarterly report');
    expect(buildForwardSubject('Fwd: Quarterly report')).toBe('Fwd: Quarterly report');
    expect(buildForwardSubject('')).toBe('FW:');
    expect(buildForwardSubject(undefined)).toBe('FW:');
  });
});

test('an unknown host is refused with an explanation, not an exception', async () => {
  const m = loadModule();
  delete global.Office;

  const result = await m.runOutlookMailAction('answerAll', 'Sounds good.');

  expect(result.ok).toBe(false);
  expect(result.message).toMatch(/Outlook/);
});
