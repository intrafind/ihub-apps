// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Files of the inference API (`/api/inference/v1`), on the shared chat-file pipeline.
 *
 * Everything a caller sends — an inline `file_data` / data URL, a multipart
 * upload to `POST /v1/files`, a `file_id` in a later request — goes through the
 * same code the Web UI uses: `ingestChatFile` (type check, malware scan, server
 * extraction incl. `.xlsx` and scanned PDFs rendered to page images) and the
 * `ChatFileRepository` (quotas, storage modes, retention).
 *
 *   - **Inline files** of a stateless request are extracted and not stored
 *     ({@link extractInlineFile}); a persisted conversation turn stores them in
 *     the conversation's `chat` scope ({@link persistTurnFiles}) so the Web UI and
 *     later API turns see them.
 *   - **Uploaded files** (`/v1/files`) live in the caller's `user` scope
 *     ({@link userFileScope}); `file_id` references resolve there, and — for a
 *     response run in a conversation — in that chat's scope ({@link createFileContext}).
 *
 * @module services/inference/files
 */
import { chatFilePolicy } from '../chatFiles/chatFilePolicy.js';
import {
  ChatFileQuotaError,
  getChatFileRepository,
  userFileScope
} from '../chatFiles/ChatFileRepository.js';
import {
  ChatFileError,
  describeStored,
  ingestChatFile,
  toPromptFileData
} from '../chatFiles/ChatFileService.js';
import { isAnonymousUser } from '../loop/runIdentity.js';
import { InferenceApiError } from './errors.js';
import { ownerOf } from './conversations.js';

/** What a file is for, when a caller does not say (OpenAI's value for "a file to use in a prompt"). */
export const DEFAULT_FILE_PURPOSE = 'user_data';
const MAX_PURPOSE_CHARS = 64;

/** Where a prompt file came from, kept off the object that travels to the model. */
const SOURCES = new WeakMap();
/** The uploaded bytes of an inline file, kept off the object that travels to the model. */
const ORIGINALS = new WeakMap();

/**
 * Where a file of a request is stored already (a `file_id` reference), or null
 * for an inline file.
 *
 * @param {Object} file - A `fileData` entry.
 * @returns {{scope: {type: string, id: string}, id: string}|null}
 */
export function storedSourceOf(file) {
  return SOURCES.get(file) || null;
}

/**
 * The bytes an inline file was sent with.
 *
 * @param {Object} file - A `fileData` entry.
 * @returns {Buffer|null}
 */
export function originalBytesOf(file) {
  return ORIGINALS.get(file) || null;
}

/** Remember the bytes an inline file arrived with, for storing it with the turn. */
export function rememberOriginal(file, bytes) {
  ORIGINALS.set(file, bytes);
  return file;
}

/**
 * An ingest or storage failure as an inference API error. Status and code stay
 * those of the shared pipeline (quotas: 413 / 507); the codes the API had before
 * the pipeline was shared (`unsupported_file_type`, `file_has_no_text`,
 * `invalid_file`) are kept.
 *
 * @param {unknown} error
 * @param {string|null} [param]
 * @returns {InferenceApiError|unknown} The error itself when it is not a file failure.
 */
export function inferenceFileError(error, param = null) {
  if (error instanceof InferenceApiError) return error;
  const extra = param ? { param } : {};
  if (error instanceof ChatFileQuotaError) {
    return new InferenceApiError(
      error.status || 413,
      String(error.code).toLowerCase(),
      error.message,
      {
        ...extra,
        details: error.details
      }
    );
  }
  if (error instanceof ChatFileError) {
    switch (error.code) {
      case 'UNSUPPORTED_TYPE':
        // `details.accepted` marks a type that was refused by name; without it the type was
        // accepted and the bytes were not what they claimed to be.
        return new InferenceApiError(
          400,
          error.details?.accepted ? 'unsupported_file_type' : 'invalid_file',
          error.message,
          extra
        );
      case 'NO_TEXT':
        return new InferenceApiError(400, 'file_has_no_text', error.message, extra);
      case 'STORAGE_UNAVAILABLE':
        return new InferenceApiError(503, 'files_unavailable', error.message, extra);
      case 'UPLOADS_DISABLED':
        return new InferenceApiError(403, 'uploads_disabled', error.message, extra);
      case 'BINARY_UPLOAD_NOT_ALLOWED':
        return new InferenceApiError(400, 'binary_upload_not_allowed', error.message, extra);
      case 'SCAN_REJECTED':
        return new InferenceApiError(400, 'file_rejected', error.message, extra);
      default:
        return new InferenceApiError(error.status || 400, 'invalid_file', error.message, extra);
    }
  }
  return error;
}

/**
 * The policy extraction of a file that is not stored runs under: the platform's
 * limits, but not its storage switches — nothing is stored, so "uploads off" and
 * "text only" are about something else.
 */
function transientPolicy() {
  return { ...chatFilePolicy(), enabled: true, storageMode: 'server_text_only' };
}

