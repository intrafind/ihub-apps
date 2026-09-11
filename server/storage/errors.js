/**
 * Error types shared by every storage provider.
 *
 * Providers signal the failure modes the storage contract names through these
 * classes instead of plain `Error`s: callers branch on the stable `code`, the
 * conformance suite asserts on the class, and the subclasses that map cleanly
 * onto HTTP carry `httpStatus` so a route can translate a storage failure
 * without re-deriving that mapping.
 *
 * @module storage/errors
 */

/**
 * Failure codes the contract names, with the HTTP status each maps onto.
 *
 * `INVALID_CURSOR` is here rather than on a class of its own because every
 * store raises it with a bare `StorageError` — which is why `routes/chats.js`
 * had to special-case it to answer 400 instead of 500, re-deriving the mapping
 * this module exists to own. A route can now ask the error.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const STORAGE_CODE_STATUS = Object.freeze({
  ETAG_MISMATCH: 409,
  LOCK_TIMEOUT: 503,
  INVALID_KEY: 400,
  INVALID_CURSOR: 400,
  INVALID_SEQ: 400,
  INVALID_DATA: 400,
  INVALID_ETAG: 400,
  INVALID_LOCK_OPTIONS: 400,
  NOT_SUPPORTED: 501,
  STORAGE_SHUT_DOWN: 503,
  STORAGE_UNAVAILABLE: 503,
  UNKNOWN_PROVIDER: 500,
  UNKNOWN_NAMESPACE: 400,
  CORRUPT_DOCUMENT: 500
});

/**
 * The HTTP status a storage failure maps onto, or null when it has none.
 *
 * Prefers the status the error carries — a subclass sets it directly — and
 * falls back to the code table, so a `StorageError` raised with a bare code
 * still translates instead of reaching a client as a 500.
 *
 * @param {unknown} error - Any thrown value.
 * @returns {number|null} The status, or null when nothing maps.
 */
export function storageHttpStatus(error) {
  if (!error || typeof error !== 'object') return null;
  if (Number.isInteger(error.httpStatus)) return error.httpStatus;
  return STORAGE_CODE_STATUS[error.code] ?? null;
}

/**
 * Base class for every storage failure.
 *
 * @property {string} code - Stable, machine-readable failure code.
 */
export class StorageError extends Error {
  /**
   * @param {string} message - Human-readable description.
   * @param {Object} [options]
   * @param {string} [options.code='STORAGE_ERROR'] - Stable failure code.
   * @param {unknown} [options.cause] - Underlying error, kept for logging.
   */
  constructor(message, { code, cause } = {}) {
    // Only forward `cause` when there is one: `new Error(msg, { cause: undefined })`
    // installs an own `cause` property, which is indistinguishable from a real
    // `undefined` cause when the error is inspected or serialized.
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'StorageError';
    this.code = code || 'STORAGE_ERROR';
  }
}

/**
 * A conditional write lost: the caller's `etag` did not match the stored
 * document, or `etag: null` (create-only) was used on a key that exists.
 *
 * @property {number} httpStatus - 409 Conflict.
 */
export class EtagMismatchError extends StorageError {
  /**
   * @param {string} message - Human-readable description.
   * @param {Object} [options]
   * @param {unknown} [options.cause] - Underlying error, kept for logging.
   */
  constructor(message, options = {}) {
    super(message, { ...options, code: 'ETAG_MISMATCH' });
    this.name = 'EtagMismatchError';
    this.httpStatus = 409;
  }
}

/**
 * A lock could not be acquired within its `waitMs` budget. The guarded
 * function was never run.
 *
 * @property {number} httpStatus - 503 Service Unavailable.
 */
export class LockTimeoutError extends StorageError {
  /**
   * @param {string} message - Human-readable description.
   * @param {Object} [options]
   * @param {unknown} [options.cause] - Underlying error, kept for logging.
   */
  constructor(message, options = {}) {
    super(message, { ...options, code: 'LOCK_TIMEOUT' });
    this.name = 'LockTimeoutError';
    this.httpStatus = 503;
  }
}

