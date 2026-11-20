// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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
 * | `openRead`| file read stream  | `GetObject` body| read in pieces      |
 * | `putStream`| temp file, rename| one `PutObject` | write in pieces     |
 * | `delete`  | unlink            | `DeleteObject`  | delete              |
 * | `list`    | readdir + filter  | `ListObjectsV2` | `LIKE` on key       |
 * | `scan`    | one readdir, lazy | paged `list`    | cursor over a query |
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
 * ## Whole or as a stream
 *
 * `get` and `put` hold the payload in memory, which is right for what ends up
 * in memory anyway (extracted text for a prompt, a JSON pack). Bytes that go
 * straight to an HTTP response, a file or another store use
 * {@link BlobStore#openRead} and {@link BlobStore#putStream}: the same
 * objects, the same stored format, a bounded amount of memory whatever the
 * object's size. A blob written with one is read with either.
 *
 * **A consumer of `openRead` must handle a failure after data arrived.** The
 * stream hands out bytes before the object is read to its end. A store that
 * authenticates what it reads (the encrypting blob store) hands out a piece
 * only after that piece verified, but only the end of the stream says that
 * nothing is missing: an object that was cut, extended or changed in a later
 * part makes the stream fail with `'error'` (the error `get` would have
 * thrown: `CORRUPT_BLOB`, `KEY_UNAVAILABLE`, `STORAGE_UNAVAILABLE`) after
 * earlier, genuine bytes were delivered. It never ends cleanly instead. So:
 *
 * - Treat the content as received only on `'end'`. On `'error'`, discard what
 *   was collected or mark the copy as failed.
 * - An HTTP handler that pipes the stream **destroys the response**
 *   (`res.destroy(error)`) when the stream fails after the first byte, so the
 *   client sees an aborted transfer (a `Content-Length` that was not met).
 *   It never calls `res.end()` on a failed stream: that would present a
 *   truncated body as the whole file. `utils/streamResponse.js` does this.
 * - Always consume the stream to its end or `destroy()` it. An abandoned
 *   stream holds a file handle or a connection until the backend's idle
 *   timeout ends it.
 * - Learn of a failure through `for await`, `stream.pipeline`,
 *   `stream.finished` or `sendStream`, not through an `'error'` listener
 *   alone. The stream may have failed before the code that awaited
 *   `openRead` ran again, and an `'error'` event is emitted once. Every store
 *   keeps such an early failure from becoming an uncaught exception
 *   (`guardStream` in `blobSupport.js`); it stays readable as
 *   `stream.errored`.
 *
 * A provider that implements this declares `blobStore: true` in
 * {@link StorageProvider#getCapabilities}. That is a different capability from
 * `blobs`, which says the *append log* can park payloads beside a stream — the
 * run ledger's spill files. The two are unrelated stores.
 *
 * @module storage/BlobStore
 */
import { Readable } from 'node:stream';
import { assertStreamLength, collectStream } from './blobSupport.js';
import { InvalidKeyError, NotSupportedError } from './errors.js';

/** Page size the base {@link BlobStore#scan} walks `list` with (its maximum). */
const SCAN_PAGE_SIZE = 1000;

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
 * A blob opened for reading.
 *
 * @typedef {Object} BlobReadStream
 * @property {string} key - Key it is read from.
 * @property {number} bytes - Size of the payload, known before the first
 *   byte is read (what a `Content-Length` is set from). The stream delivers
 *   exactly this many bytes or fails.
 * @property {import('node:stream').Readable} stream - The payload. Not
 *   flowing yet; see the module note for what its consumer owes.
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
   * Open one blob for reading as a stream, without holding it in memory.
   *
   * Resolves once the store knows that the blob is there, how long its
   * payload is and that it can be read: a missing blob is `null`, and a blob
   * this store cannot open at all (plaintext where ciphertext is expected, a
   * key that is not here, a first part that does not verify) rejects here,
   * with the error {@link BlobStore#get} throws, before the caller has
   * promised anything. A failure further in arrives as the stream's
   * `'error'`; **read the module note** for what the consumer must do then.
   *
   * This base implementation reads the blob whole with `get` and wraps it, so
   * every store has the method; a store overrides it to actually stream.
   *
   * @param {string} ns - Namespace.
   * @param {string} key - Key within the namespace.
   * @returns {Promise<BlobReadStream|null>} The open blob, or null when there is none.
   *
   * @example
   * const blob = await blobs.openRead('artifacts', key);
   * if (!blob) throw notFound();
   * res.setHeader('Content-Length', String(blob.bytes));
   * await pipeToResponse(req, res, blob.stream); // destroys `res` on a late failure
   */
  async openRead(ns, key) {
    const blob = await this.get(ns, key);
    if (!blob) return null;
    return { key, bytes: blob.bytes, stream: Readable.from([blob.data], { objectMode: false }) };
  }

  /**
   * Store a blob from a stream, replacing whatever was at that key: `put` for
   * a payload that is not in memory.
   *
   * The length is declared up front (`opts.bytes`): an object store needs it
   * before the first byte, and it is what the size limit is checked against.
   * A stream that delivers more or fewer bytes, or fails, rejects the call
   * and leaves the key as it was (the previous blob, or none). The stream is
   * consumed or destroyed either way.
   *
   * One attempt: a stream cannot be read twice, so a backend does not retry a
   * failed transfer as it does for `put`. A caller that can open its source
   * again retries the call.
   *
   * This base implementation collects the stream and calls `put`.
   *
   * @param {string} ns - Namespace.
   * @param {string} key - Key within the namespace.
   * @param {import('node:stream').Readable} stream - The payload, as bytes.
   * @param {Object} opts
   * @param {number} opts.bytes - Length of the payload.
   * @param {string} [opts.contentType] - Media-type hint; see the module note.
   * @returns {Promise<BlobRef>} Length and SHA-256 of the payload, as `put` reports them.
   * @throws {StorageError} Code `INVALID_DATA` when `opts.bytes` is missing or
   *   the stream has another length.
   */
  async putStream(ns, key, stream, opts = {}) {
    const bytes = assertStreamLength(opts?.bytes, stream);
    const data = await collectStream(stream, bytes, `${ns}/${key}`);
    return this.put(ns, key, data, opts?.contentType ? { contentType: opts.contentType } : {});
  }

  /**
   * Remove one blob.
   *
   * @param {string} _ns - Namespace.
   * @param {string} _key - Key within the namespace.
   * @returns {Promise<boolean>} True when a blob was removed, false when there
   *   was nothing at that key — a delete is idempotent, never an error. Of
   *   deletes racing each other, only one reports true.
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

  /**
   * Every blob key in a namespace, in ascending key order, as a stream.
   *
   * The walk counterpart to {@link BlobStore#list}, as
   * {@link module:storage/DocumentStore~DocumentStore#scan} is to the document
   * listing. `list` takes a cursor and returns one page; a caller that wants
   * the whole namespace (an orphan sweep, a scope delete) paging it has every
   * page re-establish where it is, and on the filesystem provider that means
   * re-reading and re-sorting the whole directory per page — O(N) per page
   * instead of O(N) in total.
   *
   * The contract is the order and the completeness, not the mechanism: the
   * same keys `list` would return across all its pages, in the same order
   * (plain code-unit comparison), each with its size and never its payload.
   * A blob deleted while the walk runs may be skipped; a blob written while it
   * runs may or may not appear. Deleting the blob just yielded is safe.
   *
   * This base implementation pages {@link BlobStore#list}, so every provider
   * has it; a provider overrides it only to make it cheaper.
   *
   * @param {string} ns - Namespace.
   * @param {Object} [opts]
   * @param {string} [opts.prefix] - Keep only keys starting with this.
   * @yields {{key: string, bytes: number}} Keys in ascending order.
   */
  async *scan(ns, opts = {}) {
    const { prefix } = opts || {};
    let cursor = null;
    do {
      const page = await this.list(ns, {
        ...(prefix ? { prefix } : {}),
        limit: SCAN_PAGE_SIZE,
        ...(cursor ? { cursor } : {})
      });
      yield* page.items;
      cursor = page.nextCursor || null;
    } while (cursor);
  }

  /**
   * Remove every blob whose key starts with `prefix` — the blob counterpart of
   * {@link module:storage/DocumentStore~DocumentStore#deletePrefix}, with the
   * same `startsWith` match, idempotence and refusal of an empty prefix.
   *
   * @param {string} ns - Namespace.
   * @param {string} prefix - Key prefix; must not be empty.
   * @returns {Promise<number>} How many blobs were removed.
   * @throws {InvalidKeyError} When `prefix` is empty.
   */
  async deletePrefix(ns, prefix) {
    if (typeof prefix !== 'string' || prefix.length === 0) {
      throw new InvalidKeyError('deletePrefix needs a non-empty prefix');
    }
    const keys = [];
    for await (const item of this.scan(ns, { prefix })) keys.push(item.key);
    let removed = 0;
    for (const key of keys) if (await this.delete(ns, key)) removed++;
    return removed;
  }

  /**
   * Whether {@link BlobStore#scan} is available. True for every subclass —
   * the base implementation works over `list` — and only declared so
   * `storage/walk.js` can tell a real store from a hand-written test double
   * that has `list` and nothing else.
   *
   * @returns {boolean} true
   */
  get supportsScan() {
    return true;
  }
}

export default BlobStore;
