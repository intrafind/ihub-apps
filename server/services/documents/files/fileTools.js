// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import logger from '../../../utils/logger.js';
import {
  TEXT_FILE_MEDIA_TYPES,
  ZIP_MEDIA_TYPE,
  generatedFileKind,
  textFileMediaType
} from '../../../../shared/generatedFiles.js';
import { parseStructured, toolFailure } from '../documentToolHelpers.js';
import {
  GeneratedFileError,
  MAX_GENERATED_FILE_BYTES,
  heldGeneratedFilesFor,
  holdGeneratedFile,
  safeArchivePath
} from '../generatedFiles.js';
import { artifactPolicy } from '../../artifacts/artifactPolicy.js';
import { getArtifactRepository } from '../../artifacts/ArtifactRepository.js';
import { ZipLimitError, planZipEntries, zipToBuffer } from '../../artifacts/artifactZip.js';

/**
 * The tools the `files` system skill brings (see `server/systemSkills/files`):
 * `create_file` hands the user a text file (source code, JSON, CSV, …), and
 * `create_zip` packs new files and files of this chat into one archive. Both
 * hand their result to the chat as a generated file, like `create_pdf`.
 */

/** Most new files one `create_zip` call may carry. */
export const MAX_ZIP_TOOL_FILES = 500;

/** Artifact kinds `includeAll` packs: what a tool wrote, not pictures or archives. */
const INCLUDE_ALL_KINDS = new Set(['document', 'code']);

/**
 * The media type a text file is recorded under: its extension decides, and a
 * declared type counts only when the extension does not tell.
 *
 * @param {string} name - Normalized path.
 * @param {unknown} declared
 * @returns {string}
 */
export function createFileMediaType(name, declared) {
  const byName = textFileMediaType(name);
  if (byName !== 'text/plain' || /\.(txt|log|env|bat|vue|svelte)$/i.test(name)) return byName;
  const type = typeof declared === 'string' ? declared.split(';')[0].trim().toLowerCase() : '';
  return TEXT_FILE_MEDIA_TYPES.includes(type) ? type : byName;
}

/**
 * `create_file`: hand the user one text file.
 *
 * @param {Object} params - Tool arguments plus the trusted context (`user`, `chatId`).
 * @returns {Promise<Object>}
 */
export async function runCreateFile(params) {
  try {
    const name = safeArchivePath(params.name);
    if (!name) {
      throw new GeneratedFileError('Give the file a name with an extension in "name".', 'invalid');
    }
    if (typeof params.content !== 'string' || params.content.length === 0) {
      throw new GeneratedFileError('Provide the file content in "content".', 'invalid');
    }
    const data = Buffer.from(params.content, 'utf8');
    const file = holdGeneratedFile({
      user: params.user,
      chatId: params.chatId,
      data,
      mimeType: createFileMediaType(name, params.mimeType),
      name
    });
    return {
      success: true,
      file,
      // Picked up by the chat tool seam, which streams the bytes to the
      // chat's download card. The result itself never carries them.
      files: [file],
      message: `Created the file "${file.name}". The user sees a download card for it in the chat — do not repeat its content or add a link.`
    };
  } catch (error) {
    return toolFailure(error, 'The file could not be created.');
  }
}

/** Lower-cased lookup key of a path. */
const keyOf = path => path.toLowerCase();

/**
 * The files of this chat `create_zip` can pack, newest per path: those still
 * held (this turn's included, before they are stored) and the stored
 * artifacts of the chat, when the chat is the caller's.
 *
 * @returns {Promise<Array<{ id: string, name: string, kind: string, bytes: number,
 *   createdAt?: string, load: () => Promise<Buffer|null> }>>}
 */
async function chatFiles({ user, chatId }) {
  const candidates = heldGeneratedFilesFor(user, { chatId }).map(file => ({
    id: file.id,
    name: file.name,
    kind: generatedFileKind(file.mimeType),
    bytes: file.bytes,
    createdAt: file.createdAt,
    load: async () => file.data
  }));
  if (typeof chatId === 'string' && chatId) {
    try {
      const [{ authorizeChat }, { getChatRepository }] = await Promise.all([
        import('../../chat/chatAccess.js'),
        import('../../chat/ChatRepository.js')
      ]);
      const chats = getChatRepository();
      // `write`: the archive becomes part of this chat, so only its owner
      // packs what it holds. A chat that is not stored has nothing stored.
      const access = await authorizeChat(chatId, user, { repository: chats, intent: 'write' });
      if (access.ok && access.chat) {
        const scope = chats.artifactScope(chatId);
        const repository = getArtifactRepository();
        for (const artifact of await repository.list(scope)) {
          candidates.push({
            id: artifact.id,
            name: artifact.name || '',
            kind: artifact.kind,
            bytes: artifact.bytes,
            createdAt: artifact.createdAt,
            load: async () => (await repository.get(scope, artifact.id))?.data || null
          });
        }
      }
    } catch (error) {
      logger.warn('create_zip could not list the chat artifacts', {
        component: 'FileTools',
        chatId,
        error: error.message
      });
    }
  }
  // Newest first, so the first one seen of a path is the one kept.
  candidates.sort((a, b) => ((a.createdAt || '') < (b.createdAt || '') ? 1 : -1));
  return candidates;
}

/**
 * Pick the existing files `create_zip` was asked for.
 *
 * @param {Array<Object>} candidates - From {@link chatFiles}, newest first.
 * @param {string[]} include - Names or ids.
 * @param {boolean} includeAll
 * @returns {Array<Object>}
 */
