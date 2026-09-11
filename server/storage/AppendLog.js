/**
 * AppendLog — the append-only facet of a storage provider.
 *
 * Documents and event streams are separated on purpose: forcing a run ledger
 * through a document key/value interface (read-modify-write the whole history
 * per event) was the flaw of the earlier persistence design. A stream is
 * written by appending, read forward from a sequence number, and dropped whole.
 *
 * **Sequence allocation stays with the caller.** The live streaming path
 * assigns `seq` synchronously in memory (SSE projections depend on it being
 * available before the write completes); the log persists `(seq, entry)`
 * verbatim and answers `lastSeq()` for crash recovery. A provider never
 * allocates a sequence number.
 *
 * **A stream has one writer at a time, and enforcing that is the consumer's
 * job.** Caller-side allocation is only safe under that precondition, and no
 * provider can supply it through this interface: two processes that each read
 * `lastSeq('run:R') → 42` and allocate 43 are both making a legal call. Today
 * the run ledger holds the invariant itself, with cluster-bus ownership
 * routing plus the `runlog:<runId>` lease — Node cluster IPC and a lease the
 * filesystem provider reports as `advisory-single-machine`, so the reach is
 * one machine. **A provider that is multi-instance does not by itself make a
 * consumer multi-instance**: the ledger needs a distributed lock before it can
 * be, which is step 3, not a provider swap.
 *
 * If it happens anyway, a stream holding two records with one `seq` is a
 * caller error, not a state the log repairs. `read` returns both, in the order
 * they were persisted, because discarding one would hide the error and guess
 * which write was meant. (The run ledger's `mergeEventsBySeq` does collapse a
 * shared seq, but that is a different question — it merges two *backends*
 * across the storage upgrade, where the same event legitimately exists in
 * both, and it is not this contract.) A provider MAY reject a `seq` at or
 * below `lastSeq` with a {@link StorageError} of code `SEQ_CONFLICT`; a caller
 * that sees one re-reads `lastSeq` and re-allocates. The filesystem provider
 * does not, because it cannot do the check and the write atomically.
 *
 * This class is the written contract, not an implementation: every method
 * throws {@link NotSupportedError}. Providers extend it and prove they honour
 * the semantics documented here by passing the conformance suite in
 * `server/storage/__tests__/providerConformance.js`.
 *
 * @module storage/AppendLog
 */
import { NotSupportedError } from './errors.js';

/**
 * Reference to a blob stored beside a stream (a spilled large payload).
 *
 * @typedef {Object} BlobRef
 * @property {string} stream - Stream the blob belongs to.
 * @property {string} name - Blob name as stored (sanitized by the provider).
 * @property {number} bytes - Byte length of the stored content.
 * @property {string} sha256 - sha256 hex digest of the stored content.
 * @property {string} contentType - MIME type; defaults to
 *   'application/octet-stream'.
 */

/**
 * Options for {@link AppendLog#read}.
 *
 * @typedef {Object} ReadOptions
 * @property {number} [afterSeq=0] - Return only records with `seq` greater
 *   than this. 0 reads the stream from the beginning.
 * @property {number} [limit=Infinity] - Maximum number of records to return.
 */

/**
 * Options for {@link AppendLog#sweep}.
 *
 * @typedef {Object} SweepOptions
 * @property {Date|number} olderThan - Cut-off; streams last modified before it
 *   are removed. Accepts a Date or epoch milliseconds.
 * @property {string} [kind] - Sweep only streams whose name begins `\`${kind}:\``.
 *   Omitting it sweeps the whole store, which is only ever right for a store
 *   with one consumer. It has one today; the run ledger drives the sweep from
 *   its own `runLog.retentionDays`, and a second consumer's streams would be
 *   deleted on a retention policy that has nothing to do with them — and
 *   counted into the ledger's own `removed` total, so the log would not even
 *   show it happening.
 */

/**
 * Abstract append-log facet. Extend it; do not instantiate it.
 */
