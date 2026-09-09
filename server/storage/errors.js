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
