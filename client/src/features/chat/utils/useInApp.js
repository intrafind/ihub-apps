// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * "Use in app…": take a file that exists on the server — a generated file
 * (artifact) of a chat, or a document of a project — into a new chat of
 * another app, as an attachment of its composer.
 *
 * Nothing travels through the browser. The new chat asks the server to copy
 * the file into its own file store (`POST /api/chats/{chatId}/files` with
 * `{ appId, source: { kind, ref } }`), so the copy outlives the chat or the
 * project it came from.
 *
 * This module holds the rules only (which apps to offer, what to send); the
 * picker (`UseInAppDialog`), the hand-over (`openAppWithAttachment`) and the
 * receiving chat (`useSourceFileAttachment`) use them.
 *
 * @module features/chat/utils/useInApp
 */

import { appUploadAccepts } from '../../upload/utils/uploadFormats';
import {
  appRecognizesImages,
  isRecognizableImage,
  textRecognitionAvailable
} from '../../upload/utils/textRecognition';

/** Source kind of a generated file of a chat (server: `chatFiles/fileSources.js`). */
export const CHAT_ARTIFACT_SOURCE = 'chat-artifact';

/** Source kind of a document of a project. */
export const PROJECT_ITEM_SOURCE = 'project-item';

/** Item states whose document can be handed on (a stale item keeps its last text). */
const USABLE_ITEM_STATUSES = new Set(['ready', 'stale']);

/**
 * @typedef {Object} SourceAttachment
 * @property {{kind: string, ref: Object}} source - What the server copies.
 * @property {string} name - The file name the composer shows until the server answers.
 * @property {string} mimeType - What the app picker filters by.
 * @property {number} [bytes]
 */

/** Types a ZIP archive is reported as. */
const ARCHIVE_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/x-zip',
  'multipart/x-zip'
]);

/**
 * Whether a generated file may be offered to "Use in app": a stored file (an
 * id the server knows) that the chat file store takes. It takes the document
 * types of a normal chat upload and refuses ZIP archives and pictures
 * (`400 UNSUPPORTED_TYPE`), so those are not offered at all. (A ZIP *can* be
 * copied into a project, which unpacks it.) A PNG, JPEG, GIF or WebP picture is
 * offered while a text recognition model is set (#3986): the picker then lists
 * the apps whose chats recognize the text of images (`appsAcceptingFile`).
 *
 * @param {{id?: string, kind?: string, mimeType?: string, name?: string}|null|undefined} artifact
 * @param {{textRecognition?: boolean}} [options] - `textRecognition`: a text recognition model
 *   is set (`platformConfig.uploads.textRecognition.available`).
 * @returns {boolean}
 */