export class AppendLog {
  /**
   * Append one record to a stream.
   *
   * The persisted record is `{ ...entry, seq }` — a `seq` already present in
   * `entry` is overwritten by the argument, which is the single source of
   * truth for ordering.
   *
   * Writes may be buffered (see {@link AppendLog#flush}); resolving does not
   * guarantee the record is on durable storage yet, only that it is accepted
   * and will be visible to every read of this stream.
   *
   * @param {string} stream - Stream identifier, e.g. `run:<runId>`.
   * @param {Object} entry - The record body; must be JSON-serializable.
   * @param {number} seq - Caller-allocated positive integer sequence number.
   * The caller guarantees it is the stream's only writer (see the module
   * header); `seq` is not checked against what the stream already holds.
   *
   * @returns {Promise<{stream: string, seq: number}>} The accepted coordinates.
   * @throws {InvalidKeyError} When `stream` is not a usable identifier.
   * @throws {StorageError} Code `INVALID_SEQ` when `seq` is not a positive integer.
   * @throws {StorageError} Code `SEQ_CONFLICT` — optional; a provider that can
   *   check and write atomically may reject a `seq` at or below `lastSeq`
   *   rather than persist a duplicate.
   */
  async append(_stream, _entry, _seq) {
    throw new NotSupportedError('AppendLog.append is not implemented');
  }

  /**
   * Append several records to one stream in a single operation.
   *
   * Items are persisted in the order given, each with its own caller-allocated
   * sequence number, exactly as {@link AppendLog#append} would.
   *
   * **All-or-nothing on validation**: every item is checked before any of them
   * is accepted, so a bad sequence number in the middle of a batch leaves the
   * stream exactly as it was. A caller that retries a rejected batch whole must
   * not find the first half of it already persisted — that would put duplicate
   * sequence numbers into the stream.
   *
   * @param {string} stream - Stream identifier.
   * @param {Array<{entry: Object, seq: number}>} items - Records to append.
   * @returns {Promise<{stream: string, count: number, lastSeq: number}>} How
   *   many records were accepted and the highest sequence number among them
   *   (0 when `items` was empty).
   * @throws {InvalidKeyError} When `stream` is not a usable identifier.
   * @throws {StorageError} Code `INVALID_SEQ` when any `seq` is not a positive
   *   integer.
   */
  async appendBatch(_stream, _items) {
    throw new NotSupportedError('AppendLog.appendBatch is not implemented');
  }

  /**
   * Read a stream forward.
   *
   * Returns the persisted records whose `seq` is greater than `afterSeq`, in
   * ascending sequence order, capped at `limit`. Pending buffered writes for
   * the stream are flushed first, so a read always sees everything that was
   * appended before it.
   *
   * An unknown stream reads as `[]`, never an error.
   *
   * @param {string} stream - Stream identifier.
   * @param {ReadOptions} [opts] - Slice to read.
   * @returns {Promise<Array<Object>>} The records, each carrying its `seq`.
   * @throws {InvalidKeyError} When `stream` is not a usable identifier.
   */
  async read(_stream, _opts = {}) {
    throw new NotSupportedError('AppendLog.read is not implemented');
  }

  /**
   * Highest sequence number persisted for a stream, or 0 when it holds nothing.
   *
   * This must be correct **after a restart** — a fresh provider instance over
   * the same storage location has to report the same value, because it is what
   * a recovering worker continues allocating from. It is therefore read from
   * durable storage (after flushing pending writes), not from memory, and does
   * not assume the last record written is the highest one.
   *
   * @param {string} stream - Stream identifier.
   * @returns {Promise<number>} The highest persisted sequence number, or 0.
   * @throws {InvalidKeyError} When `stream` is not a usable identifier.
   */
  async lastSeq(_stream) {
    throw new NotSupportedError('AppendLog.lastSeq is not implemented');
  }