/**
 * Extract a file that arrived inline, without storing it: the same extraction,
 * scan and scanned-PDF fallback as an upload, run against a store that only
 * remembers what it was given.
 *
 * @param {Object} file
 * @param {string} file.name
 * @param {string} [file.mimeType]
 * @param {Buffer} file.bytes
 * @param {string} [param] - Request field, for errors.
 * @param {{speakerNotes?: 'include'|'ignore'}} [extractOptions]
 * @returns {Promise<{text: string, mimeType: string, pages?: number, pageImages: string[]|null, truncated: boolean}>}
 * @throws {InferenceApiError}
 */
export async function extractInlineFile(
  { name, mimeType, bytes },
  param = null,
  extractOptions = null
) {
  let captured = null;
  const sink = {
    isAvailable: () => true,
    put: async (_scope, stored) => {
      captured = stored;
      return { id: 'inline', ...stored };
    }
  };
  try {
    await ingestChatFile({
      scope: { type: 'user', id: 'inline' },
      name,
      mimeType: mimeType || 'application/octet-stream',
      bytes,
      origin: 'api',
      policy: transientPolicy(),
      extractOptions,
      store: sink
    });
  } catch (error) {
    throw inferenceFileError(error, param);
  }
  return {
    text: captured?.text || '',
    mimeType: captured?.mimeType || mimeType,
    ...(Number.isFinite(captured?.pages) ? { pages: captured.pages } : {}),
    pageImages:
      Array.isArray(captured?.pageImages) && captured.pageImages.length > 0
        ? captured.pageImages
        : null,
    truncated: captured?.truncated === true
  };
}

/**
 * The page images a request's files add to a message the model reads as text
 * (documents without a text layer), in the `imageData` shape.
 *
 * @param {Array<Object>|Object|null} files - `fileData`.
 * @returns {Array<{base64: string, fileType: string}>}
 */
export function pageImagesOf(files) {
  const list = Array.isArray(files) ? files : files ? [files] : [];
  return list
    .filter(file => !file?.content && Array.isArray(file?.pageImages))
    .flatMap(file => file.pageImages.map(base64 => ({ base64, fileType: 'image/png' })));
}

/**
 * The authenticated owner of files. Files are kept per caller, so an anonymous
 * caller (one shared principal) has none.
 *
 * @param {Object|null} user
 * @returns {Promise<{id: string, mode: string}>}
 * @throws {InferenceApiError} 401
 */
export async function requireFileOwner(user) {
  if (isAnonymousUser(user)) {
    throw new InferenceApiError(
      401,
      'authentication_required',
      'Files are stored per caller and need an authenticated caller'
    );
  }
  return ownerOf(user);
}

/**
 * The file repository, when files can be stored.
 *
 * @param {Object} [store] - Override (tests).
 * @returns {import('../chatFiles/ChatFileRepository.js').ChatFileRepository}
 * @throws {InferenceApiError} 503
 */
export function requireFileStore(store = null) {
  const repository = store || getChatFileRepository();
  if (!repository?.isAvailable()) {
    throw new InferenceApiError(
      503,
      'files_unavailable',
      'Files are not available: file storage is switched off on this installation'
    );
  }
  return repository;
}

const toUnix = iso => {
  const ms = Date.parse(iso || '');
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000);
};

/**
 * The OpenAI File object of a stored file. `id` is the repository's file id.
 * `bytes` is the size of the file as it was uploaded; `mime_type`, `pages`,
 * `has_original` and `truncated` are iHub additions.
 *
 * @param {Object} descriptor - `ChatFileRepository` descriptor.
 * @returns {Object}
 */
export function fileObject(descriptor) {
  const purpose =
    typeof descriptor.meta?.purpose === 'string' && descriptor.meta.purpose
      ? descriptor.meta.purpose
      : DEFAULT_FILE_PURPOSE;
  const size = Number.isFinite(descriptor.meta?.size)
    ? descriptor.meta.size
    : descriptor.hasOriginal
      ? descriptor.originalBytes
      : descriptor.textBytes;
  return {
    id: descriptor.id,
    object: 'file',
    bytes: size,
    created_at: toUnix(descriptor.createdAt),
    expires_at: null,
    filename: descriptor.name,
    purpose,
    status: 'processed',
    status_details: null,
    mime_type: descriptor.mimeType,
    has_original: descriptor.hasOriginal === true,
    ...(Number.isFinite(descriptor.pages) ? { pages: descriptor.pages } : {}),
    ...(descriptor.truncated ? { truncated: true } : {})
  };
}

/**
 * The `purpose` of an upload: any short string, defaulting to `user_data`.
 *
 * @param {unknown} purpose
 * @returns {string}
 * @throws {InferenceApiError}
 */
export function normalizePurpose(purpose) {
  if (purpose === undefined || purpose === null || purpose === '') return DEFAULT_FILE_PURPOSE;
  if (typeof purpose !== 'string' || purpose.length > MAX_PURPOSE_CHARS) {
    throw new InferenceApiError(
      400,
      'invalid_parameter',
      `purpose must be a string of at most ${MAX_PURPOSE_CHARS} characters`,
      { param: 'purpose' }
    );
  }
  return purpose;
}