export function selectChatFiles(candidates, include, includeAll) {
  const byPath = new Map();
  for (const candidate of candidates) {
    const path = safeArchivePath(candidate.name);
    if (path && !byPath.has(keyOf(path))) byPath.set(keyOf(path), { ...candidate, name: path });
  }
  const selected = new Map();
  if (includeAll) {
    for (const [key, candidate] of byPath) {
      if (INCLUDE_ALL_KINDS.has(candidate.kind)) selected.set(key, candidate);
    }
  }
  const missing = [];
  for (const wanted of include) {
    const byId = candidates.find(candidate => candidate.id === wanted);
    const path = safeArchivePath(wanted);
    const found =
      (byId && { ...byId, name: safeArchivePath(byId.name) || byId.id }) ||
      (path && byPath.get(keyOf(path))) ||
      // A bare file name matches a file in a folder when only one does.
      (path && !path.includes('/')
        ? (() => {
            const matches = [...byPath.values()].filter(c =>
              keyOf(c.name).endsWith(`/${keyOf(path)}`)
            );
            return matches.length === 1 ? matches[0] : null;
          })()
        : null);
    if (found) selected.set(keyOf(found.name), found);
    else missing.push(wanted);
  }
  if (missing.length) {
    const available = [...byPath.values()].map(c => `"${c.name}"`).slice(0, 50);
    throw new GeneratedFileError(
      `Not found in this chat: ${missing.map(m => `"${m}"`).join(', ')}. ${
        available.length
          ? `Files of this chat: ${available.join(', ')}.`
          : 'This chat has no files.'
      }`,
      'not-found'
    );
  }
  return [...selected.values()];
}

/**
 * `create_zip`: pack new files and files of this chat into one archive.
 *
 * @param {Object} params - Tool arguments plus the trusted context (`user`, `chatId`).
 * @returns {Promise<Object>}
 */
export async function runCreateZip(params) {
  try {
    const files = parseStructured(params.files, 'files', 'a list of { name, content }') ?? [];
    const include = parseStructured(params.include, 'include', 'a list of file names') ?? [];
    if (!Array.isArray(files) || !Array.isArray(include)) {
      throw new GeneratedFileError('"files" and "include" must be lists.', 'invalid');
    }
    if (files.length > MAX_ZIP_TOOL_FILES) {
      throw new GeneratedFileError(
        `One call can carry at most ${MAX_ZIP_TOOL_FILES} new files.`,
        'invalid'
      );
    }
    const fresh = files.map((file, index) => {
      const name = safeArchivePath(file?.name);
      if (!name || typeof file?.content !== 'string') {
        throw new GeneratedFileError(
          `File ${index + 1} in "files" needs a "name" and a text "content".`,
          'invalid'
        );
      }
      const data = Buffer.from(file.content, 'utf8');
      return { name, bytes: data.length, load: async () => data };
    });
    const wanted = include.filter(entry => typeof entry === 'string' && entry.trim());
    const includeAll = params.includeAll === true;
    const existing =
      wanted.length || includeAll
        ? selectChatFiles(
            await chatFiles({ user: params.user, chatId: params.chatId }),
            wanted.map(entry => entry.trim()),
            includeAll
          )
        : [];
    // A new file replaces an existing one of the same path: it is newer.
    const freshPaths = new Set(fresh.map(file => keyOf(file.name)));
    const items = [...existing.filter(file => !freshPaths.has(keyOf(file.name))), ...fresh];

    const { enabled, maxBytes: maxStoredBytes, maxZipFiles, maxZipBytes } = artifactPolicy();
    // The archive becomes a generated file, so it may not outgrow one either.
    const maxBytes =
      maxZipBytes > 0 ? Math.min(maxZipBytes, MAX_GENERATED_FILE_BYTES) : MAX_GENERATED_FILE_BYTES;
    const planned = planZipEntries(items, { maxFiles: maxZipFiles, maxBytes });
    const entries = [];
    for (const item of planned) {
      const data = await item.load();
      if (!data)
        throw new GeneratedFileError(`"${item.path}" is no longer available.`, 'not-found');
      entries.push({ path: item.path, data, date: item.createdAt });
    }
    const archive = await zipToBuffer(entries);
    // The answer stores the archive as an artifact, and the store refuses one
    // over `artifacts.maxBytes` (decoded bytes). Refused there, the card works
    // only until the page reloads; refused here, the model can split it.
    if (enabled && maxStoredBytes > 0 && archive.length > maxStoredBytes) {
      throw new GeneratedFileError(
        `The archive is ${(archive.length / 1024 / 1024).toFixed(1)} MB, over the ${(maxStoredBytes / 1024 / 1024).toFixed(1)} MB a chat keeps per file. Pack fewer files, or split them into several archives.`,
        'too-large'
      );
    }
    const file = holdGeneratedFile({
      user: params.user,
      chatId: params.chatId,
      data: archive,
      mimeType: ZIP_MEDIA_TYPE,
      name: params.filename || 'files'
    });
    return {
      success: true,
      file,
      files: [file],
      entries: entries.map(entry => entry.path),
      message: `Created the ZIP archive "${file.name}" with ${entries.length} file${entries.length === 1 ? '' : 's'}. The user sees a download card for it in the chat — do not add a link.`
    };
  } catch (error) {
    if (error instanceof ZipLimitError) {
      return { success: false, error: error.message, code: error.code };
    }
    return toolFailure(error, 'The ZIP archive could not be created.');
  }
}
