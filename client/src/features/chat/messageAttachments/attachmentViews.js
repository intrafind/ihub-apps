// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { describeAttachment } from '../../upload/utils/attachmentDescription';

/**
 * What a sent message shows of its attachments, as plain data.
 *
 * A message's `content` is exactly the text the user typed. The files that went
 * with it are `message.attachments`: a list of these views, derived once where a
 * message enters the chat (a turn sent in this session, a turn read back from
 * the store, a shared snapshot) so that all three look the same. Nothing here
 * is HTML and nothing here is translated; the card says it in words.
 *
 * @module features/chat/messageAttachments/attachmentViews
 */

/**
 * @typedef {Object} AttachmentView
 * @property {string} key - React key: position and file id (else name). The position is part of it
 *   because the same stored file can be attached twice (the server keeps one copy of identical
 *   files), and two cards must never share a key.
 * @property {string|null} id - Chat-file id: what the Files drawer opens. `null`: the
 *   server holds nothing to open (an image or audio file, a file only sent inline).
 * @property {'image'|'audio'|'document'} kind
 * @property {string} name - Plain text; `''` when unknown (the card supplies a fallback).
 * @property {string|null} mimeType
 * @property {number|null} bytes - The size when it was sent. Not the file's size once only
 *   its text is kept: see `originalKept`.
 * @property {boolean|null} originalKept - `false`: only the extracted text is kept (so `bytes`
 *   is no file size); `null`: not known or not applicable (a local file the server never held).
 * @property {Object|null} read - What the assistant got (`describeAttachment`): numbers, only
 *   for a turn sent in this session.
 * @property {string|null} previewSrc - A thumbnail: only an image sent in this session.
 * @property {boolean} unsaved - The file was sent with the message but could not be saved to
 *   the chat (quota, unsupported type); it has no id.
 * @property {boolean|null} shared - A shared chat's viewer: may they open it (`null`: not a share).
 * @property {'live'|'stored'} source
 */

/** Image data URLs a thumbnail may use. Never SVG, never a remote URL. */
const SAFE_PREVIEW = /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/=]+$/;

/** @param {unknown} value */
const asList = value => (Array.isArray(value) ? value : value ? [value] : []);

/** @param {unknown} value */
const finiteOrNull = value => {
  const number = Number(value);
  return Number.isFinite(number) && value !== null && value !== '' ? number : null;
};

/**
 * The kind of a stored descriptor: its media type, or (older descriptors) the upload kind
 * recorded as the type.
 *
 * @param {unknown} rawType
 * @returns {'image'|'audio'|'document'}
 */
function storedKindOf(rawType) {
  if (rawType === 'image' || rawType === 'audio') return rawType;
  if (typeof rawType === 'string') {
    if (rawType.startsWith('image/')) return 'image';
    if (rawType.startsWith('audio/')) return 'audio';
  }
  return 'document';
}

/**
 * One file as the composer held it when the message was sent.
 *
 * @param {Object} entry - `{ type, fileName, fileSize, fileType, base64, fileId, serverStored, ... }`
 * @param {number} index
 * @returns {AttachmentView}
 */
function fromLive(entry, index) {
  const storedOnServer =
    entry.serverStored === true && typeof entry.fileId === 'string' && Boolean(entry.fileId);
  const name = typeof entry.fileName === 'string' ? entry.fileName : '';
  const mimeType = typeof entry.fileType === 'string' && entry.fileType ? entry.fileType : null;
  // The composer's own type decides, as it does for the payload
  const kind = entry.type === 'image' || entry.type === 'audio' ? entry.type : 'document';
  const previewSrc =
    kind === 'image' && typeof entry.base64 === 'string' && SAFE_PREVIEW.test(entry.base64)
      ? entry.base64
      : null;
  const id = storedOnServer ? entry.fileId : null;
  return {
    key: `${index}:${id || name}`,
    id,
    kind,
    name,
    mimeType,
    bytes: finiteOrNull(entry.fileSize ?? entry.bytes),
    originalKept:
      storedOnServer && typeof entry.hasOriginal === 'boolean' ? entry.hasOriginal : null,
    read: describeAttachment(entry),
    previewSrc,
    unsaved: entry.uploadState === 'error',
    shared: null,
    source: 'live'
  };
}

/**
 * One descriptor as the store keeps it on a user message
 * (`{ id?, type: mime, name, bytes, hasOriginal?, canUseAsTemplate?, shared? }`).
 * The field spellings are the ones the server reads (`chatMaterializer.normalizeAttachments`).
 *
 * @param {Object} descriptor
 * @param {number} index
 * @returns {AttachmentView}
 */
function fromStored(descriptor, index) {
  const id = descriptor.id || descriptor.fileId;
  const fileId = typeof id === 'string' && id ? id : null;
  const name = String(descriptor.name || descriptor.fileName || '');
  const rawType = descriptor.fileType || descriptor.mimeType || descriptor.type;
  const mimeType = typeof rawType === 'string' && rawType.includes('/') ? rawType : null;
  const kind = storedKindOf(rawType);
  return {
    key: `${index}:${fileId || name}`,
    id: fileId,
    kind,
    name,
    mimeType,
    bytes: finiteOrNull(descriptor.bytes ?? descriptor.size ?? descriptor.fileSize),
    originalKept: typeof descriptor.hasOriginal === 'boolean' ? descriptor.hasOriginal : null,
    read: null,
    previewSrc: null,
    unsaved: false,
    shared: typeof descriptor.shared === 'boolean' ? descriptor.shared : null,
    source: 'stored'
  };
}

/**
 * The views of a message's attachments. Documents come first, then images, then
 * audio, which is the order the server stores them in, so a turn looks the same
 * before and after a reload.
 *
 * @param {Object} sources
 * @param {{ fileData?: unknown, imageData?: unknown, audioData?: unknown }} [sources.live] - the
 *   payload of a turn sent in this session
 * @param {Object[]} [sources.stored] - the descriptors of a stored message
 * @returns {AttachmentView[]}
 */
export function toAttachmentViews({ live, stored } = {}) {
  if (Array.isArray(stored)) {
    return stored
      .filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry))
      .map((entry, index) => fromStored(entry, index));
  }
  if (!live) return [];
  return [...asList(live.fileData), ...asList(live.imageData), ...asList(live.audioData)]
    .filter(entry => entry && typeof entry === 'object')
    .map((entry, index) => fromLive(entry, index));
}

/**
 * The ids of the stored files a message names, for the Files drawer.
 *
 * @param {{ attachments?: AttachmentView[] }} message
 * @returns {string[]}
 */
export function attachmentIdsOf(message) {
  const ids = [];
  for (const view of Array.isArray(message?.attachments) ? message.attachments : []) {
    const id = view?.id || view?.fileId;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}
