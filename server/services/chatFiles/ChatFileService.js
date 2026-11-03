// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * ChatFileService — server-side extraction, storage-mode enforcement, and
 * prompt re-hydration for chat and scheduled-task files.
 *
 * Supports all three upload storage modes (`platform.uploads.storageMode` /
 * `app.uploads.storageMode`):
 *   - `original_and_text`: Server extracts text (or scanned-PDF page images)
 *     and stores both the extracted text blob and the original binary blob.
 *   - `server_text_only`: Server extracts text and stores only the extracted
 *     text blob; the raw binary is discarded immediately after extraction.
 *   - `client_text_only`: Accepts pre-extracted text only (`{ name, mimeType,
 *     text, pageImages }`); rejects raw binary uploads so original files never
 *     cross the network.
 *
 * Also handles seamless persistence and re-hydration of inline `fileData` and
 * `attachmentIds` on chat messages so multi-turn conversations (Turn 2+) and
 * chat replay/regenerate (`replaceFromMessageId`) always retain full document
 * context.
 *
 * @module services/chatFiles/ChatFileService
 */
import logger from '../../utils/logger.js';
import configCache from '../../configCache.js';
import {
  ACCEPTED_TYPES,
  ExtractionError,
  MAX_TEXT_CHARS,
  PDF_MIME,
  acceptedTypeOf,
  extractText,
  normalizeText
} from '../projects/extractText.js';
import { scannerFor } from '../projects/scan/MalwareScanner.js';
import { projectSettings } from '../projects/projectSettings.js';
import { renderPagePreview } from '../documents/pdf/PdfService.js';
import { normalizeFiles } from '../../../shared/promptContext.js';
import { normalizeChatFilePolicy } from './chatFilePolicy.js';
import {
  CHAT_FILE_ORIGINS,
  ChatFileQuotaError,
  getChatFileRepository
} from './ChatFileRepository.js';

const COMPONENT = 'ChatFileService';

/** Maximum pages rendered as vision page images for scanned PDFs without a text layer. */
export const MAX_SCANNED_PDF_PAGES = 5;

/**
 * Error raised during chat file ingest or validation.
 */
export class ChatFileError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status=400]
   * @param {Object} [details]
   */
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.name = 'ChatFileError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Render up to `MAX_SCANNED_PDF_PAGES` pages of a scanned PDF as base64 images
 * using `@hyzyla/pdfium` (`renderPagePreview`).
 *
 * @param {Buffer} bytes
 * @returns {Promise<{pageImages: string[], pages: number}>}
 */
async function renderScannedPdfPages(bytes) {
  const pageImages = [];
  let totalPages = 0;
  const first = await renderPagePreview(bytes, 1);
  totalPages = first.pages || 1;
  pageImages.push(first.png.toString('base64'));
  const limit = Math.min(totalPages, MAX_SCANNED_PDF_PAGES);
  for (let p = 2; p <= limit; p += 1) {
    const rendered = await renderPagePreview(bytes, p);
    pageImages.push(rendered.png.toString('base64'));
  }
  return { pageImages, pages: totalPages };
}

/**
 * Ingest a file (either binary bytes or pre-extracted text) into a chat or
 * scheduled-task scope.
 *
 * @param {Object} params
 * @param {{type: 'chat'|'task'|'user', id: string}} params.scope
 * @param {string|null} [params.ownerId]
 * @param {string} params.name
 * @param {string} [params.mimeType]
 * @param {Buffer|Uint8Array|null} [params.bytes] - Raw binary bytes (for `original_and_text` / `server_text_only`).
 * @param {string|null} [params.text] - Pre-extracted text (for `client_text_only` or inline `fileData`).
 * @param {string[]|null} [params.pageImages] - Optional rendered page images for scanned PDFs.
 * @param {number} [params.pages]
 * @param {string} [params.formatLabel]
 * @param {string} [params.origin='upload'] - One of `CHAT_FILE_ORIGINS`.
 * @param {Object|null} [params.meta] - Identity of the item the file was made from (`itemId`, `url`, …).
 * @param {Object|null} [params.source] - Connector provenance (`{ kind, ref, refreshOnRun }`).
 * @param {string|null} [params.id] - Replace the stored file with this id (a connector refresh).
 * @param {Object|null} [params.appConfig]
 * @param {import('./ChatFileRepository.js').ChatFileRepository} [params.repository]
 * @param {Object} [params.scanner]
 * @returns {Promise<Object>} Stored file descriptor.
 */
