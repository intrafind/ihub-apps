// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * ChatFileRepository — durable storage for files uploaded to a chat or a
 * scheduled task.
 *
 * Each uploaded file is stored under a scope (`chat` or `task`):
 *   - Document metadata in `RUNTIME_NAMESPACES.chatFiles`:
 *       `<scopeType>__<scopeId>__<fileId>` (indexed by `ownerId`)
 *   - Extracted text payload in `BLOB_NAMESPACES.chatFiles`:
 *       `<scopeType>__<scopeId>__<fileId>.txt`
 *   - Optional rendered page images (for scanned PDFs with no text layer):
 *       `<scopeType>__<scopeId>__<fileId>.pages`
 *   - Optional original binary payload (only in `original_and_text` mode):
 *       `<scopeType>__<scopeId>__<fileId>.bin`
 *
 * Splitting `.txt` and `.bin` into separate blobs allows the heavy original
 * binary to expire (`originalRetentionDays`, default 14d) or be LRU-evicted
 * when a user or server quota is reached, while keeping the lightweight
 * extracted text so multi-turn continuation and chat replay continue to work
 * for the full life of the chat (`chatRetentionDays`, default 90d).
 *
 * @module services/chatFiles/ChatFileRepository
 */
import { createHash, randomUUID } from 'node:crypto';
import logger from '../../utils/logger.js';
import { isValidId } from '../../utils/pathSecurity.js';
import { getStorage, readFacet } from '../../storage/bootstrap.js';
import { BLOB_NAMESPACES, RUNTIME_NAMESPACES } from '../../storage/namespaces.js';
import {
  canUseFileAsTemplate,
  chatFilePolicy,
  normalizeChatFilePolicy,
  resolveStorageMode
} from './chatFilePolicy.js';

const COMPONENT = 'ChatFileRepository';

export const CHAT_FILES_NAMESPACE = RUNTIME_NAMESPACES.chatFiles;
export const CHAT_FILE_BLOBS_NAMESPACE = BLOB_NAMESPACES.chatFiles;
export const CHAT_FILE_VERSION = 1;

/**
 * Scopes an uploaded file may belong to:
 * - `chat`: a durable or temporary chat (`originalRetentionDays` TTL applies to `.bin`).
 * - `task`: a scheduled task definition (exempt from age-based TTL; lives until task deletion).
 * - `user`: files a user uploaded through the Inference API (`/api/inference/v1/files`),
 *   referenced by `file_id` from any later request; the id is {@link userFileScope}.
 */
export const CHAT_FILE_SCOPES = Object.freeze(['chat', 'task', 'user']);

/**
 * Where a stored file came from. `upload` and `attachment` (a file attached to
 * an e-mail) are the classic two; the rest are first-class sources whose files
 * show in the Files drawer like any other.
 */
export const CHAT_FILE_ORIGINS = Object.freeze([
  'upload',
  'attachment',
  'email',
  'meeting',
  'page',
  'connector',
  'api',
  'mcp',
  'a2a'
]);

/** Largest serialized `meta` a file keeps (it rides on every listing). */
export const MAX_CHAT_FILE_META_BYTES = 8 * 1024;

/**
 * Scope of the files a user owns outside any chat (Inference API). The owner id
 * is hashed: ids may hold characters a storage key cannot (or the `__`
 * separator), and the scope must not leak who owns it.
 *
 * @param {string} ownerId
 * @returns {{type: 'user', id: string}}
 */
export function userFileScope(ownerId) {
  return {
    type: 'user',
    id: `u${createHash('sha256').update(String(ownerId)).digest('hex').slice(0, 32)}`
  };
}

/**
 * A `meta` object reduced to what a descriptor may carry: JSON values only,
 * bounded in size. Anything else is dropped rather than failing the upload.
 *
 * @param {unknown} meta
 * @returns {Object|null}
 */
