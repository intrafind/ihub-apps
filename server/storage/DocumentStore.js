/**
 * DocumentStore — the document facet of a storage provider.
 *
 * A namespaced key/value store for JSON documents with owner metadata,
 * conditional writes and cursor paging. It is deliberately narrow: the domain
 * repositories built on top (chats, runs, workflow state, …) express their
 * queries as "one document by key" or "this owner's documents in key order",
 * because that is the intersection every backend — a directory tree, a
 * relational table, a search index — can serve without a full scan.
 *
 * This class is the written contract, not an implementation: every method
 * throws {@link NotSupportedError}. Providers extend it and prove they honour
 * the semantics documented here by passing the conformance suite in
 * `server/storage/__tests__/providerConformance.js`.
 *
 * @module storage/DocumentStore
 */
import { NotSupportedError } from './errors.js';

/**
 * A stored document with its metadata.
 *
 * `etag` and `size` are derived from the document's data rather than chosen by
 * the provider, so two providers holding the same data report the same etag —
 * a conditional write keeps working across a migration between backends.
 *
 * @typedef {Object} Document
 * @property {string} ns - Namespace the document lives in.
 * @property {string} key - Key within the namespace.
 * @property {string|null} ownerId - Owning principal, or null when unowned.
 * @property {string} contentType - MIME type; defaults to 'application/json'
 *   on the first write and is carried over by an overwrite that does not name
 *   one.
 * @property {string} createdAt - ISO-8601 timestamp of the first write.
 * @property {string} updatedAt - ISO-8601 timestamp of the most recent write.
 * @property {string} etag - sha256 hex of `JSON.stringify(data)`.
 * @property {number} size - `Buffer.byteLength(JSON.stringify(data), 'utf8')`.
 * @property {any} [data] - The document body; omitted (undefined) when the
 *   document came from a `list({ includeData: false })`.
 */

/**
 * Options for {@link DocumentStore#put}.
 *
 * @typedef {Object} PutOptions
 * @property {string|null} [ownerId] - Owning principal. Absent on an overwrite
 *   keeps the stored owner; an explicit `null` clears it. Implementations must
 *   tell the two apart with `'ownerId' in opts`.
 * @property {string|null} [etag] - Conditional-write guard; see the three
 *   modes on {@link DocumentStore#put}.
 * @property {string} [contentType] - MIME type. Absent on an overwrite keeps
 *   the stored content type, the same rule `ownerId` follows; absent on a
 *   create it defaults to 'application/json'. A document written as
 *   `text/html` therefore stays `text/html` across a metadata-only rewrite
 *   instead of silently becoming JSON.
 */

/**
 * Options for {@link DocumentStore#list}.
 *
 * @typedef {Object} ListOptions
 * @property {string} [ownerId] - Restrict to one owner's documents. Must be
 *   served from an index, never by scanning the namespace.
 * @property {string} [prefix] - Keep only keys matching
 *   `String.prototype.startsWith(prefix)`.
 * @property {number} [limit=100] - Page size. Clamped to 1000, never rejected.
 * @property {string} [cursor] - Opaque cursor from a previous page.
 * @property {boolean} [includeData=true] - When false, `data` is omitted from
 *   every returned document while the metadata stays complete.
 */

/**
 * One page of {@link DocumentStore#list}.
 *
 * @typedef {Object} ListResult
 * @property {Document[]} items - The page, in ascending key order.
 * @property {string|null} nextCursor - Cursor for the next page, or null when
 *   this page was the last one.
 */

/**
 * Abstract document facet. Extend it; do not instantiate it.
 */
export class DocumentStore {
  /**
   * Read one document.
   *
   * @param {string} ns - Namespace.
   * @param {string} key - Key within the namespace.
   * @returns {Promise<Document|null>} The document, or null when it does not exist.
   * @throws {InvalidKeyError} When `ns` or `key` is not a usable identifier.
   */
  async get(_ns, _key) {
    throw new NotSupportedError('DocumentStore.get is not implemented');
  }

  /**
   * Create or replace a document.
   *
   * Conditional-write modes, selected by `opts.etag`:
   * - **omitted / `undefined`** — unconditional create-or-overwrite.
   * - **a string** — compare-and-set: throws {@link EtagMismatchError} unless
   *   the document exists and its etag equals the given one.
   * - **`null`** — create-only: throws {@link EtagMismatchError} when the
   *   document already exists.
   *
   * A failed conditional write must leave the stored document untouched.
   *
   * `createdAt` is carried over from the stored document on an overwrite;
   * `updatedAt` is always set to now. `data` must be JSON-serializable and must
   * not be `undefined` — a {@link StorageError} with code `INVALID_DATA` is
   * thrown rather than persisting an empty document, because `undefined` is the
   * shape a caller gets from a typo'd property and silently storing it would
   * destroy the previous content.
   *
   * Publishes `{ type: 'document.put', ns, key, ownerId }` on the provider's
   * {@link ChangeNotifier}.
   *
   * @param {string} ns - Namespace.
   * @param {string} key - Key within the namespace.
   * @param {any} data - JSON-serializable document body.
   * @param {PutOptions} [opts] - Owner, conditional-write guard, content type.
   * @returns {Promise<Document>} The stored document, identical to what a
   *   following `get(ns, key)` returns.
   * @throws {InvalidKeyError} When `ns` or `key` is not a usable identifier.
   * @throws {EtagMismatchError} When the conditional write lost.
   * @throws {StorageError} Code `INVALID_DATA` when `data` is undefined or not
   *   serializable.
   */
  async put(_ns, _key, _data, _opts = {}) {
    throw new NotSupportedError('DocumentStore.put is not implemented');
  }

  /**
   * Remove a document and its index entries.
   *
   * Publishes `{ type: 'document.delete', ns, key, ownerId }` on the provider's
   * {@link ChangeNotifier} — but only when something was actually removed, so
   * subscribers never see a delete for a document that never existed.
   *
   * @param {string} ns - Namespace.
   * @param {string} key - Key within the namespace.
   * @returns {Promise<boolean>} True when a document was removed, false when
   *   there was nothing to remove.
   * @throws {InvalidKeyError} When `ns` or `key` is not a usable identifier.
   */
  async delete(_ns, _key) {
    throw new NotSupportedError('DocumentStore.delete is not implemented');
  }

  /**
   * List a namespace, one page at a time.
   *
   * Ordering is **ascending by key**, compared with plain `<` on the string,
   * and is provider-independent so that paging a namespace is reproducible
   * across backends.
   *
   * `limit` defaults to 100 and is clamped to 1000 rather than rejected — a
   * caller asking for too much gets a smaller page, not an error.
   * `nextCursor` is opaque: passing it back returns the following page with no
   * gaps and no repeats, and it is `null` on the last page. An unparseable
   * cursor throws a {@link StorageError} with code `INVALID_CURSOR`.
   *
   * An unknown namespace lists as `{ items: [], nextCursor: null }`, never an
   * error — callers list namespaces before anything has been written to them.
   *
   * @param {string} ns - Namespace.
   * @param {ListOptions} [opts] - Owner filter, prefix, paging, data inclusion.
   * @returns {Promise<ListResult>} One page plus the cursor for the next.
   * @throws {InvalidKeyError} When `ns` is not a usable identifier.
   * @throws {StorageError} Code `INVALID_CURSOR` when `opts.cursor` is not a
   *   cursor this store issued.
   */
  async list(_ns, _opts = {}) {
    throw new NotSupportedError('DocumentStore.list is not implemented');
  }
}