  /**
   * The record carrying the highest persisted sequence number, or null when the
   * stream holds nothing.
   *
   * This exists because {@link AppendLog#read} cannot answer it cheaply. `read`
   * returns the *lowest* sequence numbers above a cursor, and a record's
   * position in the store need not follow its sequence number, so a provider
   * has to consider the whole stream however small the limit. Asking for the
   * last record as `lastSeq()` followed by `read({afterSeq: seq - 1, limit: 1})`
   * therefore costs two passes to retrieve a record the first pass already had
   * in hand.
   *
   * It answers under the same rules as {@link AppendLog#lastSeq} — durable
   * storage, pending writes flushed first, no assumption that the last record
   * written is the highest — and must agree with it: `(await lastRecord(s))?.seq
   * ?? 0` equals `await lastSeq(s)` for every stream.
   *
   * @param {string} stream - Stream identifier.
   * @returns {Promise<Object|null>} The record, carrying its `seq`, or null.
   * @throws {InvalidKeyError} When `stream` is not a usable identifier.
   */
  async lastRecord(_stream) {
    throw new NotSupportedError('AppendLog.lastRecord is not implemented');
  }

  /**
   * Delete a stream and every blob stored beside it.
   *
   * Pending buffered writes for the stream are flushed (or discarded) first so
   * a delete cannot be undone by a later flush.
   *
   * @param {string} stream - Stream identifier.
   * @returns {Promise<boolean>} True when something was removed, false when
   *   there was nothing to remove.
   * @throws {InvalidKeyError} When `stream` is not a usable identifier.
   */
  async deleteStream(_stream) {
    throw new NotSupportedError('AppendLog.deleteStream is not implemented');
  }

  /**
   * Retention sweep: remove every stream last modified before `olderThan`,
   * together with its blobs. Pending writes are flushed first so a stream that
   * was just appended to is never judged by a stale modification time.
   *
   * Blobs are swept in their own right, not only as a side effect of the stream
   * they belong to: a payload spilled for a stream that never persisted a
   * record is exactly the large object retention exists to reclaim, and nothing
   * else will ever look for it.
   *
   * `kind` scopes the sweep to one consumer's streams. Without it the sweep is
   * store-wide, which means one consumer's retention policy deletes another's
   * data — pass it unless the store genuinely has a single consumer.
   *
   * @param {SweepOptions} opts - Cut-off for the sweep.
   * @returns {Promise<{streams: number, blobs: number}>} How many streams and
   *   blobs were removed.
   */
  async sweep(_opts) {
    throw new NotSupportedError('AppendLog.sweep is not implemented');
  }

  /**
   * Store a blob beside a stream — the spill target for payloads too large to
   * keep inline in a record.
   *
   * @param {string} stream - Stream identifier.
   * @param {string} name - Blob name; providers sanitize it into a safe
   *   single path segment.
   * @param {Buffer|string|Uint8Array} bytes - Content to store.
   * @param {Object} [opts]
   * @param {string} [opts.contentType='application/octet-stream'] - MIME type.
   * @returns {Promise<BlobRef>} Reference to the stored blob.
   * @throws {InvalidKeyError} When `stream` or `name` is not usable.
   */
  async putBlob(_stream, _name, _bytes, _opts = {}) {
    throw new NotSupportedError('AppendLog.putBlob is not implemented');
  }

  /**
   * Read a blob stored beside a stream.
   *
   * @param {string} stream - Stream identifier.
   * @param {string} name - Blob name as passed to {@link AppendLog#putBlob}.
   * @returns {Promise<Buffer|null>} The content, or null when it does not exist.
   * @throws {InvalidKeyError} When `stream` or `name` is not usable.
   */
  async getBlob(_stream, _name) {
    throw new NotSupportedError('AppendLog.getBlob is not implemented');
  }

  /**
   * Drain every buffered write to durable storage.
   *
   * Callers only need this before doing something outside the abstraction (a
   * backup, a manual inspection) or on shutdown: `read`, `lastSeq`, `sweep`
   * and `deleteStream` already flush what they depend on.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    throw new NotSupportedError('AppendLog.flush is not implemented');
  }
}