export async function ingestChatFile({
  scope,
  ownerId = null,
  name,
  mimeType = 'text/plain',
  bytes = null,
  buffer = null,
  text = null,
  pageImages = null,
  pages,
  formatLabel,
  origin = 'upload',
  meta = null,
  source = null,
  id = null,
  appConfig = null,
  policy: explicitPolicy = null,
  repository = null,
  store = null,
  scanner = null
} = {}) {
  const activeRepo = store || repository || getChatFileRepository();
  if (!activeRepo || !activeRepo.isAvailable()) {
    throw new ChatFileError('STORAGE_UNAVAILABLE', 'File storage is unavailable', 503);
  }

  const settings = normalizeChatFilePolicy(explicitPolicy, appConfig);
  if (!settings.enabled) {
    throw new ChatFileError('UPLOADS_DISABLED', 'File uploads are disabled', 403);
  }

  const rawBytes = bytes ?? buffer;
  const hasBinary = Boolean(rawBytes && rawBytes.length > 0);
  if (settings.storageMode === 'client_text_only' && hasBinary) {
    throw new ChatFileError(
      'BINARY_UPLOAD_NOT_ALLOWED',
      'Binary file uploads are disabled in client_text_only mode; upload extracted text only',
      400
    );
  }

  const activeScanner =
    scanner || scannerFor(projectSettings(configCache.getPlatform?.() || {}).scan);

  let extractedText = '';
  let resolvedMime = mimeType;
  let resolvedPages = pages;
  let resolvedPageImages = Array.isArray(pageImages) ? pageImages : null;
  let truncated = false;

  if (hasBinary) {
    const buf = Buffer.isBuffer(rawBytes)
      ? rawBytes
      : Buffer.from(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);

    if (settings.quotas.maxFileBytes > 0 && buf.length > settings.quotas.maxFileBytes) {
      throw new ChatFileQuotaError(
        'QUOTA_FILE_BYTES',
        `File exceeds maximum size of ${Math.floor(settings.quotas.maxFileBytes / (1024 * 1024))} MB`,
        { limit: settings.quotas.maxFileBytes, size: buf.length },
        413
      );
    }

    const accepted = acceptedTypeOf({ contentType: mimeType, name });
    if (!accepted) {
      throw new ChatFileError(
        'UNSUPPORTED_TYPE',
        `${name || 'The file'} has an unsupported type. Supported: ${ACCEPTED_TYPES.summary}.`,
        400,
        { accepted: ACCEPTED_TYPES }
      );
    }

    if (activeScanner && activeScanner.id !== 'none') {
      const scanResult = await activeScanner.scan({
        bytes: buf,
        contentType: accepted,
        name: name || 'upload'
      });
      if (scanResult?.clean === false) {
        throw new ChatFileError(
          'SCAN_REJECTED',
          scanResult.reason || 'The uploaded file was rejected by the security scanner',
          400
        );
      }
    }

    try {
      const extracted = await extractText(
        { bytes: buf, contentType: accepted, name: name || 'upload' },
        { maxChars: MAX_TEXT_CHARS }
      );
      extractedText = extracted.text || '';
      resolvedMime = extracted.contentType || accepted;
      if (Number.isFinite(extracted.pages)) resolvedPages = extracted.pages;
      truncated = extracted.truncated === true;
    } catch (error) {
      if (error instanceof ExtractionError && error.code === 'NO_TEXT' && accepted === PDF_MIME) {
        // Scanned PDF fallback: render page images via pdfium (PM-06).
        try {
          const rendered = await renderScannedPdfPages(buf);
          resolvedPageImages = rendered.pageImages;
          resolvedPages = rendered.pages;
          resolvedMime = PDF_MIME;
          extractedText = '';
        } catch {
          throw new ChatFileError(
            'NO_TEXT',
            error.message || 'The PDF contains no extractable text',
            400
          );
        }
      } else if (error instanceof ExtractionError) {
        throw new ChatFileError(error.code, error.message, 400);
      } else {
        throw new ChatFileError(
          'EXTRACTION_FAILED',
          error?.message || 'Failed to extract document text',
          400
        );
      }
    }

    const descriptor = await activeRepo.put(scope, {
      ownerId,
      name: name || 'upload',
      mimeType: resolvedMime,
      formatLabel,
      text: extractedText,
      originalBuffer: settings.storageMode === 'original_and_text' ? buf : null,
      originalData: buf,
      pageImages: resolvedPageImages,
      pages: resolvedPages,
      truncated,
      origin,
      meta,
      source,
      ...(id ? { id } : {}),
      storageMode: settings.storageMode,
      appConfig,
      policy: settings
    });

    if (!descriptor) {
      throw new ChatFileError('STORAGE_UNAVAILABLE', 'Failed to store uploaded file', 503);
    }
    return descriptor;
  }

  // Text-only ingest (`client_text_only` or inline `fileData`)
  const normalized = normalizeText(typeof text === 'string' ? text : '', {
    maxChars: MAX_TEXT_CHARS
  });
  extractedText = normalized.text;
  truncated = normalized.truncated === true;

  if (!extractedText && (!resolvedPageImages || resolvedPageImages.length === 0)) {
    throw new ChatFileError('NO_TEXT', 'The uploaded file contains no text', 400);
  }

  if (activeScanner && activeScanner.id !== 'none' && extractedText) {
    const textBytes = Buffer.from(extractedText, 'utf8');
    const scanResult = await activeScanner.scan({
      bytes: textBytes,
      contentType: 'text/plain',
      name: name || 'upload.txt'
    });
    if (scanResult?.clean === false) {
      throw new ChatFileError(
        'SCAN_REJECTED',
        scanResult.reason || 'The uploaded content was rejected by the security scanner',
        400
      );
    }
  }

  const descriptor = await activeRepo.put(scope, {
    ownerId,
    name: name || 'upload.txt',
    mimeType: resolvedMime || 'text/plain',
    formatLabel,
    text: extractedText,
    originalBuffer: null,
    pageImages: resolvedPageImages,
    pages: resolvedPages,
    truncated,
    origin,
    meta,
    source,
    ...(id ? { id } : {}),
    storageMode:
      settings.storageMode === 'original_and_text' ? 'server_text_only' : settings.storageMode,
    appConfig,
    policy: settings
  });

  if (!descriptor) {
    throw new ChatFileError('STORAGE_UNAVAILABLE', 'Failed to store uploaded file', 503);
  }
  return descriptor;
}

