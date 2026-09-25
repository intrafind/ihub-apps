/* global Office */

/**
 * Runs the task pane's answer actions against Office.js (issue #2446).
 *
 * `officeMailAction.js` owns the vocabulary and the default resolution; this
 * module is the only place that touches the Outlook item. One action, one
 * Office call, no shared handlers:
 *
 * | Action      | Office.js                                                    |
 * |-------------|--------------------------------------------------------------|
 * | `answer`    | `item.displayReplyFormAsync`                                 |
 * | `answerAll` | `item.displayReplyAllFormAsync` — keeps every To: and Cc:    |
 * | `forward`   | `mailbox.displayNewMessageFormAsync` + a rebuilt forward      |
 * | `new`       | `mailbox.displayNewMessageFormAsync`                         |
 * | `insert`    | `item.body.setSelectedDataAsync`, else `prependAsync`        |
 *
 * ## Forward
 *
 * The Outlook JavaScript API has no `displayForwardForm`. Forward is therefore
 * rebuilt on top of the new-message form: subject `FW: …`, body = the
 * assistant's answer, a standard forward header block, and the original body
 * quoted underneath. Two things the rebuild cannot do are handled explicitly
 * rather than silently:
 *
 * - `displayNewMessageFormAsync` takes attachments by URL or by item id, never
 *   by the original's attachment ids, so the original's files cannot be
 *   re-attached individually. When the original carries attachments the whole
 *   message rides along as an item attachment instead, and the pane says so.
 * - The form body is capped at 32 K characters. When the quoted original would
 *   blow the cap it is dropped and the original is attached instead — the
 *   content is preserved, just one click further away.
 *
 * ## Signatures
 *
 * `insert` writes into an existing draft, so Outlook's signature and the
 * quoted thread the draft already carries stay exactly as they are. The
 * read-mode actions open a *new* form, and Outlook suppresses the automatic
 * signature whenever an add-in supplies `htmlBody` — a platform limitation with
 * no API workaround, documented in `docs/outlook-add-in.md`.
 *
 * ## Failures
 *
 * Every rejection is logged with the Office error's `name` / `code` /
 * `message` (`officeLog.js`) and returned as a result the caller renders in
 * the pane — never a `window.alert`. Where the answer itself could be lost it
 * is copied to the clipboard first, so "too long for Outlook" still leaves the
 * user something to paste.
 */

import { marked } from 'marked';
import { isMailboxAvailable } from './officeCapabilities';
import { describeOfficeError, logOfficeError } from './officeLog';
import {
  MAIL_ACTION_ANSWER,
  MAIL_ACTION_ANSWER_ALL,
  MAIL_ACTION_FORWARD,
  MAIL_ACTION_INSERT,
  MAIL_ACTION_NEW,
  OUTLOOK_COMPOSE_MODE,
  OUTLOOK_READ_MODE,
  isMailActionAvailable
} from './officeMailAction';

/**
 * Outlook caps a form body at 32 K characters. The margin covers the subject
 * and attachment descriptors that travel in the same call — exceeding the cap
 * throws rather than truncating.
 */
export const MAX_FORM_BODY_CHARS = 30000;

/** English defaults for the strings the forward block needs; the pane passes localized ones. */
export const DEFAULT_FORWARD_LABELS = {
  forwarded: 'Forwarded message',
  from: 'From',
  sent: 'Sent',
  to: 'To',
  cc: 'Cc',
  subject: 'Subject'
};

const escapeHtml = value =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Which Outlook surface the pane is attached to.
 *
 * An explicit discriminator rather than the implicit feature test the old
 * `replyForm.js` used: read-mode items expose the `display*FormAsync` openers,
 * compose-mode items expose the body writers. Callers re-evaluate this on
 * `ihub:itemchanged`.
 *
 * @returns {'read'|'compose'|null} null when this is not an Outlook mail item
 */
