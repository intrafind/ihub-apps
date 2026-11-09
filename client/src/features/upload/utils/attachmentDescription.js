// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the assistant gets from an attachment, in numbers and in words.
 *
 * Kept free of every download, file-API and browser dependency so that anything which only
 * needs to *say* what a file gave the assistant (the composer chip, the attachment card on a sent
 * message) can import it without loading the rest of the upload code.
 *
 * A document attachment holds up to three things: the **original file**, the **text extracted**
 * from it (what the assistant reads), and for a scan without a text layer **page images**. An
 * image attachment holds the image **as it is sent to the model** (resized), an audio attachment
 * the audio itself. A document the server fetched itself is a **stub** in the composer: the
 * browser never held its bytes; it carries the stored file's id and chat id, what the server read
 * from it (`textBytes`, `pageImageCount`) and whether it kept the original (`hasOriginal`).
 *
 * @module features/upload/utils/attachmentDescription
 */

/**
 * Format file size to human-readable string
 */
export function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Whether an attachment is a file the server holds and the browser never did. */
export const isStoredStub = entry =>
  entry?.serverStored === true &&
  typeof entry.fileId === 'string' &&
  Boolean(entry.fileId) &&
  typeof entry.chatId === 'string' &&
  Boolean(entry.chatId) &&
  typeof entry.content !== 'string';

/** What the server read from a stored file: its numbers, not the browser's. */
function describeStub(entry) {
  const pageImages = entry.pageImageCount ?? 0;
  return {
    kind: 'document',
    stub: true,
    // The server's `textBytes` counts the page images of a scan too: a scan has no text to size
    textBytes: pageImages > 0 ? 0 : (entry.textBytes ?? 0),
    pageImages,
    truncated: entry.truncated === true,
    originalKept: entry.hasOriginal === true
  };
}

/** What the browser read from a document it holds. */
function describeBrowserDocument(entry) {
  return {
    kind: 'document',
    characters: typeof entry.content === 'string' ? entry.content.trim().length : 0,
    pageImages: Array.isArray(entry.pageImages) ? entry.pageImages.length : 0,
    // Only known once the server stored the file
    truncated: entry.truncated === true,
    originalKept: entry.serverStored === true ? entry.hasOriginal === true : null
  };
}

/**
 * What the assistant gets from an attachment, in numbers the UI can say in words.
 *
 * @param {Object} entry
 * @returns {{kind: 'document'|'image'|'audio', characters?: number, textBytes?: number, stub?: boolean,
 *   pageImages?: number, truncated?: boolean, originalKept?: boolean|null, width?: number,
 *   height?: number}|null}
 */
export function describeAttachment(entry) {
  if (!entry || entry.loading) return null;
  switch (entry.type) {
    case 'document':
      return isStoredStub(entry) ? describeStub(entry) : describeBrowserDocument(entry);
    case 'image':
      return {
        kind: 'image',
        ...(entry.width && entry.height ? { width: entry.width, height: entry.height } : {})
      };
    case 'audio':
      return { kind: 'audio' };
    default:
      return null;
  }
}

/** The parts of the sentence a document's chip says, in the order they are said. */
function documentContentParts(info, t) {
  const parts = [];
  if (info.stub && info.textBytes > 0) {
    parts.push(
      t('attachedFiles.content.textServer', 'Text extracted on the server: {{size}}', {
        size: formatFileSize(info.textBytes)
      })
    );
  }
  if (info.characters > 0) {
    parts.push(
      t('attachedFiles.content.text', 'Text extracted: {{count}} characters', {
        count: info.characters.toLocaleString()
      })
    );
  }
  if (info.pageImages > 0) {
    parts.push(
      t(
        'attachedFiles.content.pageImages',
        'scan without text: {{count}} page image(s) sent instead',
        { count: info.pageImages }
      )
    );
  }
  if (info.truncated) parts.push(t('attachedFiles.content.truncated', 'shortened to fit'));
  if (info.originalKept === false) {
    parts.push(t('attachedFiles.content.textOnly', 'only the text is kept in this chat'));
  }
  if (parts.length === 0) {
    parts.push(t('attachedFiles.content.noText', 'No text could be read from this file'));
  }
  return parts;
}

/**
 * What the assistant gets from an attachment, as the sentence the chip and the
 * message's attachment card say, from the numbers `describeAttachment` returns.
 * The numbers are plain data, so a message can keep them and say them again in
 * whatever language the page is in then.
 *
 * @param {ReturnType<typeof describeAttachment>} info
 * @param {Function} t - the translation function
 * @returns {string|null}
 */
export function contentLineFromInfo(info, t) {
  if (!info) return null;
  if (info.kind === 'document') return documentContentParts(info, t).join(' · ');
  if (info.kind === 'image') {
    return info.width
      ? t('attachedFiles.content.imageSized', 'Image sent to the model as {{width}}×{{height}}', {
          width: info.width,
          height: info.height
        })
      : t('attachedFiles.content.image', 'Image sent to the model');
  }
  return t('attachedFiles.content.audio', 'Audio sent to the model');
}

/**
 * What the assistant gets from an attachment, as the line the chip shows.
 *
 * @param {Object} entry - a composer attachment
 * @param {Function} t - the translation function
 * @returns {string|null}
 */
export function contentLineOf(entry, t) {
  return contentLineFromInfo(describeAttachment(entry), t);
}
