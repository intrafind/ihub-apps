// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What an export carries of a message's files: which files went with it, never what was in them.
 *
 * A message sent in this session still holds the payload it was sent with (`imageData`,
 * `fileData`, `audioData`: base64 pictures, the extracted text of documents) and, in its
 * attachment views, a thumbnail as a data URL. A reopened chat has neither. An export is a
 * record of the conversation, not a copy of every file in it, so both are left out and the
 * attachments are described the same way whichever way the chat was reached.
 *
 * @module features/chat/messageAttachments/exportMessage
 */

/**
 * One attachment as an export names it.
 *
 * @param {import('./attachmentViews').AttachmentView} view
 * @returns {{ id?: string, kind: string, name: string, mimeType?: string, bytes?: number }}
 */
function exportableAttachment(view) {
  return {
    ...(view.id ? { id: view.id } : {}),
    kind: view.kind,
    name: view.name,
    ...(view.mimeType ? { mimeType: view.mimeType } : {}),
    // Once only the text is kept, `bytes` is the size of the text, not of the file
    ...(Number.isFinite(view.bytes) && view.originalKept !== false ? { bytes: view.bytes } : {})
  };
}

/** What a message of the page holds for the next send: the files themselves, never exported. */
const PAYLOAD_FIELDS = ['fileData', 'imageData', 'audioData'];

/**
 * A message as the JSON and JSONL exports write it.
 *
 * @param {Object} message - A chat message of the page.
 * @returns {Object}
 */
export function exportableMessage(message) {
  if (!message || typeof message !== 'object') return message;
  // `rest` is a copy: dropping the payload fields does not touch the message of the page
  const { attachments, ...rest } = message;
  for (const field of PAYLOAD_FIELDS) delete rest[field];
  return Array.isArray(attachments) && attachments.length > 0
    ? { ...rest, attachments: attachments.map(exportableAttachment) }
    : rest;
}