export function detectOutlookMode(item) {
  if (item === undefined) {
    if (!isMailboxAvailable()) return null;
    try {
      item = Office.context.mailbox.item;
    } catch {
      return null;
    }
  }
  try {
    if (!item) return null;
    if (typeof item.displayReplyFormAsync === 'function') return OUTLOOK_READ_MODE;
    if (typeof item.displayReplyForm === 'function') return OUTLOOK_READ_MODE;
    if (
      typeof item.body?.setSelectedDataAsync === 'function' ||
      typeof item.body?.prependAsync === 'function'
    ) {
      return OUTLOOK_COMPOSE_MODE;
    }
    return null;
  } catch {
    return null;
  }
}

/** Wrap a callback-style Office call so it resolves instead of throwing. */
function officeCall(invoke) {
  return new Promise(resolve => {
    try {
      invoke(result => {
        if (result?.status === Office.AsyncResultStatus.Failed) {
          resolve({ ok: false, error: result.error });
          return;
        }
        resolve({ ok: true, value: result?.value });
      });
    } catch (error) {
      resolve({ ok: false, error });
    }
  });
}

/**
 * Best-effort clipboard write, so a failed action never loses the answer.
 * @returns {Promise<boolean>}
 */
async function copyToClipboard(text) {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied, or the pane is not the focused document.
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand?.('copy') ?? false;
    document.body.removeChild(textarea);
    return !!copied;
  } catch {
    return false;
  }
}

const succeeded = (action, notice = null) => ({ ok: true, action, notice });

/**
 * A failure the caller renders. `clipboard` says whether the answer was
 * rescued, so the message can tell the user where to find it.
 */
const failed = (action, message, { clipboard = false } = {}) => ({
  ok: false,
  action,
  message,
  clipboard
});

/**
 * `FW: ` in front of the subject, unless it already carries a forward prefix.
 * @param {string} subject
 */
export function buildForwardSubject(subject) {
  const trimmed = String(subject ?? '').trim();
  if (!trimmed) return 'FW:';
  if (/^(fw|fwd)\s*:/i.test(trimmed)) return trimmed;
  return `FW: ${trimmed}`;
}

const formatRecipients = list =>
  (Array.isArray(list) ? list : [])
    .map(entry => {
      const name = entry?.displayName || entry?.name || '';
      const email = entry?.emailAddress || entry?.email || '';
      if (name && email && name !== email) return `${name} <${email}>`;
      return name || email;
    })
    .filter(Boolean)
    .join('; ');

const formatSentAt = value => {
  if (!value) return '';
  try {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString();
  } catch {
    return '';
  }
};

/**
 * `item.body.getAsync(Html)` may hand back a whole document in some Outlook
 * builds. Quoting the body element's contents keeps the forward from nesting
 * `<html>`/`<head>` inside the new draft.
 */
function extractBodyFragment(html) {
  const text = String(html ?? '');
  const match = /<body[^>]*>([\s\S]*)<\/body>/i.exec(text);
  return match ? match[1] : text;
}

/**
 * The body of a rebuilt forward: the answer, the forward header block, and the
 * original quoted underneath — dropping the quote when it would exceed
 * Outlook's form cap.
 *
 * Pure and exported so the size decision is testable without Office.js.
 *
 * @param {object} params
 * @param {string} params.answerHtml - the assistant's answer, already HTML
 * @param {object} params.original - `{ subject, from, to, cc, sentAt, bodyHtml }`
 * @param {object} [params.labels] - localized field names, see `DEFAULT_FORWARD_LABELS`
 * @param {number} [params.maxChars]
 * @returns {{ htmlBody: string, quoted: boolean, tooLarge: boolean }}
 *   `quoted` false means the original body did not fit; `tooLarge` means even
 *   the answer alone does not fit, and no form can be opened with it.
 */
