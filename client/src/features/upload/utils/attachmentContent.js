// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { saveBlobAs } from '../../../utils/externalNavigation';
import { isStoredStub } from './attachmentDescription';
import { ORIGINAL_FILE } from '../../chat/utils/chatFileUpload';

export {
  contentLineFromInfo,
  contentLineOf,
  describeAttachment,
  isStoredStub
} from './attachmentDescription';

/**
 * What an attachment of the composer is made of, and how to take it out again.
 *
 * A document attachment holds up to three things: the **original file** the user picked or the
 * integration handed over, the **text extracted** from it in the browser (what the assistant
 * reads), and — for a scan without a text layer — **page images** rendered from the first pages.
 * An image attachment holds the image **as it is sent to the model** (resized), an audio
 * attachment the audio itself.
 *
 * A document the server fetched itself (an iFinder document opened from a link) is a **stub** in
 * the composer: the browser never held its bytes. It carries the id of the stored file and the
 * chat's id, what the server read from it (`textBytes`, `pageImageCount`) and whether it kept the
 * original (`hasOriginal`); its downloads come from the chat's file endpoints.
 *
 * @module features/upload/utils/attachmentContent
 */

const isBlob = value => typeof Blob !== 'undefined' && value instanceof Blob;

/** Turn a base64 data URL into a Blob; `null` when it is not one. */
function dataUrlToBlob(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(0, comma);
  if (comma < 0 || !/^data:.*;base64$/i.test(header)) return null;
  try {
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.codePointAt(i);
    return new Blob([bytes], { type: header.slice('data:'.length).split(';')[0] });
  } catch {
    return null;
  }
}

/** The file name without its last extension. */
const stem = name => String(name || 'document').replace(/\.[^./\\]+$/, '') || 'document';

/**
 * The file the attachment came from, for a download.
 *
 * - `original`: the unchanged file (a document, or whatever the source handed over);
 * - `sent`: an image as the model gets it (resized), when the original is not at hand.
 *
 * @param {Object} entry - a composer attachment
 * @returns {{blob: Blob, name: string, kind: 'original'|'sent'}|null}
 */
export function downloadableFile(entry) {
  if (!entry || entry.loading) return null;
  const name = entry.fileName || 'file';
  const original = entry[ORIGINAL_FILE];
  if (isBlob(original)) return { blob: original, name, kind: 'original' };
  if (entry.type === 'audio' || entry.type === 'image') {
    const blob = dataUrlToBlob(entry.base64);
    if (blob) return { blob, name, kind: entry.type === 'image' ? 'sent' : 'original' };
  }
  return null;
}

/**
 * The extracted text of a document as a text file, for a download.
 *
 * @param {Object} entry
 * @returns {{blob: Blob, name: string}|null}
 */
export function downloadableText(entry) {
  if (entry?.type !== 'document' || entry.loading) return null;
  const text = typeof entry.content === 'string' ? entry.content : '';
  if (!text.trim()) return null;
  return {
    blob: new Blob([text], { type: 'text/plain;charset=utf-8' }),
    name: `${stem(entry.fileName)}.txt`
  };
}

/** Whether the original file (or the image as sent) can be downloaded from this chip. */
export function canDownloadFile(entry) {
  if (!entry || entry.loading) return false;
  if (downloadableFile(entry)) return true;
  return isStoredStub(entry) && entry.hasOriginal !== false;
}

/** Whether the extracted text can be downloaded from this chip. */
export function canDownloadText(entry) {
  if (!entry || entry.loading) return false;
  if (downloadableText(entry)) return true;
  // A scan (page images) has no text to download
  return isStoredStub(entry) && (entry.pageImageCount ?? 0) === 0 && (entry.textBytes ?? 1) > 0;
}

/**
 * Save the original file (or the image as sent) of an attachment: from the composer's own copy, or
 * from the server for a stub. Rejects when the server no longer has it (`ORIGINAL_DISCARDED`).
 *
 * @returns {Promise<boolean>} `true` when the download was triggered.
 */
export async function saveAttachmentFile(entry) {
  const file = downloadableFile(entry);
  if (file) return saveBlobAs(file.blob, file.name);
  if (!isStoredStub(entry)) return false;
  // Loaded when needed: most chips never download from the server
  const { fetchChatFileBlob } = await import('../../../api/endpoints/chats');
  const blob = await fetchChatFileBlob(entry.chatId, entry.fileId);
  return saveBlobAs(blob, entry.fileName || 'document');
}

/**
 * Save the extracted text of a document as `<name>.txt`: the composer's own text, or the text the
 * server read for a stub.
 *
 * @returns {Promise<boolean>} `true` when the download was triggered.
 */
export async function saveAttachmentText(entry) {
  const own = downloadableText(entry);
  if (own) return saveBlobAs(own.blob, own.name);
  if (!isStoredStub(entry)) return false;
  const { fetchChatFileText } = await import('../../../api/endpoints/chats');
  const result = await fetchChatFileText(entry.chatId, entry.fileId);
  const text = typeof result?.text === 'string' ? result.text : '';
  if (!text) return false;
  return saveBlobAs(
    new Blob([text], { type: 'text/plain;charset=utf-8' }),
    `${stem(entry.fileName)}.txt`
  );
}