export function canUseArtifactInApp(artifact, { textRecognition = false } = {}) {
  if (!artifact?.id) return false;
  const type = String(artifact.mimeType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (artifact.kind === 'image' || type.startsWith('image/')) {
    return textRecognition === true && isRecognizableImage(type, artifact.name);
  }
  if (ARCHIVE_TYPES.has(type)) return false;
  return !/\.zip$/i.test(String(artifact.name || ''));
}

/**
 * The `ref` of a generated file for the `chat-artifact` source: by its chat
 * (`{ chatId, artifactId }` — own chat, a project member's, an admin's) or by the
 * share it was opened through (`{ shareId, artifactId }` — a chat or a file
 * shared with the viewer).
 *
 * @param {{chatId?: string, shareId?: string}} owner - Where the artifact lives.
 * @param {string} artifactId
 * @returns {{chatId: string, artifactId: string}|{shareId: string, artifactId: string}|null}
 */
export function artifactRef(owner, artifactId) {
  if (!artifactId) return null;
  if (owner?.shareId) return { shareId: owner.shareId, artifactId };
  if (owner?.chatId) return { chatId: owner.chatId, artifactId };
  return null;
}

/**
 * The attachment of a stored generated file.
 *
 * @param {{chatId?: string, shareId?: string}} owner - Where the artifact lives
 *   (see {@link artifactRef}).
 * @param {{id: string, name?: string, mimeType?: string, bytes?: number}} artifact - A stored
 *   artifact (not a live one: it has no id the server knows).
 * @param {string} [displayName] - The name the chat shows for it.
 * @returns {SourceAttachment|null} `null` without an owner or an artifact id.
 */
export function artifactAttachment(owner, artifact, displayName) {
  const ref = artifactRef(owner, artifact?.id);
  if (!ref) return null;
  return {
    source: { kind: CHAT_ARTIFACT_SOURCE, ref },
    name: displayName || artifact.name || artifact.id,
    mimeType: artifact.mimeType || '',
    ...(Number.isFinite(artifact.bytes) ? { bytes: artifact.bytes } : {})
  };
}

/**
 * The attachment of a project document. The server copies the original file
 * when the project kept one, otherwise the text as a Markdown file — which is
 * what the picker has to filter by.
 *
 * @param {string} projectId
 * @param {{id: string, name?: string, hasOriginal?: boolean,
 *   original?: {name?: string, contentType?: string, size?: number},
 *   text?: {bytes?: number}}} item
 * @returns {SourceAttachment|null}
 */
export function projectItemAttachment(projectId, item) {
  if (!projectId || !item?.id) return null;
  const source = { kind: PROJECT_ITEM_SOURCE, ref: { projectId, itemId: item.id } };
  if (item.hasOriginal === true && item.original?.contentType) {
    return {
      source,
      name: item.original.name || item.name || item.id,
      mimeType: item.original.contentType,
      ...(Number.isFinite(item.original.size) ? { bytes: item.original.size } : {})
    };
  }
  const base = String(item.name || item.id).replace(/\.md$/i, '');
  return {
    source,
    name: `${base}.md`,
    mimeType: 'text/markdown',
    ...(Number.isFinite(item.text?.bytes) ? { bytes: item.text.bytes } : {})
  };
}

/**
 * Whether a project document may be offered to "Use in app": a stored document
 * (not a link) whose text is there (ready, or stale with its last snapshot) and
 * that is not marked
 * "Not for AI" — the server refuses those (`SOURCE_FORBIDDEN`), so they are
 * not offered at all.
 *
 * @param {{status?: string, excludedFromAi?: boolean}|null|undefined} item
 * @returns {boolean}
 */
export function canUseProjectItemInApp(item) {
  return (
    Boolean(item) &&
    // A link (an iHub page, an iFinder document, a document of another project)
    // has no stored file to hand over; the server refuses it.
    item.storage === 'text' &&
    USABLE_ITEM_STATUSES.has(item.status) &&
    item.excludedFromAi !== true
  );
}

/**
 * Whether an app can open a chat for the user at all: switched on, a chat app
 * (not an iframe or a redirect), and — for a personal app — one the user may
 * use now (the reduced view of an app they may only see carries no upload
 * settings anyway).
 *
 * @param {Object|null|undefined} app - As `useApps()` lists it.
 * @returns {boolean}
 */
export function isChatApp(app) {
  if (!app?.id || app.enabled === false) return false;
  if (app.type && app.type !== 'chat') return false;
  if (app.ownership === 'user') {
    if (app.state === 'retired' || app.disabled) return false;
    if (app.permissions && app.permissions.canUse === false) return false;
  }
  return true;
}

/**
 * The apps a file can be used in: chat apps the user can use whose uploads
 * take the file's type (see `appUploadAccepts`).
 *
 * A PNG, JPEG, GIF or WebP picture reaches the chat as the text the server
 * recognizes in it (#3986), never as a picture, so for one the apps are those
 * whose chats recognize text and whose uploads are on
 * (`appRecognizesImages`) — whatever their image upload and their models'
 * vision say. Without a text recognition model no app takes a picture.
 *
 * @param {Array<Object>} apps
 * @param {{mimeType?: string, name?: string}} file
 * @param {{uploads?: Object|null}} [options] - `uploads`: `platformConfig.uploads`, which says
 *   whether text recognition is available and for which chats.
 * @returns {Array<Object>} In the order given.
 *
 * @example
 * appsAcceptingFile(apps, { mimeType: 'text/markdown', name: 'notes.md' });
 * appsAcceptingFile(apps, { mimeType: 'image/png' }, { uploads: platformConfig.uploads });
 */
export function appsAcceptingFile(apps, file, { uploads = null } = {}) {
  const list = Array.isArray(apps) ? apps : [];
  if (isRecognizableImage(file?.mimeType, file?.name)) {
    if (!textRecognitionAvailable(uploads)) return [];
    return list.filter(app => isChatApp(app) && appRecognizesImages(app, uploads));
  }
  return list.filter(app => isChatApp(app) && appUploadAccepts(app, file));
}
