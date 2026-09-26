/**
 * Uploads made through `POST /api/v1/attachments`, held until a chat message
 * references them.
 *
 * The bytes go to the storage provider's blob facet and a small metadata
 * document sits beside them (namespace `api-attachments`, both keyed by the
 * attachment id and owned by the uploader), so an upload made on one worker
 * can be used by a request another worker serves. Without a storage provider
 * the store keeps a bounded in-memory copy on the worker that received the
 * upload.
 *
 * Attachments expire after {@link ATTACHMENT_TTL_MS}; a sweep removes what is
 * past its time.
 *
 * @module services/api/attachmentStore
 */
import { randomUUID } from 'crypto';
import { getStorage, readFacet } from '../../storage/bootstrap.js';
import { RUNTIME_NAMESPACES } from '../../storage/namespaces.js';
import logger from '../../utils/logger.js';
import { sha256Hex } from './attachmentProcessing.js';

const COMPONENT = 'ApiAttachmentStore';

export const API_ATTACHMENTS_NAMESPACE = RUNTIME_NAMESPACES.apiAttachments;

/** How long an upload waits to be used. */
export const ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;
/** Bytes kept in memory per worker when no storage provider is available. */
export const MEMORY_BYTES_CAP = 256 * 1024 * 1024;
/** Documents looked at per sweep. */
const SWEEP_PAGE_SIZE = 200;

/** Whether a string is an attachment id this store minted. */
export function isAttachmentId(value) {
  return typeof value === 'string' && /^att_[a-f0-9]{32}$/.test(value);
}

export class ApiAttachmentStore {
  /**
   * @param {Object} [options]
   * @param {import('../../storage/DocumentStore.js').DocumentStore|null} [options.documents]
   * @param {import('../../storage/BlobStore.js').BlobStore|null} [options.blobs]
   * @param {() => number} [options.now]
   */
  constructor({ documents, blobs, now = () => Date.now() } = {}) {
    this._documents = documents;
    this._blobs = blobs;
    this._pinned = documents !== undefined || blobs !== undefined;
    this.now = now;
    /** @type {Map<string, {meta: Object, data: Buffer}>} */
    this.memory = new Map();
    this.memoryBytes = 0;
  }

  _facets() {
    if (this._pinned) return { documents: this._documents || null, blobs: this._blobs || null };
    const provider = getStorage();
    return { documents: readFacet(provider, 'documents'), blobs: readFacet(provider, 'blobs') };
  }

  _remember(meta, data) {
    this.memory.set(meta.id, { meta, data });
    this.memoryBytes += data.length;
    while (this.memoryBytes > MEMORY_BYTES_CAP && this.memory.size > 1) {
      const oldest = this.memory.keys().next().value;
      this._forget(oldest);
    }
  }

  _forget(id) {
    const entry = this.memory.get(id);
    if (!entry) return false;
    this.memory.delete(id);
    this.memoryBytes -= entry.data.length;
    return true;
  }