/**
 * Convert a stored file record (`getText` result) into a `fileData` entry that
 * `PromptService.processMessageTemplates` and `RequestBuilder.attachDocumentPageImages`
 * consume.
 *
 * @param {Object} storedFile - Output of `ChatFileRepository#getText`.
 * @returns {Object}
 */
export function toPromptFileData(storedFile) {
  return {
    id: storedFile.id,
    fileId: storedFile.id,
    fileName: storedFile.name,
    name: storedFile.name,
    fileType: storedFile.mimeType,
    type: 'document',
    ...(storedFile.formatLabel ? { displayType: storedFile.formatLabel } : {}),
    content: storedFile.text || '',
    ...(Array.isArray(storedFile.pageImages) && storedFile.pageImages.length > 0
      ? { pageImages: storedFile.pageImages }
      : {}),
    canUseAsTemplate: storedFile.canUseAsTemplate === true,
    hasOriginal: storedFile.hasOriginal === true,
    origin: CHAT_FILE_ORIGINS.includes(storedFile.origin) ? storedFile.origin : 'upload',
    ...(storedFile.meta ? { meta: storedFile.meta } : {}),
    fileSize: storedFile.bytes
  };
}

/**
 * The descriptor a stored message keeps for a file: what the transcript needs
 * to show it and to find it again (`attachments` of `chat-messages`).
 *
 * @param {Object} stored - Descriptor or `getText` result.
 * @returns {Object}
 */
export function describeStored(stored) {
  return {
    id: stored.id,
    type: stored.mimeType,
    name: stored.name,
    bytes: stored.bytes,
    ...(stored.origin && stored.origin !== 'upload' ? { origin: stored.origin } : {}),
    ...(stored.hasOriginal ? { hasOriginal: true } : {}),
    ...(stored.canUseAsTemplate ? { canUseAsTemplate: true } : {})
  };
}

/**
 * Persist any inline `fileData` carried on a new user message into
 * `ChatFileRepository` (if not already stored) and resolve any pre-uploaded
 * `attachmentIds` from `ChatFileRepository`, returning:
 *   - `promptMessage`: the user message with full `fileData` populated for Turn 1
 *   - `attachments`: normalized attachment descriptors (including `id`) to store
 *     on the persisted message in `chat-messages/<chatId>`.
 *
 * @param {Object} params
 * @param {string} params.chatId
 * @param {string|null} [params.ownerId]
 * @param {Object} params.message - The new user message from the request.
 * @param {Array<Object>} [params.inheritedAttachments] - Attachments from the
 *   message being regenerated (`replaceFromMessageId`) when the request did
 *   not specify new `fileData` or `attachmentIds`.
 * @param {Object|null} [params.appConfig]
 * @param {import('./ChatFileRepository.js').ChatFileRepository} [params.fileRepository]
 * @returns {Promise<{promptMessage: Object, attachments: Array<Object>}>}
 */