/**
 * A namespace, key, stream or blob name is not usable as an identifier —
 * empty, too long, or carrying path separators or traversal sequences.
 *
 * @property {number} httpStatus - 400 Bad Request.
 */
export class InvalidKeyError extends StorageError {
  /**
   * @param {string} message - Human-readable description.
   * @param {Object} [options]
   * @param {unknown} [options.cause] - Underlying error, kept for logging.
   */
  constructor(message, options = {}) {
    super(message, { ...options, code: 'INVALID_KEY' });
    this.name = 'InvalidKeyError';
    this.httpStatus = 400;
  }
}

/**
 * The configured storage provider has no registered factory — a typo in
 * `platform.json`, or a provider that a later release ships.
 */
export class UnknownProviderError extends StorageError {
  /**
   * @param {string} message - Human-readable description; should list the
   *   registered provider names so the misconfiguration is obvious from the log.
   * @param {Object} [options]
   * @param {unknown} [options.cause] - Underlying error, kept for logging.
   */
  constructor(message, options = {}) {
    super(message, { ...options, code: 'UNKNOWN_PROVIDER' });
    this.name = 'UnknownProviderError';
  }
}

/**
 * The operation is not implemented by this provider. Thrown by every method of
 * the abstract interfaces, and by providers that legitimately do not offer a
 * facet (their `getCapabilities()` says so).
 *
 * @property {number} httpStatus - 501 Not Implemented.
 */
/**
 * A facet was used after its provider shut down.
 *
 * The alternative is worse than an error: the filesystem append log buffers,
 * so a record appended after the final flush is accepted, held in memory and
 * then lost when the process exits — a run ledger that silently stops one
 * record short of the event that mattered. Rejecting hands the caller
 * something to log. Every consumer of the ledger already tolerates a failed
 * append; none of them can tolerate one that succeeded and vanished.
 */
export class StorageShutDownError extends StorageError {
  /**
   * @param {string} message - What was attempted.
   * @param {Object} [options] - Standard error options (`cause`, …).
   */
  constructor(message, options = {}) {
    super(message, { ...options, code: 'STORAGE_SHUT_DOWN' });
    this.name = 'StorageShutDownError';
  }
}

/**
 * A stored document exists but cannot be read as one.
 *
 * Distinct from "absent", and the distinction is the point. A read that folds
 * the two together hands a caller `null` for a document that is still there,
 * and the callers act on that: `ChatRepository.ensureChat` sees no chat and
 * writes a fresh one owned by whoever asked, while the transcript — a separate
 * document that still parses — comes with it, so a truncated chat document
 * silently transfers one user's conversation to another. Failing closed costs
 * a 500 on that one key and leaves the file where an operator can look at it.
 *
 * Enveloped namespaces only. A raw configuration file is hand-edited and
 * git-tracked, and a missing comma in `platform.json` must not stop the server
 * from booting — `RawDocumentStore` keeps reading an unparseable file as
 * absent, deliberately.
 */
export class CorruptDocumentError extends StorageError {
  /**
   * @param {string} message - Human-readable description.
   * @param {Object} [options]
   * @param {unknown} [options.cause] - Underlying parse error, kept for logging.
   */
  constructor(message, options = {}) {
    super(message, { ...options, code: 'CORRUPT_DOCUMENT' });
    this.name = 'CorruptDocumentError';
  }
}

export class NotSupportedError extends StorageError {
  /**
   * @param {string} message - Human-readable description.
   * @param {Object} [options]
   * @param {unknown} [options.cause] - Underlying error, kept for logging.
   */
  constructor(message, options = {}) {
    super(message, { ...options, code: 'NOT_SUPPORTED' });
    this.name = 'NotSupportedError';
    this.httpStatus = 501;
  }
}
