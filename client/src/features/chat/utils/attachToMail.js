// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import {
  MAX_ATTACHMENT_BYTES,
  attachFileToOutlookItem,
  canAttachFileToOutlookItem,
  isOutlookAttachmentHost
} from '../../office/utilities/outlookAttachments';
import { isOriginalDiscarded } from '../../../api/utils/fileErrors';
import { blobToBase64 } from './uploadedFiles';

/**
 * "Attach to email" for a file of the Files drawer: in the Outlook task pane,
 * while the user is composing a mail, the file (an upload kept in original form,
 * or one the assistant generated) goes onto the draft.
 *
 * @module features/chat/utils/attachToMail
 */

/**
 * Where the action exists at all (the Outlook task pane) and whether it works
 * right now (the open item is a draft). Re-read when the item changes.
 *
 * @returns {{ supported: boolean, available: boolean }}
 */
export function mailAttachState() {
  const supported = isOutlookAttachmentHost();
  return { supported, available: supported && canAttachFileToOutlookItem() };
}

/**
 * Attach a stored file to the mail being written.
 *
 * @param {Object} params
 * @param {{ name: string, bytes?: number }} params.file - Descriptor, for the name and size.
 * @param {() => Promise<Blob>} params.fetchBlob - Reads the original bytes.
 * @returns {Promise<{ ok: true, filename: string } | { ok: false, reason: 'notComposing'|'tooLarge'|'discarded'|'failed', message?: string }>}
 */
export async function attachStoredFileToMail({ file, fetchBlob }) {
  if (!canAttachFileToOutlookItem()) return { ok: false, reason: 'notComposing' };
  try {
    const blob = await fetchBlob();
    if (blob?.size > MAX_ATTACHMENT_BYTES) return { ok: false, reason: 'tooLarge' };
    const filename =
      String(file?.name || 'attachment')
        .split('/')
        .pop() || 'attachment';
    const result = await attachFileToOutlookItem({ base64: await blobToBase64(blob), filename });
    return result.ok ? { ok: true, filename } : result;
  } catch (error) {
    if (isOriginalDiscarded(error)) return { ok: false, reason: 'discarded' };
    return { ok: false, reason: 'failed', message: error?.message };
  }
}