function fileNotFound(fileId, param) {
  return new InferenceApiError(404, 'file_not_found', `No such file: ${fileId}`, {
    param: param || 'file_id'
  });
}

/**
 * Resolver of the `file_id` references in one request.
 *
 * A reference resolves in the caller's own files, and — once {@link useChat} named
 * a conversation the caller was authorized for — in that chat's files (a file
 * uploaded in the Web UI, or one an earlier turn stored). Another caller's file
 * is "not found", exactly like an unknown id.
 *
 * @param {Object} options
 * @param {Object|null} options.user
 * @param {Object} [options.store] - File repository override (tests).
 * @returns {{useChat: (chatId: string) => void, resolve: (fileId: string, param?: string) => Promise<Object>}}
 */
export function createFileContext({ user, store = null }) {
  let chatId = null;
  return {
    /** Allow the files of this chat; call only after the caller was authorized for it. */
    useChat(id) {
      chatId = id;
    },
    /**
     * @param {string} fileId
     * @param {string} [param]
     * @returns {Promise<Object>} A `fileData` entry holding the stored text and page images.
     * @throws {InferenceApiError} 401, 404 `file_not_found`, 503
     */
    async resolve(fileId, param) {
      if (typeof fileId !== 'string' || !fileId) {
        throw new InferenceApiError(400, 'invalid_file', 'file_id must be a string', {
          param: param || 'file_id'
        });
      }
      const owner = await requireFileOwner(user);
      const repository = requireFileStore(store);
      const scopes = [...(chatId ? [{ type: 'chat', id: chatId }] : []), userFileScope(owner.id)];
      for (const scope of scopes) {
        const stored = await repository.getText(scope, fileId);
        if (!stored) continue;
        const file = toPromptFileData(stored);
        SOURCES.set(file, { scope, id: stored.id });
        return file;
      }
      throw fileNotFound(fileId, param);
    }
  };
}

/**
 * Store the files of one input message in a conversation (its `chat` scope).
 *
 *   - an inline file is stored with its original (subject to the storage mode),
 *     origin `api`;
 *   - a `file_id` of the caller's own files is copied into the chat, so the
 *     conversation keeps working when the upload is deleted; the same upload
 *     used again is not copied twice;
 *   - a file already in the chat is just referenced.
 *
 * A file the repository will not store (uploads switched off, no storage)
 * leaves `complete: false`: the caller keeps that turn's file text in the
 * rendered message, as before files were stored.
 *
 * @param {Object} options
 * @param {import('../chat/ChatRepository.js').ChatRepository} options.repository
 * @param {Object} options.chat - The conversation.
 * @param {Object} options.message - Chat message with `fileData`.
 * @returns {Promise<{descriptors: Array<Object>, complete: boolean}>} `descriptors`: what the
 *   stored message keeps (`describeStored`), one per file.
 * @throws {InferenceApiError} A quota refusal (413 / 507).
 */
export async function persistTurnFiles({ repository, chat, message }) {
  const store = repository.fileStore();
  const scope = repository.fileScope(chat.id);
  const files = (Array.isArray(message.fileData) ? message.fileData : []).filter(Boolean);
  const descriptors = [];
  let complete = true;
  if (files.length === 0 || !store?.isAvailable()) {
    return { descriptors, complete: files.length === 0 };
  }
  for (const file of files) {
    try {
      const source = storedSourceOf(file);
      let stored = null;
      if (source && source.scope.type === 'chat' && source.scope.id === chat.id) {
        stored = await store.getDescriptor(scope, source.id);
      } else if (source) {
        stored = await store.findByMeta(scope, 'sourceFileId', source.id);
        if (!stored) {
          const original = await store.getOriginal(source.scope, source.id);
          stored = await store.put(scope, {
            ownerId: chat.ownerId,
            name: file.fileName,
            mimeType: file.fileType,
            text: file.content || '',
            pageImages: file.pageImages || null,
            pages: file.pages,
            originalBuffer: original?.data || null,
            origin: 'api',
            meta: { sourceFileId: source.id }
          });
        }
      } else {
        stored = await store.put(scope, {
          ownerId: chat.ownerId,
          name: file.fileName,
          mimeType: file.fileType,
          text: file.content || '',
          pageImages: file.pageImages || null,
          pages: file.pages,
          truncated: file.truncated === true,
          originalBuffer: originalBytesOf(file),
          origin: 'api'
        });
      }
      if (stored) {
        descriptors.push(describeStored(stored));
        continue;
      }
    } catch (error) {
      const mapped = inferenceFileError(error);
      if (mapped instanceof InferenceApiError) throw mapped;
      throw error;
    }
    complete = false;
    descriptors.push({
      type: String(file.fileType || 'file'),
      name: String(file.fileName || 'document'),
      ...(Number.isFinite(file.bytes) ? { bytes: file.bytes } : {})
    });
  }
  return { descriptors, complete };
}
