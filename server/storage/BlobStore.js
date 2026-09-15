/**
 * BlobStore — the binary facet of a storage provider.
 *
 * Documents are for things you read, list and compare: small, structured, and
 * cheap to re-serialize. A **blob** is the opposite — the bytes of a generated
 * image, an uploaded file, a report — megabytes that are written once, read
 * whole, and never merged. Putting those in a document store is what forces
 * base64 (a 33% tax), puts megabytes in a JSONB column, and makes an
 * S3-compatible backend impossible to slot in: S3 stores objects, not rows.
 *
 * So blobs get their own facet, addressed by `(namespace, key)` with no
 * envelope and no encoding. That is deliberately the smallest surface every
 * candidate backend already has:
 *
 * | Operation | Filesystem        | S3-compatible   | PostgreSQL          |
 * | --------- | ----------------- | --------------- | ------------------- |
 * | `put`     | atomic file write | `PutObject`     | large object/`bytea`|
 * | `get`     | read file         | `GetObject`     | read                |
 * | `delete`  | unlink            | `DeleteObject`  | delete              |
 * | `list`    | readdir + filter  | `ListObjectsV2` | `LIKE` on key       |
 *
 * Nothing here is provider-specific and nothing needs a transaction, so a
 * domain repository written against this interface keeps working when an
 * operator moves `platform.storage.provider` from filesystem to something
 * that scales past one volume — issue #2318.
 *
 * **Metadata is not this facet's job.** A blob is bytes and a length; what the
 * bytes *are* — media type, display name, who produced them, when — belongs in
 * a document beside them, where it can be listed and filtered without reading
 * a single payload. `contentType` may be passed to {@link BlobStore#put} as a
 * hint that an object store can persist on the object itself (S3 sets it so a
 * presigned URL serves correctly); the document remains authoritative, and a
 * provider that cannot store it simply ignores it.
 *
 * A provider that implements this declares `blobStore: true` in
 * {@link StorageProvider#getCapabilities}. That is a different capability from
 * `blobs`, which says the *append log* can park payloads beside a stream — the
 * run ledger's spill files. The two are unrelated stores.
 *
 * @module storage/BlobStore
 */
import { NotSupportedError } from './errors.js';

/**
 * What a blob write reports back.
 *
 * @typedef {Object} BlobRef
 * @property {string} key - Key it was stored under.
 * @property {number} bytes - Size of the payload as stored.
 * @property {string} sha256 - Hex digest of the payload. The caller may record
 *   it beside its own metadata; this facet does not keep one, because a store
 *   that has to read a blob to describe it is a store that cannot list.
 */

/**
 * A blob read back.
 *
 * @typedef {Object} Blob
 * @property {string} key - Key it was read from.
 * @property {number} bytes - Size of the payload.
 * @property {Buffer} data - The payload itself.
 */

/**
 * Abstract blob facet. Extend it; do not instantiate it.
 */
export class BlobStore {
  /**
   * Store a blob, replacing whatever was at that key.
   *
   * Writes are whole-payload and last-writer-wins: there is no compare-and-set
   * here, because the callers this facet exists for mint a fresh key per write
   * and never modify a stored blob.
   *
   * @param {string} _ns - Namespace, e.g. `artifacts`.
   * @param {string} _key - Key within the namespace.
   * @param {Buffer|Uint8Array|string} _data - The payload. A string is stored
   *   as UTF-8; pass a Buffer for anything binary.
   * @param {Object} [_opts]
   * @param {string} [_opts.contentType] - Media-type hint; see the module note.
   * @returns {Promise<BlobRef>}
   * @abstract
   */
  async put(_ns, _key, _data, _opts = {}) {
    throw new NotSupportedError('BlobStore.put is not implemented');
  }

  /**
   * Read one blob whole.
   *
   * @param {string} _ns - Namespace.
   * @param {string} _key - Key within the namespace.
   * @returns {Promise<Blob|null>} The blob, or null when there is none.
   * @abstract
   */
  async get(_ns, _key) {
    throw new NotSupportedError('BlobStore.get is not implemented');
  }

  /**
   * Remove one blob.
   *
   * @param {string} _ns - Namespace.
   * @param {string} _key - Key within the namespace.
   * @returns {Promise<boolean>} True when a blob was removed, false when there
   *   was nothing at that key — a delete is idempotent, never an error.
   * @abstract
   */
  async delete(_ns, _key) {
    throw new NotSupportedError('BlobStore.delete is not implemented');
  }

  /**
   * List the keys in a namespace, without their payloads.
   *
   * The prefix filter is what lets a caller sweep everything belonging to one
   * owner — and find a blob whose metadata document never landed, which is
   * otherwise unreachable. Every candidate backend supports it natively.
   *
   * @param {string} _ns - Namespace.
   * @param {Object} [_opts]
   * @param {string} [_opts.prefix] - Keep only keys starting with this.
   * @param {number} [_opts.limit] - Page size.
   * @param {string} [_opts.cursor] - Cursor from a previous page.
   * @returns {Promise<{items: Array<{key: string, bytes: number}>, nextCursor: string|null}>}
   * @abstract
   */
  async list(_ns, _opts = {}) {
    throw new NotSupportedError('BlobStore.list is not implemented');
  }
}

export default BlobStore;