  /**
   * Store an upload.
   *
   * @param {Object} params
   * @param {string} params.ownerId - Uploading principal
   * @param {string} params.fileName
   * @param {string} params.mimeType
   * @param {Buffer} params.buffer
   * @returns {Promise<Object>} The attachment metadata `{ id, ownerId, fileName, mimeType, size, sha256, createdAt, expiresAt }`
   */
  async put({ ownerId, fileName, mimeType, buffer }) {
    const now = this.now();
    const meta = {
      id: `att_${randomUUID().replace(/-/g, '')}`,
      ownerId,
      fileName,
      mimeType,
      size: buffer.length,
      sha256: sha256Hex(buffer),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ATTACHMENT_TTL_MS).toISOString()
    };
    const { documents, blobs } = this._facets();
    if (documents && blobs) {
      try {
        await blobs.put(API_ATTACHMENTS_NAMESPACE, meta.id, buffer, { contentType: mimeType });
        await documents.put(API_ATTACHMENTS_NAMESPACE, meta.id, meta, { ownerId });
        return meta;
      } catch (error) {
        logger.warn('Attachment could not be persisted; kept in memory on this worker', {
          component: COMPONENT,
          id: meta.id,
          error: error.message
        });
      }
    }
    this._remember(meta, buffer);
    return meta;
  }

  /**
   * Read an attachment the owner uploaded.
   *
   * @param {string} id
   * @param {string} ownerId
   * @returns {Promise<{meta: Object, data: Buffer}|null>} null when unknown, expired or not the caller's
   */
  async get(id, ownerId) {
    if (!isAttachmentId(id)) return null;
    let entry = this.memory.get(id) || null;
    if (!entry) {
      const { documents, blobs } = this._facets();
      if (documents && blobs) {
        try {
          const doc = await documents.get(API_ATTACHMENTS_NAMESPACE, id);
          if (doc?.data?.id === id) {
            const blob = await blobs.get(API_ATTACHMENTS_NAMESPACE, id);
            if (blob?.data) entry = { meta: doc.data, data: blob.data };
          }
        } catch (error) {
          logger.warn('Attachment read failed', { component: COMPONENT, id, error: error.message });
        }
      }
    }
    if (!entry || entry.meta.ownerId !== ownerId) return null;
    if (Date.parse(entry.meta.expiresAt) <= this.now()) {
      await this.delete(id, ownerId);
      return null;
    }
    return entry;
  }

  /**
   * Remove an attachment the owner uploaded.
   * @param {string} id
   * @param {string} ownerId
   * @returns {Promise<boolean>}
   */
  async delete(id, ownerId) {
    if (!isAttachmentId(id)) return false;
    let removed = false;
    const local = this.memory.get(id);
    if (local && local.meta.ownerId === ownerId) removed = this._forget(id);
    const { documents, blobs } = this._facets();
    if (documents && blobs) {
      try {
        const doc = await documents.get(API_ATTACHMENTS_NAMESPACE, id);
        if (doc?.data && doc.data.ownerId === ownerId) {
          await blobs.delete(API_ATTACHMENTS_NAMESPACE, id);
          removed = (await documents.delete(API_ATTACHMENTS_NAMESPACE, id)) || removed;
        }
      } catch (error) {
        logger.warn('Attachment delete failed', { component: COMPONENT, id, error: error.message });
      }
    }
    return removed;
  }

  /**
   * Drop expired attachments: everything in memory, and one page of documents.
   * @returns {Promise<number>} How many were removed
   */
  async sweep() {
    const now = this.now();
    let removed = 0;
    for (const [id, entry] of this.memory) {
      if (Date.parse(entry.meta.expiresAt) <= now) {
        this._forget(id);
        removed += 1;
      }
    }
    const { documents, blobs } = this._facets();
    if (!documents || !blobs) return removed;
    try {
      const page = await documents.list(API_ATTACHMENTS_NAMESPACE, { limit: SWEEP_PAGE_SIZE });
      for (const doc of page.items || []) {
        const expiresAt = Date.parse(doc.data?.expiresAt || doc.updatedAt || 0);
        if (Number.isFinite(expiresAt) && expiresAt <= now) {
          await blobs.delete(API_ATTACHMENTS_NAMESPACE, doc.key);
          if (await documents.delete(API_ATTACHMENTS_NAMESPACE, doc.key)) removed += 1;
        }
      }
    } catch (error) {
      logger.warn('Attachment sweep failed', { component: COMPONENT, error: error.message });
    }
    return removed;
  }
}

let singleton = null;

/** The process-wide store the App API routes use. */
export function getApiAttachmentStore() {
  if (!singleton) singleton = new ApiAttachmentStore();
  return singleton;
}

/** Test seam. */
export function setApiAttachmentStoreForTests(store) {
  singleton = store;
}