export async function prepareTurnFiles({
  chatId,
  ownerId = null,
  message,
  inheritedAttachments = null,
  appConfig = null,
  fileRepository = null,
  store = null
}) {
  const activeRepo = store || fileRepository || getChatFileRepository();
  const scope = { type: 'chat', id: chatId };
  const inlineFiles = normalizeFiles(message?.fileData);
  // `fileIds` is what the composer sends for files it already uploaded
  // (`POST /api/chats/:chatId/files`); `attachmentIds` is the same list under
  // its older name.
  const idList = Array.isArray(message?.fileIds)
    ? message.fileIds
    : Array.isArray(message?.attachmentIds)
      ? message.attachmentIds
      : null;
  const explicitIds = idList ? idList.filter(id => typeof id === 'string' && id) : null;

  // When regenerating a hydrated message (`replaceFromMessageId`), the client
  // does not have `fileData` in memory after a reload. If the caller did not
  // pass `attachmentIds` or new `fileData`, inherit the file ids of the
  // message being regenerated.
  const inheritedIds =
    !inlineFiles.length && explicitIds === null && Array.isArray(inheritedAttachments)
      ? inheritedAttachments
          .map(att => att?.id || att?.fileId)
          .filter(id => typeof id === 'string' && id)
      : [];

  const targetIds = explicitIds !== null ? explicitIds : inheritedIds;
  const resolvedPromptFiles = [];
  const descriptors = [];
  const seenIds = new Set();

  // 1. Resolve pre-uploaded (or inherited) file IDs from ChatFileRepository.
  if (activeRepo?.isAvailable() && targetIds.length > 0) {
    for (const fileId of targetIds) {
      if (seenIds.has(fileId)) continue;
      const stored = await activeRepo.getText(scope, fileId);
      if (!stored) continue;
      seenIds.add(fileId);
      resolvedPromptFiles.push(toPromptFileData(stored));
      descriptors.push(describeStored(stored));
    }
  }

  // 2. Persist any inline `fileData` into ChatFileRepository so Turn 2+ and
  //    replay after reload retain the document text.
  for (const file of inlineFiles) {
    const existingId = file.fileId || file.id;
    if (existingId && activeRepo?.isAvailable()) {
      if (seenIds.has(existingId)) continue;
      const stored = await activeRepo.getText(scope, existingId);
      if (stored) {
        seenIds.add(existingId);
        resolvedPromptFiles.push(toPromptFileData(stored));
        descriptors.push(describeStored(stored));
        continue;
      }
    }

    const name = file.fileName || file.name || 'document';
    const mimeType = file.fileType || file.mimeType || file.type || 'text/plain';
    const text = typeof file.content === 'string' ? file.content : '';
    const pageImages = Array.isArray(file.pageImages) ? file.pageImages : null;

    if (activeRepo?.isAvailable() && (text || (pageImages && pageImages.length > 0))) {
      try {
        const origin = CHAT_FILE_ORIGINS.includes(file.origin) ? file.origin : 'upload';
        const meta = file.meta && typeof file.meta === 'object' ? file.meta : null;
        // An e-mail, meeting or page that is sent with every turn is stored once
        // per chat (by the item's id or URL); a changed one replaces the stored copy.
        let replaceId = null;
        const identity = meta?.itemId
          ? ['itemId', meta.itemId]
          : meta?.url
            ? ['url', meta.url]
            : null;
        if (identity && ['email', 'meeting', 'page'].includes(origin)) {
          const existing = await activeRepo.findByMeta(scope, identity[0], String(identity[1]));
          if (existing) {
            const current = await activeRepo.getText(scope, existing.id);
            if (current && current.text === text && current.meta?.isCurrent === meta?.isCurrent) {
              seenIds.add(existing.id);
              resolvedPromptFiles.push({ ...toPromptFileData(current), origin });
              descriptors.push(describeStored(current));
              continue;
            }
            replaceId = existing.id;
          }
        }
        const storedDescriptor = await activeRepo.put(scope, {
          ownerId,
          name,
          mimeType,
          formatLabel: file.displayType || null,
          text,
          originalBuffer: file.base64 ? Buffer.from(file.base64, 'base64') : null,
          pageImages,
          origin,
          meta,
          ...(replaceId ? { id: replaceId } : {}),
          appConfig
        });
        if (storedDescriptor) {
          seenIds.add(storedDescriptor.id);
          resolvedPromptFiles.push({
            ...file,
            id: storedDescriptor.id,
            fileId: storedDescriptor.id,
            fileName: storedDescriptor.name,
            fileType: storedDescriptor.mimeType,
            content: text,
            ...(pageImages ? { pageImages } : {}),
            origin,
            ...(meta ? { meta } : {}),
            canUseAsTemplate: storedDescriptor.canUseAsTemplate === true,
            hasOriginal: storedDescriptor.hasOriginal === true
          });
          descriptors.push(describeStored(storedDescriptor));
          continue;
        }
      } catch (error) {
        logger.warn(
          'Failed to persist inline chat fileData; continuing with inline content for this turn',
          {
            component: COMPONENT,
            chatId,
            name,
            error: error.message
          }
        );
      }
    }

    // Fallback when storage is unavailable or refused the inline file: keep inline for Turn 1.
    resolvedPromptFiles.push(file);
    descriptors.push({
      type: String(mimeType),
      name: String(name),
      ...(Number.isFinite(Number(file.fileSize ?? file.bytes))
        ? { bytes: Number(file.fileSize ?? file.bytes) }
        : {})
    });
  }

  // Also include image/audio attachment descriptors from `message.imageData` / `message.audioData`
  for (const media of [message?.imageData, message?.audioData].flatMap(v =>
    Array.isArray(v) ? v : v ? [v] : []
  )) {
    if (!media || typeof media !== 'object') continue;
    const name = media.name || media.fileName;
    const bytes = Number(media.bytes ?? media.size ?? media.fileSize);
    descriptors.push({
      type: String(media.fileType || media.mimeType || media.type || 'file'),
      ...(name ? { name: String(name) } : {}),
      ...(Number.isFinite(bytes) ? { bytes } : {})
    });
  }

  const promptMessage =
    resolvedPromptFiles.length > 0
      ? {
          ...message,
          fileData: resolvedPromptFiles.length === 1 ? resolvedPromptFiles[0] : resolvedPromptFiles
        }
      : message;

  return { promptMessage, message: promptMessage, attachments: descriptors };
}

