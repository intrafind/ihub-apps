// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Pre-upload of the composer's documents to the chat's file store
 * (`POST /api/chats/:chatId/files`).
 *
 * The composer extracts text in the browser as it always did, so the attached
 * file can be shown and sent inline at once. When the server keeps chat files,
 * the same file is also uploaded in the background; the message then names it by
 * id (`fileIds`) instead of carrying its text and bytes, and the server hydrates
 * it on this and every later turn, after a reload and on another device.
 *
 * Storage modes (`platform.uploads.storageMode`, per app `app.uploads.storageMode`):
 * - `original_and_text` / `server_text_only`: the original file is uploaded and the
 *   server extracts; the mode decides whether the original is kept.
 * - `client_text_only`: only the text the browser extracted is uploaded
 *   (`{ name, mimeType, text }`), no original ever crosses the network.
 *
 * @module features/chat/utils/chatFileUpload
 */

/**
 * Where the composer keeps the `File` a document entry was extracted from.
 *
 * A symbol key, so the entry still serializes (JSON ignores it) and is still
 * carried along by object spread, which is how the composer's state is copied.
 */
export const ORIGINAL_FILE = Symbol.for('ihub.originalFile');

export const STORAGE_MODES = ['original_and_text', 'server_text_only', 'client_text_only'];

/**
 * The storage mode in force for an app.
 *
 * @param {Object} [uploads] - `platformConfig.uploads` (`uploadsClientConfig` of the server).
 * @param {Object} [app] - App config; `app.uploads.storageMode` overrides the platform.
 * @returns {'original_and_text'|'server_text_only'|'client_text_only'}
 */
export function resolveUploadMode(uploads, app) {
  const mode = app?.uploads?.storageMode || uploads?.storageMode;
  return STORAGE_MODES.includes(mode) ? mode : 'original_and_text';
}

/**
 * Whether the composer may pre-upload files: the server keeps chat files and
 * the chat exists to put them in.
 *
 * @param {Object} params
 * @param {Object} [params.uploads] - `platformConfig.uploads`.
 * @param {string|null} [params.chatId]
 * @returns {boolean}
 */
export function preUploadAvailable({ uploads, chatId }) {
  return Boolean(chatId) && uploads?.enabled === true;
}

/**
 * Identity of a composer entry while it is being uploaded. The entries are
 * copied as state changes, so an object identity does not survive.
 *
 * @param {Object} entry
 * @returns {string}
 */
export function entryKey(entry) {
  const text = typeof entry?.content === 'string' ? entry.content.length : 0;
  return [entry?.fileName || '', entry?.fileSize ?? '', text].join('\u0000');
}

/**
 * Whether an entry still has to be uploaded.
 *
 * @param {Object} entry
 * @returns {boolean}
 */
export function needsPreUpload(entry) {
  return (
    entry?.type === 'document' &&
    !entry.loading &&
    !entry.fileId &&
    entry.uploadState !== 'error' &&
    entry.uploadState !== 'uploading'
  );
}

/**
 * What to send to the file endpoint for an entry: the original file (the server
 * extracts), or the extracted text when the mode keeps no original on the wire
 * or the original is not at hand.
 *
 * @param {Object} entry - A composer document entry.
 * @param {'original_and_text'|'server_text_only'|'client_text_only'} mode
 * @returns {File|Blob|Object|null} `null` when there is nothing to upload.
 */
export function buildUploadPayload(entry, mode) {
  const original = entry?.[ORIGINAL_FILE];
  const hasOriginal = typeof Blob !== 'undefined' && original instanceof Blob;
  if (mode !== 'client_text_only' && hasOriginal) return original;

  const text = typeof entry?.content === 'string' ? entry.content : '';
  const pageImages = Array.isArray(entry?.pageImages)
    ? entry.pageImages
        .map(image => (typeof image === 'string' ? image : image?.base64 || image?.data))
        .filter(Boolean)
    : [];
  if (!text && pageImages.length === 0) return null;
  return {
    name: entry.fileName || 'document.txt',
    mimeType: entry.fileType || 'text/plain',
    ...(text ? { text } : {}),
    ...(pageImages.length > 0 ? { pageImages } : {}),
    ...(entry.displayType ? { formatLabel: entry.displayType } : {})
  };
}

/**
 * The entry after the server stored it: it now has an id, and keeps what the
 * composer needs to show it.
 *
 * @param {Object} entry
 * @param {Object} descriptor - `{ id, hasOriginal, canUseAsTemplate, bytes, pages, … }`.
 * @returns {Object}
 */
export function withStoredFile(entry, descriptor) {
  return {
    ...entry,
    fileId: descriptor.id,
    serverStored: true,
    hasOriginal: descriptor.hasOriginal === true,
    canUseAsTemplate: descriptor.canUseAsTemplate === true,
    ...(Number.isFinite(descriptor.pages) ? { pages: descriptor.pages } : {}),
    // The server shortened the text it keeps (the chip says so)
    ...(descriptor.truncated === true ? { truncated: true } : {}),
    // What the server read from the file, for the chip of a file the browser never held
    ...(Number.isFinite(descriptor.textBytes) ? { textBytes: descriptor.textBytes } : {}),
    ...(Number.isFinite(descriptor.pageImageCount)
      ? { pageImageCount: descriptor.pageImageCount }
      : {}),
    uploadState: 'done',
    uploadProgress: 100,
    uploadError: undefined
  };
}

/**
 * Replace the entries of a selection that match `key` with `update(entry)`.
 *
 * @param {Object|Object[]|null} selection - The composer's `selectedFile` (one entry, a list or null).
 * @param {string} key - {@link entryKey}
 * @param {(entry: Object) => Object} update
 * @returns {Object|Object[]|null} Same shape as the input.
 */
export function updateSelection(selection, key, update) {
  if (!selection) return selection;
  if (Array.isArray(selection)) {
    return selection.map(entry => (entryKey(entry) === key ? update(entry) : entry));
  }
  return entryKey(selection) === key ? update(selection) : selection;
}

/**
 * Split the documents of a message into what goes on the wire: the ids of the
 * files the server already has, and the inline `fileData` of those it does not.
 *
 * @param {Object|Object[]|null|undefined} fileData
 * @returns {{ fileData: Object|Object[]|null, fileIds: string[] }}
 */
export function splitFilesForWire(fileData) {
  const entries = fileData ? [fileData].flat().filter(Boolean) : [];
  const fileIds = [];
  const inline = [];
  for (const entry of entries) {
    if (entry.serverStored && typeof entry.fileId === 'string' && entry.fileId) {
      if (!fileIds.includes(entry.fileId)) fileIds.push(entry.fileId);
    } else {
      inline.push(entry);
    }
  }
  return {
    fileData: inline.length === 0 ? null : inline.length === 1 ? inline[0] : inline,
    fileIds
  };
}

/**
 * The short, user-facing reason an upload was refused, from the server's
 * error body (`code` of `413 QUOTA_*`, `UNSUPPORTED_TYPE`, …).
 *
 * @param {unknown} error
 * @returns {string} A code; `'FAILED'` when the server named none.
 */
export function uploadErrorCode(error) {
  // The file API wraps axios errors (`handleApiResponse`): the response then sits
  // on `originalError`.
  const data = error?.response?.data || error?.originalError?.response?.data;
  return (data?.code || error?.code || 'FAILED').toString();
}