export function sanitizeFileMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  try {
    const json = JSON.stringify(meta);
    if (Buffer.byteLength(json, 'utf8') > MAX_CHAT_FILE_META_BYTES) return null;
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Connector provenance of a file (`{ kind, ref, refreshOnRun?, … }`), reduced to
 * plain JSON.
 *
 * @param {unknown} source
 * @returns {{kind: string, ref: Object, refreshOnRun?: boolean, lastFetchedAt?: string, sourceModified?: string}|null}
 */
export function sanitizeFileSource(source) {
  if (!source || typeof source !== 'object' || typeof source.kind !== 'string') return null;
  const ref = sanitizeFileMeta(source.ref);
  if (!ref) return null;
  return {
    kind: source.kind.slice(0, 40),
    ref,
    ...(source.refreshOnRun === true ? { refreshOnRun: true } : {}),
    ...(typeof source.lastFetchedAt === 'string' ? { lastFetchedAt: source.lastFetchedAt } : {}),
    ...(typeof source.sourceModified === 'string' ? { sourceModified: source.sourceModified } : {})
  };
}

const KEY_SEPARATOR = '__';
const DAY_MS = 24 * 60 * 60 * 1000;
const SCAN_PAGE_SIZE = 200;

/** How long the cached server-wide byte total is trusted. */
const SERVER_BYTES_CACHE_MS = 30 * 1000;

/** Share of `maxServerBytes` above which an upload checks the exact total. */
const SERVER_QUOTA_EXACT_FRACTION = 0.9;

export const MAX_CHAT_FILE_NAME_CHARS = 300;

/**
 * Error thrown when an upload exceeds one of the three quota tiers.
 */
export class ChatFileQuotaError extends Error {
  /**
   * @param {'QUOTA_FILE_BYTES'|'QUOTA_CHAT_FILES'|'QUOTA_CHAT_BYTES'|'QUOTA_USER_BYTES'|'QUOTA_SERVER_BYTES'} code
   * @param {string} message
   * @param {Object} [details]
   * @param {number} [status=413]
   */
  constructor(code, message, details = {}, status = 413) {
    super(message);
    this.name = 'ChatFileQuotaError';
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

/**
 * Validate a scope, or return null when it cannot address storage.
 *
 * @param {{type: string, id: string}} scope
 * @returns {{type: 'chat'|'task'|'user', id: string}|null}
 */
export function normalizeFileScope(scope) {
  const type = scope?.type;
  const id = scope?.id;
  if (!CHAT_FILE_SCOPES.includes(type)) return null;
  if (!isValidId(id)) return null;
  return { type, id };
}

/**
 * Document key for a stored file.
 *
 * @param {{type: string, id: string}} scope
 * @param {string} fileId
 * @returns {string}
 */
export function chatFileKey(scope, fileId) {
  return `${scope.type}${KEY_SEPARATOR}${scope.id}${KEY_SEPARATOR}${fileId}`;
}

function scopePrefix(scope) {
  return `${scope.type}${KEY_SEPARATOR}${scope.id}${KEY_SEPARATOR}`;
}

function textBlobKey(docKey) {
  return `${docKey}.txt`;
}

function originalBlobKey(docKey) {
  return `${docKey}.bin`;
}

function pagesBlobKey(docKey) {
  return `${docKey}.pages`;
}

function sameScope(a, b) {
  return a?.type === b?.type && a?.id === b?.id;
}

/**
 * Mint a compact, URL-safe file id (`file_<24 hex chars>`).
 *
 * @returns {string}
 */
export function mintChatFileId() {
  return `file_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

/**
 * Build a client- and message-safe descriptor from a stored metadata document.
 *
 * @param {string} id
 * @param {Object} data
 * @returns {Object}
 */
export function toFileDescriptor(id, data) {
  const mimeType =
    typeof data.mimeType === 'string' && data.mimeType ? data.mimeType : 'application/octet-stream';
  const hasOriginal = data.hasOriginal === true;
  const textBytes = Number.isFinite(data.textBytes) ? data.textBytes : 0;
  const originalBytes = hasOriginal && Number.isFinite(data.originalBytes) ? data.originalBytes : 0;
  const bytes = Number.isFinite(data.bytes) ? data.bytes : textBytes + originalBytes;

  return {
    id,
    name: typeof data.name === 'string' && data.name ? data.name : id,
    mimeType,
    type: mimeType,
    ...(typeof data.formatLabel === 'string' && data.formatLabel
      ? { formatLabel: data.formatLabel }
      : {}),
    bytes,
    textBytes,
    extractedBytes: textBytes,
    originalBytes,
    hasOriginal,
    hasPageImages: Number.isFinite(data.pageImageCount) && data.pageImageCount > 0,
    ...(typeof data.originalDeletedAt === 'string' && data.originalDeletedAt
      ? { originalDeletedAt: data.originalDeletedAt }
      : {}),
    ...(typeof (data.originalDeleteReason || data.originalDeletedReason) === 'string' &&
    (data.originalDeleteReason || data.originalDeletedReason)
      ? {
          originalDeleteReason: data.originalDeleteReason || data.originalDeletedReason,
          originalDeletedReason: data.originalDeleteReason || data.originalDeletedReason
        }
      : {}),
    ...(typeof data.storageMode === 'string' ? { storageMode: data.storageMode } : {}),
    ...(Number.isFinite(data.pages) ? { pages: data.pages } : {}),
    ...(Number.isFinite(data.pageImageCount) && data.pageImageCount > 0
      ? { pageImageCount: data.pageImageCount }
      : {}),
    ...(data.truncated === true ? { truncated: true } : {}),
    ...(typeof data.sha256 === 'string' && data.sha256 ? { sha256: data.sha256 } : {}),
    ...(typeof data.origin === 'string' && data.origin ? { origin: data.origin } : {}),
    ...(data.meta && typeof data.meta === 'object' ? { meta: data.meta } : {}),
    ...(data.source && typeof data.source === 'object' ? { source: data.source } : {}),
    canUseAsTemplate: canUseFileAsTemplate(mimeType, hasOriginal),
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString()
  };
}

/**
 * Durable repository for chat and scheduled-task uploaded files.
 */
export class ChatFileRepository {
  /**
   * @param {Object} [options]
   * @param {import('../../storage/DocumentStore.js').DocumentStore|null} [options.documents]
   * @param {import('../../storage/BlobStore.js').BlobStore|null} [options.blobs]
   * @param {Object} [options.logger]
   * @param {(appConfig?: Object) => ReturnType<typeof chatFilePolicy>} [options.policy]
   */
  constructor({ documents = null, blobs = null, logger: log, policy = chatFilePolicy } = {}) {
    this.documents = documents || null;
    this.blobs = blobs || null;
    this.logger = log || logger;
    this.policy = policy;
    /** @type {{value: number, at: number}|null} */
    this._serverBytes = null;
  }

  /** Whether both document and blob facets are available. @returns {boolean} */
  isAvailable() {
    return Boolean(this.documents && this.blobs);
  }

  _scope(scope, operation) {
    if (!this.isAvailable()) return null;
    const normalized = normalizeFileScope(scope);
    if (!normalized) {
      this.logger.debug?.('Chat file scope is not storable; skipping', {
        component: COMPONENT,
        operation,
        scopeType: String(scope?.type).slice(0, 32),
        scopeId: String(scope?.id).slice(0, 64)
      });
      return null;
    }
    return normalized;
  }

  /**
   * Store a file (extracted text + optional page images + optional original binary)
   * after checking and enforcing all three quota tiers.
   *
   * @param {{type: 'chat'|'task'|'user', id: string}} scope
   * @param {Object} file
   * @param {string} [file.id] - Optional explicit fileId (must be valid id). When a file with
   *   this id exists it is replaced in place (its bytes do not count against the quotas twice).
   * @param {string|null} [file.ownerId] - Owning principal id for user quota indexing.
   * @param {string} file.name - Display filename.
   * @param {string} file.mimeType - Media type.
   * @param {string} [file.formatLabel] - Human-readable format label (e.g. 'PDF', 'Word').
   * @param {string} [file.text=''] - Extracted UTF-8 text.
   * @param {Buffer|Uint8Array|null} [file.originalBuffer=null] - Raw binary bytes.
   * @param {string[]} [file.pageImages] - Base64 JPEG page images for scanned PDFs.
   * @param {number} [file.pages] - Page/slide/sheet count when known.
   * @param {boolean} [file.truncated=false] - Whether extracted text was truncated.
   * @param {string} [file.origin='upload'] - One of {@link CHAT_FILE_ORIGINS}.
   * @param {Object|null} [file.meta] - What identifies the item the file was made from
   *   (`itemId`, `url`, `mailboxUser`, …); see {@link ChatFileRepository#findByMeta}.
   * @param {Object|null} [file.source] - Connector provenance (`{ kind, ref, refreshOnRun }`).
   * @param {'original_and_text'|'server_text_only'|'client_text_only'} [file.storageMode]
   * @param {Object} [file.appConfig] - Optional app config for policy resolution.
   * @param {string} [file.createdAt] - Optional timestamp override (for tests).
   * @returns {Promise<Object|null>} File descriptor.
   */
  async put(
    scopeOrParams,
    {
      id: requestedId = null,
      ownerId = null,
      name,
      mimeType,
      formatLabel,
      text = '',
      originalBuffer = null,
      originalData = null,
      pageImages = null,
      pages,
      truncated = false,
      origin = 'upload',
      meta = null,
      source = null,
      storageMode: explicitMode,
      appConfig = null,
      policy: explicitPolicy = null,
      createdAt = null,
      now = null
    } = {}
  ) {
    // Allow either `put(scope, file)` or `put({ scope, ...file })`
    if (
      scopeOrParams &&
      typeof scopeOrParams === 'object' &&
      scopeOrParams.scope &&
      !scopeOrParams.type
    ) {
      const { scope: innerScope, ...rest } = scopeOrParams;
      return this.put(innerScope, rest);
    }
    const scope = scopeOrParams;
    const target = this._scope(scope, 'put');
    if (!target) return null;

    const settings = normalizeChatFilePolicy(explicitPolicy || this.policy(appConfig), appConfig);
    if (settings.enabled === false) return null;

    const mode = explicitMode
      ? resolveStorageMode(explicitMode, settings.storageMode)
      : settings.storageMode;

    const textStr = typeof text === 'string' ? text : '';
    const textBuf = Buffer.from(textStr, 'utf8');
    const validPages = Array.isArray(pageImages)
      ? pageImages.filter(img => typeof img === 'string' && img.length > 0)
      : [];
    const pagesBuf = validPages.length > 0 ? Buffer.from(JSON.stringify(validPages), 'utf8') : null;

    const candidateOriginal = originalBuffer ?? originalData;
    const rawOriginal =
      mode === 'original_and_text' && candidateOriginal
        ? Buffer.isBuffer(candidateOriginal)
          ? candidateOriginal
          : candidateOriginal instanceof Uint8Array
            ? Buffer.from(
                candidateOriginal.buffer,
                candidateOriginal.byteOffset,
                candidateOriginal.byteLength
              )
            : null
        : null;

    if (textBuf.length === 0 && !rawOriginal && !pagesBuf) {
      return null;
    }

    const textBytes = textBuf.length + (pagesBuf ? pagesBuf.length : 0);
    const originalBytes = rawOriginal ? rawOriginal.length : 0;
    const totalBytes = textBytes + originalBytes;
    const singleFileSize = rawOriginal ? rawOriginal.length : textBytes;

    const id = requestedId && isValidId(requestedId) ? requestedId : mintChatFileId();
    const key = chatFileKey(target, id);
    if (!isValidId(key) || !isValidId(textBlobKey(key)) || !isValidId(originalBlobKey(key))) {
      this.logger.warn('Chat file not stored: scope id leaves no room for a key', {
        component: COMPONENT,
        scopeType: target.type,
        scopeId: target.id
      });
      return null;
    }

    // Writing over a file that exists (a connector refresh): the old copy goes
    // away with the new one, so its bytes and its slot do not count.
    const previous = requestedId
      ? (await this.documents.get(CHAT_FILES_NAMESPACE, key))?.data
      : null;
    const replaces =
      previous && (!previous.scope || sameScope(previous.scope, target))
        ? { key, bytes: Number(previous.bytes) || 0 }
        : null;

    await this._enforceQuotas({
      scope: target,
      ownerId: ownerId ? String(ownerId) : null,
      singleFileSize,
      totalBytes,
      settings,
      replaces
    });

    const cleanName =
      typeof name === 'string' && name.trim() ? name.trim().slice(0, MAX_CHAT_FILE_NAME_CHARS) : id;
    const cleanMime =
      typeof mimeType === 'string' && mimeType.trim()
        ? mimeType.split(';')[0].trim().toLowerCase()
        : 'application/octet-stream';
    const sha256 = createHash('sha256')
      .update(rawOriginal || textBuf)
      .digest('hex');

    // Write blobs first, metadata document last, cleaning up blobs if document write fails.
    await this.blobs.put(CHAT_FILE_BLOBS_NAMESPACE, textBlobKey(key), textBuf, {
      contentType: 'text/plain; charset=utf-8'
    });
    if (pagesBuf) {
      await this.blobs.put(CHAT_FILE_BLOBS_NAMESPACE, pagesBlobKey(key), pagesBuf, {
        contentType: 'application/json'
      });
    }
    if (rawOriginal && rawOriginal.length > 0) {
      await this.blobs.put(CHAT_FILE_BLOBS_NAMESPACE, originalBlobKey(key), rawOriginal, {
        contentType: cleanMime
      });
    }

    const body = {
      version: CHAT_FILE_VERSION,
      scope: target,
      ownerId: ownerId ? String(ownerId) : null,
      name: cleanName,
      mimeType: cleanMime,
      ...(typeof formatLabel === 'string' && formatLabel ? { formatLabel } : {}),
      storageMode: mode,
      bytes: totalBytes,
      textBytes,
      originalBytes,
      hasOriginal: Boolean(rawOriginal && rawOriginal.length > 0),
      sha256,
      ...(Number.isFinite(pages) ? { pages } : {}),
      ...(validPages.length > 0 ? { pageImageCount: validPages.length } : {}),
      ...(truncated === true ? { truncated: true } : {}),
      origin: CHAT_FILE_ORIGINS.includes(origin) ? origin : 'upload',
      ...(sanitizeFileMeta(meta) ? { meta: sanitizeFileMeta(meta) } : {}),
      ...(sanitizeFileSource(source) ? { source: sanitizeFileSource(source) } : {}),
      ...(mode === 'server_text_only' && candidateOriginal
        ? { originalDeleteReason: 'storage_mode', originalDeletedReason: 'storage_mode' }
        : {}),
      createdAt: createdAt || now || new Date().toISOString()
    };

    try {
      await this.documents.put(
        CHAT_FILES_NAMESPACE,
        key,
        body,
        ownerId ? { ownerId: String(ownerId) } : {}
      );
    } catch (error) {
      await this.blobs.delete(CHAT_FILE_BLOBS_NAMESPACE, textBlobKey(key)).catch(() => {});
      if (pagesBuf) {
        await this.blobs.delete(CHAT_FILE_BLOBS_NAMESPACE, pagesBlobKey(key)).catch(() => {});
      }
      if (rawOriginal) {
        await this.blobs.delete(CHAT_FILE_BLOBS_NAMESPACE, originalBlobKey(key)).catch(() => {});
      }
      throw error;
    }

    if (replaces) {
      // The new copy may have no original or no page images where the old one had.
      if (!rawOriginal) {
        await this.blobs.delete(CHAT_FILE_BLOBS_NAMESPACE, originalBlobKey(key)).catch(() => {});
      }
      if (!pagesBuf) {
        await this.blobs.delete(CHAT_FILE_BLOBS_NAMESPACE, pagesBlobKey(key)).catch(() => {});
      }
    }

    this._noteServerBytes(totalBytes - (replaces?.bytes || 0));
    return toFileDescriptor(id, body);
  }

  /**
   * Check per-file, per-chat/task, per-user, and server-total quotas.
   * When per-user or server-total quota is exceeded and `evictOldestOriginalsOnQuota`
   * is enabled, automatically evicts the oldest unpinned chat original binaries first.
   *
   * @private
   */
  async _enforceQuotas({ scope, ownerId, singleFileSize, totalBytes, settings, replaces = null }) {
    const { quotas, evictOldestOriginalsOnQuota } = settings;

    if (quotas.maxFileBytes > 0 && singleFileSize > quotas.maxFileBytes) {
      throw new ChatFileQuotaError(
        'QUOTA_FILE_BYTES',
        `File exceeds maximum size of ${Math.floor(quotas.maxFileBytes / (1024 * 1024))} MB`,
        { limit: quotas.maxFileBytes, size: singleFileSize },
        413
      );
    }

    // Tier 1: Per-Chat / Per-Task quota
    if (quotas.maxChatFiles > 0 || quotas.maxChatBytes > 0) {
      const existing = (await this.list(scope)).filter(
        item => !replaces || chatFileKey(scope, item.id) !== replaces.key
      );
      if (quotas.maxChatFiles > 0 && existing.length >= quotas.maxChatFiles) {
        throw new ChatFileQuotaError(
          'QUOTA_CHAT_FILES',
          `This ${scope.type} already has the maximum of ${quotas.maxChatFiles} uploaded files`,
          { limit: quotas.maxChatFiles, used: existing.length },
          413
        );
      }
      const scopeBytes = existing.reduce((sum, item) => sum + (item.bytes || 0), 0);
      if (quotas.maxChatBytes > 0 && scopeBytes + totalBytes > quotas.maxChatBytes) {
        throw new ChatFileQuotaError(
          'QUOTA_CHAT_BYTES',
          `This ${scope.type} exceeds the storage quota of ${Math.floor(quotas.maxChatBytes / (1024 * 1024))} MB`,
          { limit: quotas.maxChatBytes, used: scopeBytes, size: totalBytes },
          413
        );
      }
    }

    // Tier 2: Per-User quota (with LRU eviction of oldest chat originals)
    if (ownerId && quotas.maxUserBytes > 0) {
      let ownerDocs = await this._listOwnerDocs(ownerId);
      let usedUserBytes =
        ownerDocs.reduce((sum, doc) => sum + (Number(doc.data?.bytes) || 0), 0) -
        (replaces?.bytes || 0);
      if (usedUserBytes + totalBytes > quotas.maxUserBytes && evictOldestOriginalsOnQuota) {
        const needed = usedUserBytes + totalBytes - quotas.maxUserBytes;
        const freed = await this._evictOldestOriginals(ownerDocs, needed, {
          excludeScope: scope,
          reason: 'quota_evicted'
        });
        usedUserBytes -= freed;
      }
      if (usedUserBytes + totalBytes > quotas.maxUserBytes) {
        throw new ChatFileQuotaError(
          'QUOTA_USER_BYTES',
          `Your uploaded file storage quota (${Math.floor(quotas.maxUserBytes / (1024 * 1024))} MB) is full`,
          { limit: quotas.maxUserBytes, used: usedUserBytes, size: totalBytes },
          413
        );
      }
    }

    // Tier 3: Server-Total quota (with LRU eviction of oldest chat originals).
    // The total is read from a short-lived cache, not from every document of the
    // namespace on every upload; a full read is made only when the upload could
    // come close to the limit, where the answer has to be exact.
    if (quotas.maxServerBytes > 0) {
      const limit = quotas.maxServerBytes;
      let used = await this._serverUsedBytes();
      if (used + totalBytes > limit * SERVER_QUOTA_EXACT_FRACTION) {
        used = await this._serverUsedBytes({ exact: true });
      }
      used -= replaces?.bytes || 0;
      if (used + totalBytes > limit && evictOldestOriginalsOnQuota) {
        const freed = await this._evictOldestOriginals(
          await this._listAllDocs(),
          used + totalBytes - limit,
          {
            excludeScope: scope,
            reason: 'quota_evicted'
          }
        );
        used -= freed;
        this._serverBytes = null;
      }
      if (used + totalBytes > limit) {
        throw new ChatFileQuotaError(
          'QUOTA_SERVER_BYTES',
          'Server file upload storage quota is full',
          { limit, used, size: totalBytes },
          507
        );
      }
    }
  }

  /**
   * Bytes stored by all chat files of the server. Answered from a cache that is
   * kept current by this process's own writes and expires after
   * {@link SERVER_BYTES_CACHE_MS}, so uploads do not read the whole namespace;
   * `exact` forces a fresh read (another instance may have written too).
   *
   * @param {{exact?: boolean}} [options]
   * @returns {Promise<number>}
   * @private
   */
  async _serverUsedBytes({ exact = false } = {}) {
    const cached = this._serverBytes;
    if (!exact && cached && Date.now() - cached.at < SERVER_BYTES_CACHE_MS) return cached.value;
    const docs = await this._listAllDocs();
    const value = docs.reduce((sum, doc) => sum + (Number(doc.data?.bytes) || 0), 0);
    this._serverBytes = { value, at: Date.now() };
    return value;
  }

  /** Keep the cached server total current after this process wrote `delta` bytes. */
  _noteServerBytes(delta) {
    if (this._serverBytes) this._serverBytes.value = Math.max(0, this._serverBytes.value + delta);
  }

  /**
   * Evict oldest original binary blobs from `chat`-scoped documents (never `task`-scoped)
   * until at least `bytesNeeded` have been freed.
   *
   * @param {Array<{key: string, data: Object}>} docs
   * @param {number} bytesNeeded
   * @param {{excludeScope?: {type: string, id: string}, reason?: string}} [options]
   * @returns {Promise<number>} Bytes freed.
   * @private
   */
  async _evictOldestOriginals(docs, bytesNeeded, { excludeScope = null, reason = 'quota' } = {}) {
    const candidates = docs
      .filter(doc => {
        const d = doc?.data;
        if (!d || d.hasOriginal !== true || !(d.originalBytes > 0)) return false;
        // Task-scoped files are exempt from automatic eviction (Q6).
        if (d.scope?.type === 'task') return false;
        if (excludeScope && sameScope(d.scope, excludeScope)) return false;
        return true;
      })
      .sort((a, b) =>
        String(a.data?.createdAt || '').localeCompare(String(b.data?.createdAt || ''))
      );

    let freed = 0;
    for (const doc of candidates) {
      if (freed >= bytesNeeded) break;
      const scope = doc.data.scope;
      const prefix = scopePrefix(scope);
      const fileId = doc.key.startsWith(prefix) ? doc.key.slice(prefix.length) : null;
      if (!fileId) continue;
      const beforeBytes = Number(doc.data.originalBytes) || 0;
      const updated = await this.discardOriginal(scope, fileId, { reason });
      if (updated && !updated.hasOriginal) {
        freed += beforeBytes;
      }
    }
    return freed;
  }

  /**
   * Read a single file descriptor without loading any blob payloads.
   *
   * @param {{type: 'chat'|'task'|'user', id: string}} scope
   * @param {string} fileId
   * @returns {Promise<Object|null>}
   */
  async getDescriptor(scope, fileId) {
    const target = this._scope(scope, 'getDescriptor');
    if (!target || !isValidId(fileId)) return null;
    const key = chatFileKey(target, fileId);
    if (!isValidId(key)) return null;
    const doc = await this.documents.get(CHAT_FILES_NAMESPACE, key);
    const data = doc?.data;
    if (!data || (data.scope && !sameScope(data.scope, target))) return null;
    return toFileDescriptor(fileId, data);
  }

  /**
   * Read the extracted text (and any scanned-PDF page images) of a stored file.
   *
   * @param {{type: 'chat'|'task'|'user', id: string}} scope
   * @param {string} fileId
   * @returns {Promise<Object|null>} `{ ...descriptor, text, pageImages }`
   */
  async getText(scope, fileId) {
    const target = this._scope(scope, 'getText');
    if (!target || !isValidId(fileId)) return null;
    const key = chatFileKey(target, fileId);
    if (!isValidId(key)) return null;
    const doc = await this.documents.get(CHAT_FILES_NAMESPACE, key);
    const data = doc?.data;
    if (!data || (data.scope && !sameScope(data.scope, target))) return null;

    const textBlob = await this.blobs.get(CHAT_FILE_BLOBS_NAMESPACE, textBlobKey(key));
    const text = textBlob?.data ? textBlob.data.toString('utf8') : '';

    let pageImages = null;
    if (data.pageImageCount > 0) {
      const pagesBlob = await this.blobs.get(CHAT_FILE_BLOBS_NAMESPACE, pagesBlobKey(key));
      if (pagesBlob?.data) {
        try {
          pageImages = JSON.parse(pagesBlob.data.toString('utf8'));
        } catch {
          pageImages = null;
        }
      }
    }

    return {
      ...toFileDescriptor(fileId, data),
      text,
      ...(Array.isArray(pageImages) && pageImages.length > 0 ? { pageImages } : {})
    };
  }

  /**
   * Read the original binary payload of a stored file.
   *
   * When the file metadata exists but the original binary was never stored or
   * has been discarded by TTL / quota eviction, returns `{ ...descriptor,
   * discarded: true, data: null }` so callers can answer `410 ORIGINAL_DISCARDED`.
   *
   * @param {{type: 'chat'|'task'|'user', id: string}} scope
   * @param {string} fileId
   * @returns {Promise<Object|null>}
   */
  async getOriginal(scope, fileId) {
    const target = this._scope(scope, 'getOriginal');
    if (!target || !isValidId(fileId)) return null;
    const key = chatFileKey(target, fileId);
    if (!isValidId(key)) return null;
    const doc = await this.documents.get(CHAT_FILES_NAMESPACE, key);
    const data = doc?.data;
    if (!data || (data.scope && !sameScope(data.scope, target))) return null;

    const descriptor = toFileDescriptor(fileId, data);
    if (!data.hasOriginal) {
      return {
        ...descriptor,
        discarded: true,
        data: null
      };
    }

    const blob = await this.blobs.get(CHAT_FILE_BLOBS_NAMESPACE, originalBlobKey(key));
    if (!blob?.data) {
      return {
        ...descriptor,
        hasOriginal: false,
        discarded: true,
        data: null
      };
    }

    return {
      ...descriptor,
      discarded: false,
      data: blob.data
    };
  }

  /**
   * Discard only the original binary blob of a file while preserving its
   * metadata document and extracted text blob.
   *
   * @param {{type: 'chat'|'task'|'user', id: string}} scope
   * @param {string} fileId
   * @param {{reason?: string, now?: string}} [options]
   * @returns {Promise<Object|null>} Updated descriptor, or null if not found.
   */
  async discardOriginal(scope, fileId, { reason = 'manual', now = new Date().toISOString() } = {}) {
    const target = this._scope(scope, 'discardOriginal');
    if (!target || !isValidId(fileId)) return null;
    const key = chatFileKey(target, fileId);
    if (!isValidId(key)) return null;
    const doc = await this.documents.get(CHAT_FILES_NAMESPACE, key);
    const data = doc?.data;
    if (!data || (data.scope && !sameScope(data.scope, target))) return null;

    this._serverBytes = null;
    await this.blobs.delete(CHAT_FILE_BLOBS_NAMESPACE, originalBlobKey(key)).catch(error => {
      this.logger.warn('Failed to delete original binary blob during discardOriginal', {
        component: COMPONENT,
        key,
        error: error.message
      });
    });

    const textBytes = Number.isFinite(data.textBytes) ? data.textBytes : 0;
    const updated = {
      ...data,
      hasOriginal: false,
      originalBytes: 0,
      bytes: textBytes,
      originalDeletedAt: now,
      originalDeleteReason: reason
    };
    await this.documents.put(
      CHAT_FILES_NAMESPACE,
      key,
      updated,
      data.ownerId ? { ownerId: String(data.ownerId) } : {}
    );
    return toFileDescriptor(fileId, updated);
  }

  /**
   * Sweep expired original binary blobs across `chat`-scoped files older than
   * `originalRetentionDays` (default 14 days).
   *
   * - `task`-scoped files are never touched by age-based TTL (Q6).
   * - Extracted text blobs are kept so multi-turn chat and replay continue to work (Q2).
   *
   * @param {Object} [options]
   * @param {number} [options.originalRetentionDays]
   * @param {Set<string>} [options.retainedFileIds] - File IDs pinned by active shares.
   * @param {() => number} [options.now]
   * @returns {Promise<{discarded: number}>}
   */
  async discardExpiredOriginals({
    originalRetentionDays = this.policy().originalRetentionDays,
    retainedFileIds = new Set(),
    now = Date.now
  } = {}) {
    if (!this.isAvailable() || !(originalRetentionDays > 0)) return { discarded: 0 };
    const cutoff = now() - originalRetentionDays * DAY_MS;
    const nowIso = new Date(now()).toISOString();
    const docs = await this._listAllDocs();
    let discarded = 0;

    for (const doc of docs) {
      const data = doc?.data;
      if (!data || data.hasOriginal !== true) continue;
      // Task files live as long as the task (Q6).
      if (data.scope?.type === 'task') continue;
      const prefix = scopePrefix(data.scope);
      const fileId = doc.key.startsWith(prefix) ? doc.key.slice(prefix.length) : null;
      if (!fileId || retainedFileIds.has(fileId)) continue;
      const createdMs = Date.parse(data.createdAt);
      if (!Number.isFinite(createdMs) || createdMs >= cutoff) continue;

      const updated = await this.discardOriginal(data.scope, fileId, {
        reason: 'ttl_expired',
        now: nowIso
      });
      if (updated && !updated.hasOriginal) discarded += 1;
    }

    return { discarded };
  }

  /**
   * List all files in a scope, newest first, as descriptors without payloads.
   *
   * @param {{type: 'chat'|'task'|'user', id: string}} scope
   * @returns {Promise<Array<Object>>}
   */
  async list(scope) {
    const target = this._scope(scope, 'list');
    if (!target) return [];
    const prefix = scopePrefix(target);
    const entries = [];
    for (const doc of await this._scanScopeDocs(target, { includeData: true })) {
      if (!doc.data || (doc.data.scope && !sameScope(doc.data.scope, target))) continue;
      entries.push(toFileDescriptor(doc.key.slice(prefix.length), doc.data));
    }
    entries.sort((a, b) => ((a.createdAt || '') < (b.createdAt || '') ? 1 : -1));
    return entries;
  }

  /**
   * The file of a scope that was made from the item `meta[key] === value` — how an
   * e-mail, a meeting or a web page that is sent with every turn is stored once
   * per chat.
   *
   * @param {{type: 'chat'|'task'|'user', id: string}} scope
   * @param {string} key - Field of `meta` (`itemId`, `url`).
   * @param {string} value
   * @returns {Promise<Object|null>} The newest matching descriptor.
   */
  async findByMeta(scope, key, value) {
    if (typeof key !== 'string' || !key || typeof value !== 'string' || !value) return null;
    const items = await this.list(scope);
    return items.find(item => item.meta?.[key] === value) || null;
  }

  /**
   * Delete one file (metadata + all blobs).
   *
   * @param {{type: 'chat'|'task'|'user', id: string}} scope
   * @param {string} fileId
   * @returns {Promise<boolean>}
   */
  async delete(scope, fileId) {
    const target = this._scope(scope, 'delete');
    if (!target || !isValidId(fileId)) return false;
    const key = chatFileKey(target, fileId);
    if (!isValidId(key)) return false;
    return this._deleteKey(key, target);
  }

  /**
   * Delete named files in a scope.
   *
   * @param {{type: 'chat'|'task'|'user', id: string}} scope
   * @param {string[]} fileIds
   * @returns {Promise<number>}
   */
  async deleteMany(scope, fileIds) {
    const target = this._scope(scope, 'deleteMany');
    if (!target) return 0;
    let removed = 0;
    for (const fileId of fileIds || []) {
      if (!isValidId(fileId)) continue;
      const key = chatFileKey(target, fileId);
      if (!isValidId(key)) continue;
      if (await this._deleteKey(key, target)) removed += 1;
    }
    return removed;
  }

  /**
   * Delete every file in a scope (metadata documents + `.txt`, `.bin`, `.pages` blobs).
   *
   * @param {{type: 'chat'|'task'|'user', id: string}} scope
   * @returns {Promise<number>}
   */
  async deleteScope(scope) {
    const target = this._scope(scope, 'deleteScope');
    if (!target) return 0;
    const docKeys = new Set();
    for (const doc of await this._scanScopeDocs(target, { includeData: false })) {
      docKeys.add(doc.key);
    }
    let removed = 0;
    for (const key of docKeys) {
      if (await this._deleteKey(key, target)) removed += 1;
    }
    // Also sweep any orphaned blobs under the scope prefix whose metadata doc never landed.
    for (const blobKey of await this._scanScopeBlobs(target)) {
      try {
        await this.blobs.delete(CHAT_FILE_BLOBS_NAMESPACE, blobKey);
      } catch {
        // Best-effort cleanup.
      }
    }
    return removed;
  }

  async _deleteKey(key, scope) {
    this._serverBytes = null;
    let removed = false;
    try {
      removed = await this.documents.delete(CHAT_FILES_NAMESPACE, key);
    } catch (error) {
      this.logger.error('Failed to delete chat file metadata document', {
        component: COMPONENT,
        scopeType: scope.type,
        scopeId: scope.id,
        key,
        error: error.message
      });
    }
    for (const blobKey of [textBlobKey(key), originalBlobKey(key), pagesBlobKey(key)]) {
      try {
        if (await this.blobs.delete(CHAT_FILE_BLOBS_NAMESPACE, blobKey)) removed = true;
      } catch (error) {
        this.logger.error('Failed to delete chat file blob', {
          component: COMPONENT,
          scopeType: scope.type,
          scopeId: scope.id,
          blobKey,
          error: error.message
        });
      }
    }
    return removed;
  }

  async _scanScopeDocs(scope, { includeData = false } = {}) {
    const prefix = scopePrefix(scope);
    const docs = [];
    try {
      if (this.documents.supportsScan) {
        for await (const doc of this.documents.scan(CHAT_FILES_NAMESPACE, {
          prefix,
          includeData
        })) {
          docs.push(doc);
        }
      } else {
        let cursor = null;
        do {
          const page = await this.documents.list(CHAT_FILES_NAMESPACE, {
            prefix,
            includeData,
            cursor
          });
          for (const doc of page.items || []) docs.push(doc);
          cursor = page.nextCursor || null;
        } while (cursor);
      }
    } catch (error) {
      this.logger.error("Failed to enumerate a scope's chat files", {
        component: COMPONENT,
        scopeType: scope.type,
        scopeId: scope.id,
        error: error.message
      });
      return [];
    }
    return docs.filter(doc => !doc.key.slice(prefix.length).includes(KEY_SEPARATOR));
  }

  async _scanScopeBlobs(scope) {
    const prefix = scopePrefix(scope);
    const keys = [];
    try {
      let cursor = null;
      do {
        const page = await this.blobs.list(CHAT_FILE_BLOBS_NAMESPACE, { prefix, cursor });
        for (const item of page.items || []) keys.push(item.key);
        cursor = page.nextCursor || null;
      } while (cursor);
    } catch (error) {
      this.logger.error("Failed to enumerate a scope's chat file blobs", {
        component: COMPONENT,
        scopeType: scope.type,
        scopeId: scope.id,
        error: error.message
      });
      return [];
    }
    return keys.filter(key => !key.slice(prefix.length).includes(KEY_SEPARATOR));
  }

  async _listOwnerDocs(ownerId) {
    const docs = [];
    try {
      let cursor = null;
      do {
        const page = await this.documents.list(CHAT_FILES_NAMESPACE, {
          ownerId: String(ownerId),
          limit: SCAN_PAGE_SIZE,
          includeData: true,
          ...(cursor ? { cursor } : {})
        });
        for (const doc of page.items || []) {
          if (doc?.data) docs.push(doc);
        }
        cursor = page.nextCursor || null;
      } while (cursor);
    } catch (error) {
      this.logger.error('Failed to list owner chat files for quota check', {
        component: COMPONENT,
        error: error.message
      });
    }
    return docs;
  }

  async _listAllDocs() {
    const docs = [];
    try {
      let cursor = null;
      do {
        const page = await this.documents.list(CHAT_FILES_NAMESPACE, {
          limit: SCAN_PAGE_SIZE,
          includeData: true,
          ...(cursor ? { cursor } : {})
        });
        for (const doc of page.items || []) {
          if (doc?.data) docs.push(doc);
        }
        cursor = page.nextCursor || null;
      } while (cursor);
    } catch (error) {
      this.logger.error('Failed to list server chat files', {
        component: COMPONENT,
        error: error.message
      });
    }
    return docs;
  }
}

let cachedRepository = null;
let cachedProvider = null;

/**
 * Process-wide `ChatFileRepository`, rebuilt when the storage provider changes.
 *
 * @returns {ChatFileRepository}
 */
export function getChatFileRepository() {
  const provider = getStorage();
  if (!cachedRepository || cachedProvider !== provider) {
    cachedProvider = provider;
    cachedRepository = new ChatFileRepository({
      documents: readFacet(provider, 'documents'),
      blobs: readFacet(provider, 'blobs'),
      logger
    });
  }
  return cachedRepository;
}

export default ChatFileRepository;
