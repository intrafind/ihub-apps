/* global Office */

import { isOutlookMailItemAvailable } from './outlookMailContext';
import { isMailboxAvailable } from './officeCapabilities';
import { marked } from 'marked';

export function displayReplyFormWithAssistantResponse(assistantMarkdownText) {
  if (!isOutlookMailItemAvailable()) {
    window.alert('Insert is only available when you open this add-in from an email in Outlook.');
    return;
  }

  const item = Office.context.mailbox.item;
  if (!item) {
    window.alert('No mail item available.');
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
        window.alert('Could not insert content into the draft. ' + (result.error?.message || ''));
      }
    });
    return;
  }

  // Read mode: open a reply form pre-filled with the response
  if (typeof item.displayReplyFormAsync === 'function') {
    item.displayReplyFormAsync({ htmlBody: html }, result => {
      if (result.status === Office.AsyncResultStatus.Failed) {
        console.error('[iHub] displayReplyFormAsync failed:', result.error);
        window.alert('Could not open reply form. ' + (result.error?.message || ''));
      }
    });
    return;
  }

  // Fallback for older clients: synchronous displayReplyForm
  if (typeof item.displayReplyForm === 'function') {
    item.displayReplyForm(html);
    return;
  }

  window.alert('Insert is not supported for this item type.');
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
