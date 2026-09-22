/* global Office */

import { isMailboxAvailable, isRequirementSetSupported } from './officeCapabilities';
import { detectOutlookMode } from './outlookMailActions';
import { OUTLOOK_COMPOSE_MODE } from './officeMailAction';
import { describeOfficeError, logOfficeError } from './officeLog';

/**
 * Putting a document the assistant found on the mail the user is writing.
 *
 * Outlook accepts attachments only on an item in *compose* mode, and only
 * through `addFileAttachmentFromBase64Async` (Mailbox 1.8). The URL-based
 * `addFileAttachmentAsync` is not usable for iFinder documents: Exchange
 * fetches that URL itself, and the iFinder proxy is behind the user's iHub
 * session. So the pane downloads the document on the authenticated API path
 * and hands Outlook the bytes — which is also what keeps the recipient from
 * needing iFinder access at all.
 *
 * Read mode has nothing to attach to: `displayReplyFormAsync` and friends open
 * a *new* form the pane cannot reach afterwards, and the new-message form
 * takes attachments by URL or item id only. The action is therefore offered
 * but disabled there, the same split `outlookMailActions.js` draws for the
 * answer actions.
 */

/**
 * Outlook rejects oversized attachments with a generic error, and base64
 * encoding a very large download would freeze the pane before it got that
 * far. 25 MB is below the default Exchange message limit and well above
 * anything iFinder normally serves.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * True when this surface is an Outlook mail item at all, i.e. when the action
 * is worth showing even if it is not usable right now.
 *
 * @returns {boolean}
 */
export function isOutlookAttachmentHost() {
  return isMailboxAvailable() && isRequirementSetSupported('Mailbox', '1.8');
}

/**
 * True when the item currently open can take an attachment: the user is
 * composing a mail (or a meeting invitation) on a client new enough for
 * base64 attachments.
 *
 * Re-evaluate on `ihub:itemchanged` — switching from a received mail to a
 * draft flips it.
 *
 * @returns {boolean}
 */
export function canAttachFileToOutlookItem() {
  if (!isOutlookAttachmentHost()) return false;
  if (detectOutlookMode() !== OUTLOOK_COMPOSE_MODE) return false;
  try {
    return typeof Office.context.mailbox.item?.addFileAttachmentFromBase64Async === 'function';
  } catch {
    return false;
  }
}

/**
 * Attach a file to the mail currently being composed.
 *
 * @param {Object} file
 * @param {string} file.base64 file contents, base64 encoded, without a `data:` prefix.
 * @param {string} file.filename name (with extension) the attachment gets in the mail.
 * @returns {Promise<{ok: true}|{ok: false, reason: 'notComposing'|'failed', message?: string}>}
 */
export function attachFileToOutlookItem({ base64, filename }) {
  if (!canAttachFileToOutlookItem()) {
    return Promise.resolve({ ok: false, reason: 'notComposing' });
  }

  return new Promise(resolve => {
    const fail = error => {
      logOfficeError('addFileAttachmentFromBase64Async', error, { filename });
      resolve({ ok: false, reason: 'failed', message: describeOfficeError(error) });
    };

    try {
      Office.context.mailbox.item.addFileAttachmentFromBase64Async(
        base64,
        filename,
        { isInline: false },
        result => {
          if (result?.status === Office.AsyncResultStatus.Failed) {
            fail(result.error);
            return;
          }
          resolve({ ok: true });
        }
      );
    } catch (error) {
      fail(error);
    }
  });
}
