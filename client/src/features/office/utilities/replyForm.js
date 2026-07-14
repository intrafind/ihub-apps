/* global Office */

import { isOutlookMailItemAvailable } from './outlookMailContext';
import { isMailboxAvailable } from './officeCapabilities';
import { marked } from 'marked';

/**
 * @param {string} assistantMarkdownText
 * @param {Object} [options]
 * @param {boolean} [options.silent] - Suppress user-facing alerts on failure (still logs to
 *   console). Used by auto-insert so a background attempt never interrupts the chat with a
 *   popup; the explicit manual "Insert" button keeps alerts.
 * @param {Object} [options.autoInsertOnceRef] - A ref gating the read-mode branch, which opens a
 *   brand-new reply window on every call. When set and `.current` is already `true`, the read-mode
 *   branch no-ops instead of spawning another window; it's flipped to `true` the first time that
 *   branch actually fires. Not consulted in compose mode, where repeated prepends are safe.
 */
export function displayReplyFormWithAssistantResponse(assistantMarkdownText, options = {}) {
  const { silent = false, autoInsertOnceRef } = options;

  if (!isOutlookMailItemAvailable()) {
    console.error('[iHub] Insert requested with no Outlook mail item available.');
    if (!silent) {
      window.alert('Insert is only available when you open this add-in from an email in Outlook.');
    }
    return;
  }

  const item = Office.context.mailbox.item;
  if (!item) {
    console.error('[iHub] Insert requested with no mail item available.');
    if (!silent) window.alert('No mail item available.');
    return;
  }

  const html = marked.parse(assistantMarkdownText);

  // Compose mode: insert into the draft body directly
  if (
    typeof item.body?.prependAsync === 'function' &&
    typeof item.displayReplyFormAsync !== 'function'
  ) {
    item.body.prependAsync(html, { coercionType: Office.CoercionType.Html }, result => {
      if (result.status === Office.AsyncResultStatus.Failed) {
        console.error('[iHub] body.prependAsync failed:', result.error);
        if (!silent) {
          window.alert('Could not insert content into the draft. ' + (result.error?.message || ''));
        }
      }
    });
    return;
  }

  // Read mode: open a reply form pre-filled with the response
  if (typeof item.displayReplyFormAsync === 'function') {
    if (autoInsertOnceRef?.current) return;
    item.displayReplyFormAsync({ htmlBody: html }, result => {
      if (result.status === Office.AsyncResultStatus.Failed) {
        console.error('[iHub] displayReplyFormAsync failed:', result.error);
        if (!silent) {
          window.alert('Could not open reply form. ' + (result.error?.message || ''));
        }
      }
    });
    if (autoInsertOnceRef) autoInsertOnceRef.current = true;
    return;
  }

  // Fallback for older clients: synchronous displayReplyForm
  if (typeof item.displayReplyForm === 'function') {
    item.displayReplyForm(html);
    return;
  }

  console.error('[iHub] Insert is not supported for this item type.');
  if (!silent) window.alert('Insert is not supported for this item type.');
}

export function displayNewEmailFormWithAssistantResponse(assistantMarkdownText) {
  if (!isMailboxAvailable()) {
    window.alert('Creating a new email is only available in Outlook.');
    return;
  }

  const html = marked.parse(assistantMarkdownText);

  if (typeof Office.context.mailbox.displayNewMessageFormAsync === 'function') {
    Office.context.mailbox.displayNewMessageFormAsync({ htmlBody: html }, result => {
      if (result.status === Office.AsyncResultStatus.Failed) {
        console.error('[iHub] displayNewMessageFormAsync failed:', result.error);
        window.alert('Could not open new email form. ' + (result.error?.message || ''));
      }
    });
    return;
  }

  if (typeof Office.context.mailbox.displayNewMessageForm === 'function') {
    Office.context.mailbox.displayNewMessageForm({ htmlBody: html });
    return;
  }

  window.alert('Creating a new email is not supported for this Outlook version.');
}
