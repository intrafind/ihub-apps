import { randomUUID } from 'node:crypto';

/**
 * Files a tool generated during a chat turn — a PDF from `create_pdf`, later
 * a DOCX, PPTX or XLSX.
 *
 * They take the path generated pictures already take, so there is no store or
 * download route of their own:
 *
 * 1. The tool holds the bytes here and returns only a descriptor, so the model
 *    never sees them.
 * 2. The chat tool seam streams the bytes to the client on the tool's
 *    `tool/completed` event, where the chat shows a download card.
 * 3. When the chat is stored, the materializer stores them with the answer as
 *    `document` artifacts of the chat, served by
 *    `GET /api/chats/:chatId/artifacts/:artifactId` and a share's artifact
 *    route, and deleted with the chat. A chat that is not stored keeps the
 *    file as long as the page does, like a generated picture.
 *
 * A file stays held for {@link HOLD_MS} so `preview_pdf` can render a page of
 * what `create_pdf` just made. In memory and per process, bounded in count
 * and size: a turn runs on one worker, and so do the previews it asks for.
 */

/** Largest file a tool may hand the user. */
export const MAX_GENERATED_FILE_BYTES = 25 * 1024 * 1024;

/** Media types a generated file may have, with the extension it gets. */
export const GENERATED_FILE_TYPES = Object.freeze({
  'application/pdf': 'pdf'
});

const HOLD_MS = 60 * 60 * 1000;
const MAX_HELD_FILES = 50;
const MAX_HELD_BYTES = 200 * 1024 * 1024;

/** Held files by id, oldest first (a `Map` keeps insertion order). */
const held = new Map();

export class GeneratedFileError extends Error {
  constructor(message, code = 'failed') {
    super(message);
    this.name = 'GeneratedFileError';
    this.code = code;
  }
}

/**
 * A download file name: no path, no control characters, the right extension.
 *
 * @param {unknown} name
 * @param {string} extension - Without the dot.
 * @returns {string}
 */
export function safeFileName(name, extension) {
  const base = String(typeof name === 'string' ? name : '')
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replaceAll(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replaceAll(/^[.\s]+|[.\s]+$/g, '');
  return `${base || 'document'}.${extension}`;
}

function ownerOf(user) {
  return typeof user?.id === 'string' && user.id ? user.id : 'anonymous';
}

/** Drop expired files, then the oldest until the bounds hold. */
function prune(now = Date.now()) {
  let total = 0;
  for (const [id, entry] of held) {
    if (entry.expires <= now) held.delete(id);
    else total += entry.data.length;
  }
  for (const [id, entry] of held) {
    if (held.size <= MAX_HELD_FILES && total <= MAX_HELD_BYTES) break;
    held.delete(id);
    total -= entry.data.length;
  }
}

/**
 * Hold a file a tool generated, for the chat to pick up.
 *
 * @param {Object} params
 * @param {Object} [params.user] - The user the file is for.
 * @param {string} [params.chatId] - The chat whose turn generated it.
 * @param {Buffer} params.data
 * @param {string} params.mimeType - A key of {@link GENERATED_FILE_TYPES}.
 * @param {string} [params.name] - Download name; the extension is added.
 * @param {Object} [params.meta] - Extra descriptor fields (`pages`).
 * @returns {{ id: string, name: string, mimeType: string, bytes: number, pages?: number }}
 */
export function holdGeneratedFile({ user, chatId, data, mimeType, name, meta = {} }) {
  const extension = GENERATED_FILE_TYPES[mimeType];
  if (!extension) throw new GeneratedFileError(`Unsupported file type: ${mimeType}`, 'invalid');
  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw new GeneratedFileError('The generated file is empty.', 'invalid');
  }
  if (data.length > MAX_GENERATED_FILE_BYTES) {
    throw new GeneratedFileError(
      `The generated file is larger than ${MAX_GENERATED_FILE_BYTES / 1024 / 1024} MB.`,
      'too-large'
    );
  }
  const descriptor = {
    id: randomUUID().replaceAll('-', ''),
    name: safeFileName(name, extension),
    mimeType,
    bytes: data.length,
    ...(Number.isInteger(meta.pages) && meta.pages > 0 ? { pages: meta.pages } : {})
  };
  held.set(descriptor.id, {
    owner: ownerOf(user),
    chatId: typeof chatId === 'string' && chatId ? chatId : null,
    data,
    descriptor,
    expires: Date.now() + HOLD_MS
  });
  prune();
  return descriptor;
}

function heldEntry(id, chatId) {
  const entry = held.get(String(id || ''));
  if (!entry || entry.expires <= Date.now()) return null;
  if (entry.chatId && chatId && entry.chatId !== chatId) return null;
  return entry;
}

/**
 * A held file, for its owner (`preview_pdf`).
 *
 * @param {Object} user
 * @param {string} id
 * @param {Object} [options]
 * @param {string} [options.chatId] - Only a file of this chat.
 * @returns {{ id: string, name: string, mimeType: string, bytes: number, pages?: number, data: Buffer } | null}
 */
export function heldGeneratedFile(user, id, { chatId } = {}) {
  const entry = heldEntry(id, chatId);
  if (!entry || entry.owner !== ownerOf(user)) return null;
  return { ...entry.descriptor, data: entry.data };
}

/**
 * The bytes of a held file, base64, for the chat tool seam: it found the id
 * in the result of a system skill tool this same turn ran.
 *
 * @param {string} id
 * @param {Object} [options]
 * @param {string} [options.chatId] - Only a file of this chat.
 * @returns {string|null}
 */
export function heldGeneratedFileData(id, { chatId } = {}) {
  const entry = heldEntry(id, chatId);
  return entry ? entry.data.toString('base64') : null;
}

/** Forget every held file (tests). */
export function clearHeldGeneratedFiles() {
  held.clear();
}
