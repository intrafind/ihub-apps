/* global Office */
import { isMailboxAvailable, isRequirementSetSupported } from './officeCapabilities';

/**
 * Attaching an iAssistant document to the mail the user is writing.
 *
 * Outlook only accepts attachments on an item in *compose* mode, through
 * `addFileAttachmentFromBase64Async` (Mailbox 1.8). The URL-based
 * `addFileAttachmentAsync` is not usable here: Exchange fetches that URL
 * itself, and the iFinder proxy is behind the user's iHub session. So the
 * task pane downloads the document on the authenticated API path and hands
 * Outlook the bytes.
 */

/**
 * Outlook rejects oversized attachments with a generic error, and base64
 * encoding a very large download would freeze the pane first. 25 MB is below
 * the default Exchange message limit and above anything iFinder normally
 * serves.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * True when the item currently open in Outlook can take an attachment, i.e.
 * the user is composing a mail (or a meeting invitation) rather than reading
 * one, and the client is new enough for base64 attachments.
 *
 * Re-evaluate this whenever `ihub:itemchanged` fires — switching from a read
 * item to a draft flips it.
 *
 * @returns {boolean}
 */
export function canAttachFileToOutlookItem() {
  if (!isMailboxAvailable()) return false;
  try {
    const item = Office.context.mailbox.item;
    if (typeof item?.addFileAttachmentFromBase64Async !== 'function') return false;
    // `addFileAttachmentFromBase64Async` exists on read items in some builds
    // but only does anything in compose mode, where `item.body.setAsync` is
    // available. Requiring the requirement set as well keeps older clients out.
    return isRequirementSetSupported('Mailbox', '1.8') && typeof item.body?.setAsync === 'function';
  } catch {
    return false;
  }
}

/**
 * Attach a file to the mail currently being composed.
 *
 * @param {Object} file
 * @param {string} file.base64 file contents, base64 encoded, without a data: prefix.
 * @param {string} file.filename name (with extension) the attachment gets in the mail.
 * @returns {Promise<void>} rejects with the Office error message when Outlook refuses.
 */
export function attachFileToOutlookItem({ base64, filename }) {
  return new Promise((resolve, reject) => {
    if (!canAttachFileToOutlookItem()) {
      reject(new Error('NOT_COMPOSING'));
      return;
    }

    try {
      Office.context.mailbox.item.addFileAttachmentFromBase64Async(
        base64,
        filename,
        { isInline: false },
        result => {
          if (result.status === Office.AsyncResultStatus.Failed) {
            const error = new Error(result.error?.message || 'Outlook refused the attachment');
            error.code = result.error?.code;
            reject(error);
            return;
          }
          resolve();
        }
      );
    } catch (error) {
      reject(error);
    }
  });
}