export function buildForwardBody({
  answerHtml,
  original = {},
  labels = DEFAULT_FORWARD_LABELS,
  maxChars = MAX_FORM_BODY_CHARS
}) {
  const l = { ...DEFAULT_FORWARD_LABELS, ...(labels || {}) };
  const rows = [
    [l.from, formatRecipients(original.from ? [original.from] : [])],
    [l.sent, formatSentAt(original.sentAt)],
    [l.to, formatRecipients(original.to)],
    [l.cc, formatRecipients(original.cc)],
    [l.subject, original.subject || '']
  ].filter(([, value]) => value);

  const header =
    `<p></p><div style="border-top:1px solid #ccc;padding-top:8px">` +
    `<p><b>---------- ${escapeHtml(l.forwarded)} ----------</b></p>` +
    rows
      .map(([label, value]) => `<p><b>${escapeHtml(label)}:</b> ${escapeHtml(value)}</p>`)
      .join('') +
    `</div>`;

  const base = `${answerHtml}${header}`;
  if (base.length > maxChars) {
    return { htmlBody: base, quoted: false, tooLarge: true };
  }

  const quote = extractBodyFragment(original.bodyHtml).trim();
  if (quote && base.length + quote.length <= maxChars) {
    return { htmlBody: `${base}${quote}`, quoted: true, tooLarge: false };
  }
  return { htmlBody: base, quoted: false, tooLarge: false };
}

/** Read the fields a forward needs off a read-mode item. */
async function readOriginalForForward(item) {
  const bodyResult =
    typeof item.body?.getAsync === 'function'
      ? await officeCall(cb => item.body.getAsync(Office.CoercionType.Html, cb))
      : { ok: false, error: null };

  if (!bodyResult.ok && bodyResult.error) {
    // Not fatal: the forward still carries the answer and the attached original.
    logOfficeError('body.getAsync', bodyResult.error, { action: MAIL_ACTION_FORWARD });
  }

  const attachments = Array.isArray(item.attachments) ? item.attachments : [];
  return {
    subject: item.normalizedSubject || item.subject || '',
    from: item.from || item.sender || null,
    to: item.to || [],
    cc: item.cc || [],
    sentAt: item.dateTimeCreated || item.dateTimeSent || null,
    bodyHtml: bodyResult.ok ? bodyResult.value : '',
    itemId: item.itemId || null,
    // Inline images are part of the quoted body; only real attachments would be lost.
    attachmentCount: attachments.filter(a => a && a.isInline !== true).length
  };
}

/**
 * Insert into the open draft: at the cursor when Outlook gives us a selection,
 * prepended otherwise. Both leave the signature and the quoted thread alone —
 * unlike handing Office a full `htmlBody`, which replaces them.
 */
async function runInsert(item, html) {
  const body = item?.body;
  if (!body) return failed(MAIL_ACTION_INSERT, 'No draft is open to insert into.');

  if (typeof body.setSelectedDataAsync === 'function') {
    const result = await officeCall(cb =>
      body.setSelectedDataAsync(html, { coercionType: Office.CoercionType.Html }, cb)
    );
    if (result.ok) return succeeded(MAIL_ACTION_INSERT);
    // Fails when the body never had focus, so there is no insertion point.
    logOfficeError('body.setSelectedDataAsync', result.error, { action: MAIL_ACTION_INSERT });
  }

  if (typeof body.prependAsync === 'function') {
    const result = await officeCall(cb =>
      body.prependAsync(html, { coercionType: Office.CoercionType.Html }, cb)
    );
    if (result.ok) return succeeded(MAIL_ACTION_INSERT);
    logOfficeError('body.prependAsync', result.error, { action: MAIL_ACTION_INSERT });
    return failed(
      MAIL_ACTION_INSERT,
      `Outlook refused the insert. ${describeOfficeError(result.error)}`.trim()
    );
  }

  return failed(MAIL_ACTION_INSERT, 'This Outlook version cannot insert into the draft.');
}