/**
 * Re-hydrate `fileData` on stored history messages from `ChatFileRepository`
 * so Turn 2+ prompts retain `<content type="document">` blocks for files
 * uploaded in earlier turns.
 *
 * @param {string} chatId
 * @param {Array<Object>} storedMessages
 * @param {Object} [options]
 * @param {import('./ChatFileRepository.js').ChatFileRepository} [options.fileRepository]
 * @param {import('./ChatFileRepository.js').ChatFileRepository} [options.store]
 * @param {Array<{type: 'chat'|'task', id: string}>} [options.extraScopes] - Additional scopes (e.g. task scope).
 * @returns {Promise<Array<Object>>}
 */
export async function hydrateHistoryForPrompt(
  chatId,
  storedMessages,
  { fileRepository = null, store = null, extraScopes = [] } = {}
) {
  const activeRepo = store || fileRepository || getChatFileRepository();
  const scopes = [{ type: 'chat', id: chatId }, ...extraScopes];
  const out = [];

  for (const entry of storedMessages || []) {
    if (!entry?.role) continue;
    const hasText = typeof entry.content === 'string' && entry.content.trim().length > 0;
    const fileAttachments = Array.isArray(entry.attachments)
      ? entry.attachments.filter(att => typeof (att?.id || att?.fileId) === 'string')
      : [];

    if (!hasText && fileAttachments.length === 0) continue;

    let hydratedFiles = [];
    if (entry.role === 'user' && fileAttachments.length > 0 && activeRepo?.isAvailable()) {
      for (const att of fileAttachments) {
        const fileId = att.id || att.fileId;
        let stored = null;
        for (const scope of scopes) {
          stored = await activeRepo.getText(scope, fileId);
          if (stored) break;
        }
        if (stored) {
          hydratedFiles.push(toPromptFileData(stored));
        }
      }
    }

    if (!hasText && hydratedFiles.length === 0) continue;

    const skills = entry.role === 'assistant' ? entry.activity?.activeSkills : null;
    out.push({
      role: entry.role,
      content: typeof entry.content === 'string' ? entry.content : '',
      ...(Array.isArray(skills) && skills.length > 0 ? { activeSkills: skills } : {}),
      ...(hydratedFiles.length > 0 ? { fileData: hydratedFiles } : {})
    });
  }

  return out;
}
