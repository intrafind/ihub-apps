// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { saveBlobAs } from '../../../utils/externalNavigation';
import { ORIGINAL_FILE } from '../../chat/utils/chatFileUpload';

/**
 * What an attachment of the composer is made of, and how to take it out again.
 *
 * A document attachment holds up to three things: the **original file** the user picked or the
 * integration handed over, the **text extracted** from it in the browser (what the assistant
 * reads), and — for a scan without a text layer — **page images** rendered from the first pages.
 * An image attachment holds the image **as it is sent to the model** (resized), an audio
 * attachment the audio itself.
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
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
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

/**
 * What the assistant gets from an attachment, in numbers the UI can say in words.
 *
 * @param {Object} entry
 * @returns {{kind: 'document'|'image'|'audio', characters?: number, pageImages?: number,
 *   truncated?: boolean, originalKept?: boolean, width?: number, height?: number}|null}
 */
export function describeAttachment(entry) {
  if (!entry || entry.loading) return null;
  if (entry.type === 'document') {
    const characters = typeof entry.content === 'string' ? entry.content.trim().length : 0;
    const pageImages = Array.isArray(entry.pageImages) ? entry.pageImages.length : 0;
    return {
      kind: 'document',
      characters,
      pageImages,
      // Only known once the server stored the file
      truncated: entry.truncated === true,
      originalKept: entry.serverStored === true ? entry.hasOriginal === true : null
    };
  }
  if (entry.type === 'image') {
    return {
      kind: 'image',
      ...(entry.width && entry.height ? { width: entry.width, height: entry.height } : {})
    };
  }
  if (entry.type === 'audio') return { kind: 'audio' };
  return null;
}

/** Save the original file (or the image as sent) of an attachment; `false` when there is none. */
export function saveAttachmentFile(entry) {
  const file = downloadableFile(entry);
  return Boolean(file) && saveBlobAs(file.blob, file.name);
}

/** Save the extracted text of a document as `<name>.txt`; `false` when there is none. */
export function saveAttachmentText(entry) {
  const text = downloadableText(entry);
  return Boolean(text) && saveBlobAs(text.blob, text.name);
}
