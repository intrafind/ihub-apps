/* global Office */

import { isOutlookMailItemAvailable } from './outlookMailContext';
import { isMailboxAvailable } from './officeCapabilities';
import { marked } from 'marked';

/**
 * Helper to extract sender email address from the current mail item.
 * Returns the sender's email address or null if unavailable.
 */
function getSenderEmailAddress(item) {
  try {
    // In read mode, sender is available directly
    if (item.from && item.from.emailAddress) {
      return item.from.emailAddress;
    }
    // Fallback to sender property if from is not available
    if (item.sender && item.sender.emailAddress) {
      return item.sender.emailAddress;
    }
  } catch (e) {
    console.warn('[iHub] Could not extract sender email:', e);
  }
  return null;
}

/**
 * Helper to get the subject from the current mail item.
 * Returns subject string or null if unavailable.
 */
function getSubject(item) {
  try {
    // In read mode, subject is directly available as a string
    if (typeof item.subject === 'string') {
      return item.subject;
    }
  } catch (e) {
    console.warn('[iHub] Could not extract subject:', e);
  }
  return null;
}

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
    // Build the form data object with body, recipient, and subject
    const formData = { htmlBody: html };

    // Extract sender email to set as recipient
    const senderEmail = getSenderEmailAddress(item);
    if (senderEmail) {
      formData.toRecipients = [senderEmail];
    }

    // Extract subject and prefix with "Re: " if not already present
    const originalSubject = getSubject(item);
    if (originalSubject) {
      // Add "Re: " prefix if it's not already there
      const subjectPrefix = 'Re: ';
      formData.subject = originalSubject.startsWith(subjectPrefix)
        ? originalSubject
        : subjectPrefix + originalSubject;
    }

    item.displayReplyFormAsync(formData, result => {
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
