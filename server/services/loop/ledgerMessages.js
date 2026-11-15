// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The copy of a request's messages that goes into the run ledger
 * (`request/header.messages` / `messagesDelta`).
 *
 * Uploads are stored once as chat files; copying them into every header made
 * the ledger an order of magnitude larger than the chats it records. Here what
 * is stored as a chat file is recorded as a reference to it:
 *
 * - an uploaded document's rendered text becomes a self-closing
 *   `<content … id="<chat file id>" text_sha256="…" chars="…"/>` tag;
 * - a picture or a scanned page that carries its chat file's `fileId` becomes
 *   `{ fileId, page?, fileType, sha256, bytes }`, hashed over the decoded bytes.
 *
 * Content with no chat file behind it — audio, pictures sent through the
 * inference API, pages rendered in a workflow, a file the store refused — stays
 * in full: the ledger is its only record. `fileData` is left out; no adapter
 * sends it to a provider, and its text is already rendered into `content`.
 *
 * `messagesHash` is computed over the real messages, never over this copy.
 *
 * @module services/loop/ledgerMessages
 */
import crypto from 'node:crypto';
import { documentBlock, documentReference, normalizeFiles } from '../../../shared/promptContext.js';

const DATA_URL_PREFIX = /^data:[^,]*;base64,/;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** A stored picture or page `{ base64, fileId, … }` → `{ fileId, …, sha256, bytes }`; others unchanged. */
function imageRef(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.base64 !== 'string' || !entry.fileId) {
    return entry;
  }
  const { base64, ...meta } = entry;
  const bytes = Buffer.from(base64.replace(DATA_URL_PREFIX, ''), 'base64');
  return { ...meta, sha256: sha256(bytes), bytes: bytes.length };
}

/** Replace each stored document's rendered block in `content` with a reference tag. */
function referenceDocuments(content, files) {
  let out = content;
  for (const file of files) {
    if (file.chatFile !== true) continue; // no chat file to point to: keep the text
    const block = documentBlock(file);
    if (!block || !out.includes(block)) continue; // not rendered as-is: keep the text
    const ref = documentReference(file, [
      `text_sha256="${sha256(file.content)}"`,
      `chars="${file.content.length}"`
    ]);
    out = out.replace(block, () => ref);
  }
  return out;
}

function ledgerMessage(msg) {
  if (!msg || typeof msg !== 'object') return msg;
  if (msg.fileData === undefined && msg.imageData === undefined) return msg;
  const { fileData, ...out } = msg;
  if (typeof out.content === 'string') {
    out.content = referenceDocuments(out.content, normalizeFiles(fileData));
  }
  if (Array.isArray(out.imageData)) out.imageData = out.imageData.map(imageRef);
  else if (out.imageData !== undefined) out.imageData = imageRef(out.imageData);
  return out;
}

/**
 * @param {Array|undefined} messages - Model-visible messages (pre-adapter)
 * @returns {Array|undefined} The ledger copy; the input is not modified.
 */
export function ledgerMessages(messages) {
  return Array.isArray(messages) ? messages.map(ledgerMessage) : messages;
}