/** Reply to sender / reply to all, preserving every recipient in the latter. */
async function runReply(item, action, html, plainText) {
  const isAll = action === MAIL_ACTION_ANSWER_ALL;
  const asyncFn = isAll ? item?.displayReplyAllFormAsync : item?.displayReplyFormAsync;
  const syncFn = isAll ? item?.displayReplyAllForm : item?.displayReplyForm;
  const scope = isAll ? 'displayReplyAllFormAsync' : 'displayReplyFormAsync';

  if (html.length > MAX_FORM_BODY_CHARS) {
    // Opening the form with the answer would throw. Open it empty instead, so
    // Outlook still builds the reply (recipients, signature, quoted thread)
    // and the user pastes the answer in.
    const copied = await copyToClipboard(plainText);
    if (typeof asyncFn === 'function') await officeCall(cb => asyncFn.call(item, {}, cb));
    else if (typeof syncFn === 'function') syncFn.call(item, '');
    logOfficeError(scope, new Error('answer exceeds the Outlook form body limit'), {
      action,
      chars: html.length,
      limit: MAX_FORM_BODY_CHARS
    });
    return failed(
      action,
      copied
        ? `The answer is longer than Outlook's ${MAX_FORM_BODY_CHARS}-character form limit, so the reply was opened empty. The answer is on your clipboard — paste it in.`
        : `The answer is longer than Outlook's ${MAX_FORM_BODY_CHARS}-character form limit. Copy it from the chat and paste it into the reply.`,
      { clipboard: copied }
    );
  }

  if (typeof asyncFn === 'function') {
    const result = await officeCall(cb => asyncFn.call(item, { htmlBody: html }, cb));
    if (result.ok) return succeeded(action);
    logOfficeError(scope, result.error, { action, chars: html.length });
    const copied = await copyToClipboard(plainText);
    return failed(
      action,
      `Outlook could not open the reply. ${describeOfficeError(result.error)}${
        copied ? ' The answer is on your clipboard.' : ''
      }`.trim(),
      { clipboard: copied }
    );
  }

  if (typeof syncFn === 'function') {
    // Pre-1.9 clients: no async variant, no result to inspect.
    syncFn.call(item, html);
    return succeeded(action);
  }

  return failed(action, 'This Outlook version does not support opening a reply from an add-in.');
}

/**
 * Open a new message form. Shared by `new` and the rebuilt `forward`.
 * @param {string} action
 * @param {object} form - the `MessageForm` passed to Office
 * @param {string} plainText - the answer, for the clipboard fallback
 * @param {object|null} notice - shown on success (e.g. "the original is attached")
 */
async function openNewMessageForm(action, form, plainText, notice = null) {
  const mailbox = Office.context.mailbox;

  if (typeof mailbox.displayNewMessageFormAsync === 'function') {
    const result = await officeCall(cb => mailbox.displayNewMessageFormAsync(form, cb));
    if (result.ok) return succeeded(action, notice);
    logOfficeError('displayNewMessageFormAsync', result.error, {
      action,
      chars: form.htmlBody?.length ?? 0,
      attachments: form.attachments?.length ?? 0
    });
    const copied = await copyToClipboard(plainText);
    return failed(
      action,
      `Outlook could not open the new email. ${describeOfficeError(result.error)}${
        copied ? ' The answer is on your clipboard.' : ''
      }`.trim(),
      { clipboard: copied }
    );
  }

  if (typeof mailbox.displayNewMessageForm === 'function') {
    mailbox.displayNewMessageForm(form);
    return succeeded(action, notice);
  }

  return failed(
    action,
    'This Outlook version does not support opening a new email from an add-in.'
  );
}

async function runForward(item, html, plainText, labels, noticeText) {
  if (!item) return failed(MAIL_ACTION_FORWARD, 'No email is selected to forward.');

  const original = await readOriginalForForward(item);
  const { htmlBody, quoted, tooLarge } = buildForwardBody({ answerHtml: html, original, labels });

  if (tooLarge) {
    const copied = await copyToClipboard(plainText);
    logOfficeError('displayNewMessageFormAsync', new Error('forward body exceeds the limit'), {
      action: MAIL_ACTION_FORWARD,
      chars: htmlBody.length,
      limit: MAX_FORM_BODY_CHARS
    });
    return failed(
      MAIL_ACTION_FORWARD,
      `The answer is longer than Outlook's ${MAX_FORM_BODY_CHARS}-character form limit, so the forward could not be built.${
        copied ? ' The answer is on your clipboard.' : ''
      }`,
      { clipboard: copied }
    );
  }

  // The original rides along whenever something would otherwise be lost: its
  // attachments (which the new-message form cannot re-attach individually) or
  // a body too long to quote.
  const mustAttachOriginal = (original.attachmentCount > 0 || !quoted) && !!original.itemId;
  const form = {
    subject: buildForwardSubject(original.subject),
    htmlBody
  };
  if (mustAttachOriginal) {
    form.attachments = [
      {
        type: 'item',
        itemId: original.itemId,
        name: original.subject || 'Original message'
      }
    ];
  }

  return openNewMessageForm(
    MAIL_ACTION_FORWARD,
    form,
    plainText,
    mustAttachOriginal ? { kind: 'info', message: noticeText } : null
  );
}

async function runNew(html, plainText) {
  if (html.length > MAX_FORM_BODY_CHARS) {
    const copied = await copyToClipboard(plainText);
    logOfficeError('displayNewMessageFormAsync', new Error('answer exceeds the form body limit'), {
      action: MAIL_ACTION_NEW,
      chars: html.length,
      limit: MAX_FORM_BODY_CHARS
    });
    return failed(
      MAIL_ACTION_NEW,
      `The answer is longer than Outlook's ${MAX_FORM_BODY_CHARS}-character form limit.${
        copied ? ' The answer is on your clipboard — paste it into a new email.' : ''
      }`,
      { clipboard: copied }
    );
  }
  return openNewMessageForm(MAIL_ACTION_NEW, { htmlBody: html }, plainText);
}

/**
 * Run one answer action against the current Outlook item.
 *
 * @param {string} action - one of `OFFICE_MAIL_ACTIONS`
 * @param {string} markdownText - the assistant's answer
 * @param {object} [options]
 * @param {object} [options.forwardLabels] - localized forward-header strings
 * @param {string} [options.originalAttachedNotice] - shown when the original is attached
 * @returns {Promise<{ ok: boolean, action: string, notice?: object|null, message?: string, clipboard?: boolean }>}
 */
export async function runOutlookMailAction(action, markdownText, options = {}) {
  if (!isMailboxAvailable()) {
    return failed(action, 'This action is only available when the add-in is open in Outlook.');
  }

  const plainText = String(markdownText ?? '');
  const html = marked.parse(plainText);

  let item = null;
  try {
    item = Office.context.mailbox.item;
  } catch {}
  const mode = detectOutlookMode(item);
  if (!isMailActionAvailable(action, mode)) {
    return failed(
      action,
      mode === OUTLOOK_COMPOSE_MODE
        ? 'Outlook only allows inserting into the draft while you are composing an email.'
        : 'This action is not available for the selected item.'
    );
  }

  try {
    // `return await`, not a bare `return`: returning a promise out of a try
    // block hands it to the caller unawaited, so an async rejection — which
    // is what a stale item read inside `runForward` produces — would sail
    // straight past the catch below.
    switch (action) {
      case MAIL_ACTION_INSERT:
        return await runInsert(item, html);
      case MAIL_ACTION_ANSWER:
      case MAIL_ACTION_ANSWER_ALL:
        return await runReply(item, action, html, plainText);
      case MAIL_ACTION_FORWARD:
        return await runForward(
          item,
          html,
          plainText,
          options.forwardLabels,
          options.originalAttachedNotice ||
            'The original message is attached so none of its attachments are lost.'
        );
      case MAIL_ACTION_NEW:
        return await runNew(html, plainText);
      default:
        return failed(action, `Unknown action: ${action}`);
    }
  } catch (error) {
    // Reading a stale `Office.context.mailbox.item` — or any of its
    // properties — throws rather than returning an error result, which is why
    // every other reader in this feature wraps that access. Without this the
    // rejection escapes to a caller that does not catch it and the pane shows
    // nothing at all, which is worse than the alert this module replaced.
    logOfficeError('runOutlookMailAction', error, { action, mode });
    return failed(
      action,
      `Outlook could not run this action. ${describeOfficeError(error)}`.trim()
    );
  }
}
