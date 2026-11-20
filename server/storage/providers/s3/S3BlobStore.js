// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Blobs in an S3-compatible bucket: one object per key.
 *
 * Object name: `[<prefix>/]<tenant>/<ns>/<key>`, tenant `default`. Namespace
 * and key follow the rule every provider shares (`storage/keys.js`), so a
 * name holds ids and never a file name, a user name or a URL. Names are
 * readable on purpose: the contract lists keys by prefix and in order, which
 * hashed names cannot do.
 *
 * The store sends five kinds of requests and nothing else: `PutObject`,
 * `GetObject`, `HeadObject`, `DeleteObject`, `ListObjectsV2` (and `HeadBucket`
 * for the start-up check). It never creates a bucket, never sets an ACL, sets
 * no object metadata and no server-side encryption header, and stores every
 * object as `application/octet-stream`.
 *
 * **It stores the bytes it is given.** Encryption is the job of the
 * {@link module:storage/EncryptingBlobStore~EncryptingBlobStore} in front of
 * it; the composition in `storage/index.js` never hands this store out bare.
 * There is no key material in this module.
 *
 * Contract points that need care on S3:
 * - `delete` must say whether it removed something, and of two racing deletes
 *   one must report true. `DeleteObject` answers 204 either way, so the store
 *   takes a lock for the key, asks `HeadObject`, then deletes. The lock is the
 *   lock manager of the provider this store is composed with, so the promise
 *   reaches as far as that provider's `locking` capability. Without a lock
 *   manager (a unit test, a tool) the exclusion is per process.
 * - A `HeadObject` 404 has no body and so does not say whether the key or the
 *   bucket is missing. `delete` asks `HeadBucket` before it answers "nothing
 *   to delete": the status of that request is the one signal every
 *   S3-compatible server gives; error names and headers of a HEAD differ.
 * - Every call ends. The client's request timeout stops at the response
 *   headers, so the store bounds the rest itself: each call has one deadline
 *   for its request (with its retries) and its body read, after which the
 *   request is aborted and the call rejects with `STORAGE_UNAVAILABLE`. The
 *   deadline is `operationTimeoutMs` (30 s by default) plus the time the
 *   payload needs at the slowest accepted transfer rate
 *   (`minThroughputBytesPerSecond`, 1 MiB/s by default), so a large object on
 *   a slow link is not cut off and a bucket that does not answer does not
 *   hold a request for minutes. A delete shares one deadline between its
 *   requests, and the wait for the delete lock covers exactly that: the
 *   longest a delete in front of it may take.
 * - A streamed read (`openRead`) has no whole-body deadline, because its
 *   consumer sets the pace. It is bounded by the time spent waiting for the
 *   bucket instead (`./s3BodyStream.js`). A streamed write (`putStream`) is
 *   one `PutObject` with the stream as its body, sent once: the SDK does not
 *   retry a body it cannot rewind.
 * - "No such blob" is only what S3 says it is: a `GetObject` answered with
 *   the error code `NoSuchKey`. Any other 404 is a failure, never `null`.
 * - `list` pages with its own cursor and `StartAfter`, not with the backend's
 *   continuation token, which is opaque and differs per server.
 * - S3 lists in UTF-8 byte order, which equals the contract's code-unit order
 *   for the ASCII keys allowed here. A server that lists out of order is
 *   detected and refused.
 *
 * The backend must be strongly consistent for read-after-write and
 * list-after-write. AWS S3 and the usual S3-compatible servers are.
 *
 * @module storage/providers/s3/S3BlobStore
 */
import crypto from 'node:crypto';
import { Readable, Transform, pipeline } from 'node:stream';
import logger from '../../../utils/logger.js';
import { BlobStore } from '../../BlobStore.js';
import {
  MAX_BLOB_PAGE,
  clampBlobLimit,
  compareBlobKeys,
  decodeBlobCursor,
  assertStreamLength,
  encodeBlobCursor,
  guardStream,
  streamLengthError,
  toBlobBuffer
} from '../../blobSupport.js';
import { InvalidKeyError, LockTimeoutError, StorageError } from '../../errors.js';
import { assertValidBlobKey, assertValidNamespace, isReservedBlobKey } from '../../keys.js';
import { isValidId } from '../../../utils/pathSecurity.js';
import { boundedBodyStream } from './s3BodyStream.js';
import { describeS3Error, isNoSuchKey, isNotFound, mapS3Error } from './s3Errors.js';

const COMPONENT = 'S3BlobStore';

/** Deletes a prefix delete sends at once. */
const DELETE_CONCURRENCY = 8;

/** A listing prefix that can match a key at all. */
const PREFIX_PATTERN = /^[A-Za-z0-9._-]*$/;

const CONTENT_TYPE = 'application/octet-stream';

/** Longest pause the SDK's standard retry mode takes between two attempts. */
const RETRY_DELAY_CAP_MS = 20_000;

/** First pause of the SDK's retry backoff for a throttled request; it doubles per attempt. */
const RETRY_DELAY_BASE_MS = 500;

/** Added to every deadline, so the SDK's own timeout (with its better error) fires first. */
const DEADLINE_SLACK_MS = 1000;

/**
 * How long the consumer of an `openRead` stream may take nothing before the
 * stream is given up and its connection released. Far above any pause of a
 * reader that is still there (a slow link, a download the browser holds
 * back); the time the bucket may be silent is bounded separately and much
 * tighter (`./s3BodyStream.js`).
 */
const ABANDONED_READ_MS = 15 * 60 * 1000;

/**
 * An error the error table reads as a timeout.
 *
 * @param {string} message
 * @returns {Error} Named `TimeoutError`, code `ETIMEDOUT`.
 */
function timeoutError(message) {
  return Object.assign(new Error(message), { name: 'TimeoutError', code: 'ETIMEDOUT' });
}

/**
 * The longest one command may take with its retries: every attempt may use
 * the connect and the request timeout, and the SDK pauses between attempts.
 *
 * @param {Object} timeouts
 * @param {number} [timeouts.requestTimeoutMs]
 * @param {number} [timeouts.connectTimeoutMs=0]
 * @param {number} [timeouts.maxAttempts=1]
 * @returns {number|null} Milliseconds, or null without a request timeout.
 *
 * @example
 * sendBudgetMs({ requestTimeoutMs: 60000, connectTimeoutMs: 5000, maxAttempts: 3 }); // 197500
 */
export function sendBudgetMs({ requestTimeoutMs, connectTimeoutMs = 0, maxAttempts = 1 } = {}) {
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) return null;
  const attempts = Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : 1;
  const connect = Number.isFinite(connectTimeoutMs) && connectTimeoutMs > 0 ? connectTimeoutMs : 0;
  let pauses = 0;
  for (let retry = 0; retry < attempts - 1; retry++) {
    pauses += Math.min(RETRY_DELAY_CAP_MS, RETRY_DELAY_BASE_MS * 2 ** retry);
  }
  return attempts * (connect + requestTimeoutMs) + pauses + DEADLINE_SLACK_MS;
}

/**
 * The time a payload needs at the slowest transfer rate that is accepted.
 *
 * @param {number} bytes - Payload size.
 * @param {number|null} bytesPerSecond - `minThroughputBytesPerSecond`.
 * @returns {number} Milliseconds; 0 without a rate or a size.
 *
 * @example
 * transferAllowanceMs(64 * 1024 * 1024, 1024 * 1024); // 64000
 */
export function transferAllowanceMs(bytes, bytesPerSecond) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return 0;
  return Math.ceil((bytes / bytesPerSecond) * 1000);
}

/**
 * Read a response body into one Buffer.
 *
 * With `expected` (the declared length) the bytes go straight into one buffer
 * of that size, so the body is held once and not once as chunks and once
 * joined. The read ends early, with `data: null`, when the body is longer
 * than `limit` or than `expected`; with `stopAt` it ends, successfully, as
 * soon as that many bytes are there.
 *
 * @param {AsyncIterable<Uint8Array>} body
 * @param {Object} options
 * @param {number} options.limit - Give up above this many bytes.
 * @param {number|null} [options.expected] - Declared length, when known.
 * @param {number} [options.stopAt] - Stop reading at this many bytes.
 * @param {number|null} [options.deadlineMs] - Abort the read after this long.
 * @returns {Promise<{data: Buffer|null, bytes: number}>} `bytes` is what
 *   arrived until the read ended.
 * @throws {Error} A `TimeoutError` when the deadline passes; the body is destroyed.
 */
async function readBody(
  body,
  { limit, expected = null, stopAt = Infinity, deadlineMs = null } = {}
) {
  const consume = async () => {
    const target = expected === null ? null : Buffer.allocUnsafe(expected);
    const chunks = [];
    let total = 0;
    for await (const chunk of body) {
      const end = total + chunk.length;
      if (end > limit || (target && end > target.length)) {
        body.destroy?.();
        return { data: null, bytes: end };
      }
      if (target) target.set(chunk, total);
      else chunks.push(chunk);
      total = end;
      if (total >= stopAt) {
        body.destroy?.();
        break;
      }
    }
    if (target) return { data: target.subarray(0, total), bytes: total };
    return { data: chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total), bytes: total };
  };
  if (!deadlineMs) return consume();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = timeoutError(`The response body did not arrive within ${deadlineMs} ms`);
      body.destroy?.(error);
      reject(error);
    }, deadlineMs);
  });
  const reading = consume();
  // Destroying the body makes the read reject too; the deadline already answered.
  reading.catch(() => {});
  try {
    return await Promise.race([reading, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Blob facet backed by an S3-compatible bucket.
 */
export class S3BlobStore extends BlobStore {
  /**
   * @param {Object} options
   * @param {string} options.bucket - Bucket name. It must exist.
   * @param {string} [options.prefix=''] - Key prefix inside the bucket, without
   *   a trailing slash.
   * @param {string} [options.tenant='default'] - Tenant segment of every name.
   * @param {() => Promise<{client: Object, commands: Object, destroy: Function}>} options.connect -
   *   Builds the client on first use (`createS3Client`). Not called by the
   *   constructor, which does no I/O.
   * @param {Object} [options.locks] - A `LockManager` for `delete`.
   * @param {number} [options.maxObjectBytes] - Largest stored object `get`
   *   reads and `put` sends. Unlimited when unset.
   * @param {string} [options.endpointHost] - For log lines.
   * @param {number} [options.requestTimeoutMs] - The client's request timeout.
   *   The store derives its own deadlines from it (one command with its
   *   retries, one body read, the wait for the delete lock). Without it the
   *   store sets none, and only the client's timeouts apply.
   * @param {number} [options.connectTimeoutMs] - The client's connect timeout.
   * @param {number} [options.maxAttempts] - The client's attempts per command.
   * @param {number} [options.operationTimeoutMs] - Longest one blob call may
   *   take with all its attempts, before the allowance for its payload. When
   *   unset, what the attempts add up to (`sendBudgetMs`).
   * @param {number} [options.minThroughputBytesPerSecond] - Slowest transfer
   *   that is accepted; every call gets `bytes / rate` on top of its deadline.
   * @param {number} [options.abandonedReadMs] - How long the consumer of an
   *   `openRead` stream may take nothing before the stream is given up;
   *   15 minutes by default, 0 for no bound.
   *   No allowance when unset.
   */
  constructor({
    bucket,
    prefix = '',
    tenant = 'default',
    connect,
    locks,
    maxObjectBytes,
    endpointHost,
    requestTimeoutMs,
    connectTimeoutMs,
    maxAttempts,
    operationTimeoutMs,
    minThroughputBytesPerSecond,
    abandonedReadMs = ABANDONED_READ_MS
  }) {
    super();
    if (typeof bucket !== 'string' || !bucket) {
      throw new StorageError('S3BlobStore needs a bucket', { code: 'INVALID_STORAGE_CONFIG' });
    }
    if (typeof connect !== 'function') {
      throw new StorageError('S3BlobStore needs a client factory', {
        code: 'INVALID_STORAGE_CONFIG'
      });
    }
    if (!isValidId(tenant)) throw new InvalidKeyError('Invalid storage tenant');
    this._bucket = bucket;
    this._base = `${prefix ? `${prefix}/` : ''}${tenant}/`;
    this._connect = connect;
    this._locks = locks || null;
    this._maxObjectBytes =
      Number.isSafeInteger(maxObjectBytes) && maxObjectBytes > 0 ? maxObjectBytes : Infinity;
    this._endpointHost = endpointHost || null;
    /** What the attempts of one command add up to; null for no deadline. */
    const attemptsBudget = sendBudgetMs({ requestTimeoutMs, connectTimeoutMs, maxAttempts });
    /**
     * Longest one blob call may take without the allowance for its payload;
     * null for no deadline.
     */
    this._sendBudgetMs =
      attemptsBudget === null
        ? null
        : Number.isFinite(operationTimeoutMs) && operationTimeoutMs > 0
          ? Math.min(attemptsBudget, operationTimeoutMs + DEADLINE_SLACK_MS)
          : attemptsBudget;
    /** The client's request timeout of one attempt, which a large upload extends. */
    this._requestTimeoutMs = attemptsBudget === null ? null : requestTimeoutMs;
    /** How long the reader of an `openRead` stream may take nothing; null for no bound. */
    this._abandonedReadMs =
      Number.isFinite(abandonedReadMs) && abandonedReadMs > 0 ? abandonedReadMs : null;
    this._minThroughput =
      Number.isFinite(minThroughputBytesPerSecond) && minThroughputBytesPerSecond > 0
        ? minThroughputBytesPerSecond
        : null;
    /** @type {Promise<Object>|null} */
    this._connection = null;
    this._destroyed = false;
    /** In-process delete exclusion, used when no lock manager was injected. */
    this._deleteChains = new Map();
  }

  /** The bucket this store writes to. */
  get bucket() {
    return this._bucket;
  }

  /** What every object name of this store starts with: `[<prefix>/]<tenant>/`. */
  get basePrefix() {
    return this._base;
  }

  /**
   * The object name of one blob.
   *
   * @param {string} ns - Namespace.
   * @param {string} key - Key within the namespace.
   * @returns {string} `[<prefix>/]<tenant>/<ns>/<key>`
   * @throws {InvalidKeyError} When either is not a safe id, or the key is reserved.
   *
   * @example
   * store.objectKey('chat-files', 'chat__a__f1.txt'); // 'default/chat-files/chat__a__f1.txt'
   */
  objectKey(ns, key) {
    assertValidNamespace(ns);
    assertValidBlobKey(key);
    return `${this._base}${ns}/${key}`;
  }

  /**
   * The connected client, built on first use.
   *
   * @returns {Promise<{client: Object, commands: Object, destroy: Function}>}
   * @private
   */
  async _s3() {
    if (this._destroyed) {
      throw new StorageError('The S3 blob store was shut down', { code: 'STORAGE_SHUT_DOWN' });
    }
    if (!this._connection) {
      this._connection = Promise.resolve()
        .then(() => this._connect())
        .catch(error => {
          // Not remembered: the next call tries again.
          this._connection = null;
          throw error;
        });
    }
    return this._connection;
  }

  /**
   * Send one command and translate its failure.
   *
   * @param {string} command - Name of a class in `commands`.
   * @param {Object} input - Command input.
   * @param {{op: string, ns?: string, key?: string, notFound?: *, bytes?: number,
   *   deadlineAt?: number, signal?: AbortSignal}} where - The blob call, for the error. `notFound`,
   *   when given, is returned for a missing object instead of throwing: for a
   *   `GetObject` only on the S3 answer `NoSuchKey`, for a `HeadObject` (which
   *   has no error body) on a 404 the caller then confirms. `bytes` is the
   *   payload the request uploads, which extends its deadline. `deadlineAt`
   *   (epoch ms) is a deadline several requests of one call share. `signal`
   *   aborts the request.
   * @returns {Promise<Object>} The command output.
   * @private
   */
  async _send(command, input, where) {
    const { client, commands } = await this._s3();
    const allowance = transferAllowanceMs(where.bytes, this._minThroughput);
    let budget = this._sendBudgetMs === null ? null : this._sendBudgetMs + allowance;
    if (budget !== null && Number.isFinite(where.deadlineAt)) {
      budget = Math.max(1, Math.min(budget, where.deadlineAt - Date.now()));
    }
    // An upload happens before the response headers, so the client's request
    // timeout of each attempt has to cover it.
    const perRequest =
      allowance > 0 && this._requestTimeoutMs !== null
        ? { requestTimeout: this._requestTimeoutMs + allowance }
        : {};
    const absent = command === 'HeadObjectCommand' ? isNotFound : isNoSuchKey;
    try {
      return await this._bounded(
        where.op,
        options =>
          client.send(new commands[command]({ Bucket: this._bucket, ...input }), {
            ...options,
            ...perRequest
          }),
        budget,
        where.signal || null
      );
    } catch (error) {
      if ('notFound' in where && absent(error)) return where.notFound;
      const mapped = mapS3Error(error, where);
      logger.warn('An S3 request failed', {
        component: COMPONENT,
        op: where.op,
        ns: where.ns,
        key: where.key,
        bucket: this._bucket,
        endpointHost: this._endpointHost,
        probeCode: mapped.probeCode,
        ...describeS3Error(error)
      });
      throw mapped;
    }
  }

  /**
   * Run one command under the store's deadline: when the command, with its
   * retries, has not settled by then, its request is aborted and the call
   * rejects. The client's own timeouts normally end it earlier.
   *
   * @param {string} op - The blob call, for the error.
   * @param {(options?: {abortSignal: AbortSignal}) => Promise<T>} run - Sends
   *   the command with the options it is given.
   * @param {number|null} [budget] - The deadline in milliseconds; the store's
   *   deadline of a call without payload by default, null for none.
   * @param {AbortSignal|null} [signal] - Aborts the request when the caller
   *   gives up on it (the stream it uploads failed); the call rejects with
   *   the signal's reason.
   * @returns {Promise<T>}
   * @template T
   * @private
   */
  async _bounded(op, run, budget = this._sendBudgetMs, signal = null) {
    if (budget === null && !signal) return run();
    const controller = new AbortController();
    let timer;
    let onAbort;
    const deadline = new Promise((_, reject) => {
      if (budget !== null) {
        timer = setTimeout(() => {
          const error = timeoutError(`S3 ${op} did not finish within ${budget} ms`);
          controller.abort(error);
          reject(error);
        }, budget);
      }
      onAbort = () => {
        controller.abort(signal.reason);
        reject(signal.reason);
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
    const sending = run({ abortSignal: controller.signal });
    // The abort makes the command reject too; the deadline already answered.
    sending.catch(() => {});
    try {
      return await Promise.race([sending, deadline]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * @inheritdoc
   *
   * `bytes` and `sha256` describe what was handed in. The `contentType` hint
   * is not stored.
   */
  async put(ns, key, data, _opts = {}) {
    const name = this.objectKey(ns, key);
    const body = toBlobBuffer(data);
    if (body.length > this._maxObjectBytes) {
      throw new StorageError(
        `Blob ${ns}/${key} has ${body.length} stored bytes; the limit is ${this._maxObjectBytes}`,
        { code: 'BLOB_TOO_LARGE' }
      );
    }
    await this._send(
      'PutObjectCommand',
      { Key: name, Body: body, ContentLength: body.length, ContentType: CONTENT_TYPE },
      { op: 'put', ns, key, bytes: body.length }
    );
    return {
      key,
      bytes: body.length,
      sha256: crypto.createHash('sha256').update(body).digest('hex')
    };
  }

  /**
   * @inheritdoc
   *
   * The object's length is checked against the limit before its body is read,
   * and the read stops at the limit when the server sent no length. The body
   * read has a deadline: what is left of the call's time, plus the time the
   * declared length needs at the slowest accepted transfer rate. A server
   * that sends the headers and then stalls does not hold the call.
   *
   * @returns {Promise<{key: string, bytes: number, data: Buffer}|null>} Null
   *   only when S3 answered `NoSuchKey`.
   *
   * @throws {StorageError} Code `BLOB_TOO_LARGE` for an object over the limit;
   *   `STORAGE_UNAVAILABLE` for a body that is cut, stalls or has another
   *   length than declared.
   */
  async get(ns, key) {
    const name = this.objectKey(ns, key);
    const where = { op: 'get', ns, key };
    const startedAt = Date.now();
    const response = await this._send(
      'GetObjectCommand',
      { Key: name },
      { ...where, notFound: null }
    );
    if (!response) return null;
    return this._readWhole(response, where, startedAt);
  }

  /**
   * The error for a stored object over the limit.
   *
   * @param {string} ns
   * @param {string} key
   * @returns {StorageError} Code `BLOB_TOO_LARGE`.
   * @private
   */
  _tooLarge(ns, key) {
    return new StorageError(
      `Blob ${ns}/${key} is larger than the limit of ${this._maxObjectBytes} stored bytes and was not read`,
      { code: 'BLOB_TOO_LARGE' }
    );
  }

  /**
   * Read the body of a `GetObject` response into one Buffer, under the limit
   * and the body deadline.
   *
   * @param {Object} response - The command output.
   * @param {{op: string, ns: string, key: string}} where - The blob call.
   * @param {number} startedAt - When the call started (epoch ms).
   * @returns {Promise<{key: string, bytes: number, data: Buffer}>}
   * @private
   */
  async _readWhole(response, where, startedAt) {
    const { ns, key } = where;
    const tooLarge = () => this._tooLarge(ns, key);
    const declared = Number.isSafeInteger(response.ContentLength) ? response.ContentLength : null;
    if (declared !== null && declared > this._maxObjectBytes) {
      response.Body?.destroy?.();
      throw tooLarge();
    }
    let read;
    try {
      read = await readBody(response.Body, {
        limit: this._maxObjectBytes,
        expected: declared,
        deadlineMs: this._bodyDeadlineMs(
          startedAt,
          declared ?? (Number.isFinite(this._maxObjectBytes) ? this._maxObjectBytes : 0)
        )
      });
    } catch (error) {
      throw this._bodyFailure(error, where);
    }
    if (read.bytes > this._maxObjectBytes) throw tooLarge();
    if (declared !== null && read.bytes !== declared) {
      throw new StorageError(
        `Blob ${ns}/${key} arrived with ${read.bytes > declared ? 'more than ' : `${read.bytes} of `}${declared} bytes`,
        { code: 'STORAGE_UNAVAILABLE' }
      );
    }
    return { key, bytes: read.bytes, data: read.data };
  }

  /**
   * @inheritdoc
   *
   * The body of one `GetObject`, handed on as it arrives. The call resolves
   * when the response headers are there; the object's length is checked
   * against the limit before a byte of the body is read.
   *
   * The whole-body deadline of `get` does not fit a stream that is read at
   * its consumer's pace, so the body has two bounds that count only the time
   * spent waiting for the bucket (`./s3BodyStream.js`): no byte for the
   * call's deadline (`operationTimeoutMs`, capped by `requestTimeoutMs`), and
   * a total wait of that deadline plus the time the object needs at
   * `minThroughputBytesPerSecond`. Either ends the stream with
   * `STORAGE_UNAVAILABLE`, as does a body that is cut or has another length
   * than declared. Destroying the stream aborts the request.
   *
   * The time a consumer takes for itself is not the bucket's: the client's
   * socket timeout is off the connection while the consumer does not ask for
   * data, so a slow link or a paused download is not cut. A consumer that
   * takes nothing for 15 minutes loses the stream with `READ_ABANDONED`,
   * which is what releases the connection of a stream nobody reads.
   *
   * @throws {StorageError} Code `BLOB_TOO_LARGE` for an object over the limit.
   */
  async openRead(ns, key) {
    const name = this.objectKey(ns, key);
    const where = { op: 'openRead', ns, key };
    const startedAt = Date.now();
    const response = await this._send(
      'GetObjectCommand',
      { Key: name },
      { ...where, notFound: null }
    );
    if (!response) return null;
    const declared = Number.isSafeInteger(response.ContentLength) ? response.ContentLength : null;
    if (declared === null) {
      // No length, no promise of one: read under the rules of `get`.
      const blob = await this._readWhole(response, where, startedAt);
      return {
        key,
        bytes: blob.bytes,
        stream: Readable.from([blob.data], { objectMode: false })
      };
    }
    if (declared > this._maxObjectBytes) {
      response.Body?.destroy?.();
      throw this._tooLarge(ns, key);
    }
    const unavailable = message =>
      new StorageError(`Blob ${ns}/${key}: ${message}`, { code: 'STORAGE_UNAVAILABLE' });
    const stream = boundedBodyStream(response.Body, {
      bytes: declared,
      idleMs:
        this._sendBudgetMs === null
          ? null
          : Math.min(this._sendBudgetMs, this._requestTimeoutMs ?? Infinity),
      budgetMs: this._bodyDeadlineMs(startedAt, declared),
      abandonedMs: this._abandonedReadMs,
      socketIdleMs: this._requestTimeoutMs,
      abandonedError: message =>
        new StorageError(`Blob ${ns}/${key}: ${message}; the read was given up`, {
          code: 'READ_ABANDONED'
        }),
      mapError: error => (error instanceof StorageError ? error : this._bodyFailure(error, where)),
      timeoutError,
      lengthError: unavailable
    });
    return { key, bytes: declared, stream: guardStream(stream) };
  }

  /**
   * @inheritdoc
   *
   * One `PutObject` whose body is the stream, with the declared length as its
   * `Content-Length`; no multipart upload. A request with a stream body is
   * sent once: the SDK cannot rewind it, so the retries `put` gets
   * (`maxAttempts`) do not apply and a transient failure rejects the call. An
   * object is visible only when its `PutObject` succeeded, so a failed or
   * short stream leaves the key as it was. So does a stream that is longer
   * than declared or fails after its last declared byte: the request's last
   * chunk is sent only once the stream has ended.
   *
   * `bytes` and `sha256` describe what was sent. The `contentType` hint is
   * not stored.
   *
   * @throws {StorageError} Code `BLOB_TOO_LARGE` above the limit, before
   *   anything is sent.
   */
  async putStream(ns, key, stream, opts = {}) {
    const bytes = assertStreamLength(opts?.bytes, stream);
    let name;
    try {
      name = this.objectKey(ns, key);
      if (bytes > this._maxObjectBytes) {
        throw new StorageError(
          `Blob ${ns}/${key} has ${bytes} stored bytes; the limit is ${this._maxObjectBytes}`,
          { code: 'BLOB_TOO_LARGE' }
        );
      }
    } catch (error) {
      stream.destroy();
      throw error;
    }
    if (bytes === 0) {
      // A request without a body is complete with its headers, so nothing
      // could be held back: the source is read to its end first.
      for await (const chunk of stream) {
        if (chunk.length > 0) throw streamLengthError(`${ns}/${key}`, chunk.length, 0);
      }
      const ref = await this.put(ns, key, Buffer.alloc(0));
      return { key, bytes: 0, sha256: ref.sha256 };
    }
    const hash = crypto.createHash('sha256');
    let count = 0;
    /** What the payload itself failed with, as opposed to the request. */
    let payloadError = null;
    // A stream that fails does not end its request by itself: the upload
    // would wait for bytes that never come. The request is aborted instead.
    const gaveUp = new AbortController();
    const payloadFailed = error => {
      if (payloadError) return;
      payloadError = error;
      gaveUp.abort(error);
    };
    // The last chunk is held back until the source has ended. The server
    // stores the object as soon as it has the declared number of bytes; if
    // they were all handed on at once, a source that goes on (it is longer
    // than declared) or fails after its last byte would be noticed only
    // after the key was replaced.
    let held = null;
    const body = new Transform({
      transform(chunk, _encoding, callback) {
        if (chunk.length === 0) return void callback();
        count += chunk.length;
        if (count > bytes) {
          payloadFailed(streamLengthError(`${ns}/${key}`, count, bytes));
          return void callback(payloadError);
        }
        hash.update(chunk);
        const ready = held;
        held = chunk;
        return ready ? void callback(null, ready) : void callback();
      },
      flush(callback) {
        if (count !== bytes) payloadFailed(streamLengthError(`${ns}/${key}`, count, bytes));
        if (payloadError) return void callback(payloadError);
        return held ? void callback(null, held) : void callback();
      }
    });
    let requestSettled = false;
    pipeline(stream, body, error => {
      // Only a failure of the payload itself, not the teardown after the request ended.
      if (error && !requestSettled) payloadFailed(error);
    });
    try {
      await this._send(
        'PutObjectCommand',
        { Key: name, Body: body, ContentLength: bytes, ContentType: CONTENT_TYPE },
        { op: 'putStream', ns, key, bytes, signal: gaveUp.signal }
      );
    } catch (error) {
      requestSettled = true;
      body.destroy();
      stream.destroy();
      throw payloadError || error;
    } finally {
      requestSettled = true;
    }
    if (payloadError || count !== bytes) {
      throw payloadError || streamLengthError(`${ns}/${key}`, count, bytes);
    }
    return { key, bytes, sha256: hash.digest('hex') };
  }

  /**
   * The first bytes of one object, with a ranged `GetObject`. What the
   * encrypting blob store looks at to tell an encrypted blob from a plaintext
   * one while a bucket holds both; a bucket that only holds encrypted blobs is
   * never asked.
   *
   * @param {string} ns - Namespace.
   * @param {string} key - Key within the namespace.
   * @param {number} length - How many bytes to read at most.
   * @returns {Promise<Buffer|null>} Up to `length` bytes, or null when there is no object.
   */
  async readHead(ns, key, length) {
    const name = this.objectKey(ns, key);
    const where = { op: 'readHead', ns, key };
    const startedAt = Date.now();
    const response = await this._send(
      'GetObjectCommand',
      { Key: name, Range: `bytes=0-${length - 1}` },
      { ...where, notFound: null }
    );
    if (!response) return null;
    try {
      // A server that ignores the range sends the whole object; stop at `length`.
      const { data } = await readBody(response.Body, {
        limit: Infinity,
        stopAt: length,
        deadlineMs: this._bodyDeadlineMs(startedAt, length)
      });
      return data.subarray(0, length);
    } catch (error) {
      throw this._bodyFailure(error, where);
    }
  }

  /**
   * The deadline of a body read: what is left of the call's time since it
   * started, at least a second, plus the allowance for the payload.
   *
   * @param {number} startedAt - When the call started (epoch ms).
   * @param {number} bytes - How many bytes the body is expected to hold.
   * @returns {number|null} Milliseconds; null for no deadline.
   * @private
   */
  _bodyDeadlineMs(startedAt, bytes) {
    if (this._sendBudgetMs === null) return null;
    const left = this._sendBudgetMs - (Date.now() - startedAt);
    return Math.max(1000, left) + transferAllowanceMs(bytes, this._minThroughput);
  }

  /**
   * The storage error for a body read that failed, logged like a failed request.
   *
   * @param {unknown} error - What the body stream threw.
   * @param {{op: string, ns?: string, key?: string}} where - The blob call.
   * @returns {StorageError}
   * @private
   */
  _bodyFailure(error, where) {
    const mapped = mapS3Error(error, where);
    logger.warn('Reading an S3 response body failed', {
      component: COMPONENT,
      op: where.op,
      ns: where.ns,
      key: where.key,
      bucket: this._bucket,
      endpointHost: this._endpointHost,
      probeCode: mapped.probeCode,
      ...describeS3Error(error)
    });
    return mapped;
  }

  /**
   * @inheritdoc
   *
   * Lock, `HeadObject`, `DeleteObject`: the delete that found the object is
   * the one that reports true. A `HeadObject` 404 is confirmed with
   * `HeadBucket` before it is read as "no such object", because a HEAD answer
   * for a missing bucket looks the same.
   *
   * @throws {StorageError} `STORAGE_UNAVAILABLE` with `probeCode`
   *   `S3_BUCKET_NOT_FOUND` when the bucket is gone, and when the lock for the
   *   key could not be taken in the time a delete in front may need.
   */
  async delete(ns, key) {
    const name = this.objectKey(ns, key);
    const base = { op: 'delete', ns, key };
    const claim = async () => {
      // One deadline for the two requests of a delete, so that it takes no
      // longer than any other call, and a delete waiting behind it knows how
      // long that is.
      const where =
        this._sendBudgetMs === null
          ? base
          : { ...base, deadlineAt: Date.now() + this._sendBudgetMs };
      const found = await this._send(
        'HeadObjectCommand',
        { Key: name },
        { ...where, notFound: false }
      );
      if (found === false) {
        // Rejects with S3_BUCKET_NOT_FOUND when it is the bucket that is missing.
        await this.headBucket(where.deadlineAt);
        return false;
      }
      await this._send('DeleteObjectCommand', { Key: name }, where);
      return true;
    };
    if (!this._locks) return this._exclusive(name, claim);
    const digest = crypto.createHash('sha256').update(name).digest('hex').slice(0, 32);
    let holding = false;
    try {
      return await this._locks.withLock(
        `blob-delete:${digest}`,
        () => {
          holding = true;
          return claim();
        },
        this._sendBudgetMs === null
          ? {}
          : // What the delete in front may take at most: its HeadObject and
            // its DeleteObject or HeadBucket share one deadline.
            { waitMs: this._sendBudgetMs + DEADLINE_SLACK_MS }
      );
    } catch (error) {
      if (holding || !(error instanceof LockTimeoutError)) throw error;
      const mapped = new StorageError(
        `S3 delete of blob ${ns}/${key} failed: another delete of the same blob did not finish in time`,
        { code: 'STORAGE_UNAVAILABLE', cause: error }
      );
      logger.warn('The lock for an S3 delete could not be taken', {
        component: COMPONENT,
        op: 'delete',
        ns,
        key,
        bucket: this._bucket,
        endpointHost: this._endpointHost
      });
      throw mapped;
    }
  }

  /**
   * Run `fn` after every earlier `fn` for the same name in this process.
   *
   * @param {string} name
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   * @template T
   * @private
   */
  _exclusive(name, fn) {
    const previous = this._deleteChains.get(name) || Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.catch(() => {});
    this._deleteChains.set(name, settled);
    void settled.then(() => {
      if (this._deleteChains.get(name) === settled) this._deleteChains.delete(name);
    });
    return run;
  }

  /**
   * One page of object names under an object-name prefix, in order.
   *
   * @param {string} objectPrefix - Full object-name prefix.
   * @param {Object} [options]
   * @param {number} [options.limit]
   * @param {string} [options.startAfter] - Full object name to start after.
   * @param {string} [options.op='list']
   * @param {string} [options.ns]
   * @returns {Promise<{objects: Array<{name: string, bytes: number}>, truncated: boolean}>}
   * @private
   */
  async _page(objectPrefix, { limit = MAX_BLOB_PAGE, startAfter, op = 'list', ns } = {}) {
    const response = await this._send(
      'ListObjectsV2Command',
      { Prefix: objectPrefix, MaxKeys: limit, ...(startAfter ? { StartAfter: startAfter } : {}) },
      { op, ns }
    );
    const objects = [];
    let last = startAfter || '';
    for (const entry of response.Contents || []) {
      const name = entry?.Key;
      if (typeof name !== 'string' || !name.startsWith(objectPrefix) || name <= last) {
        // Out of order, repeated, or outside the prefix: paging by key would
        // skip or repeat objects on such a server.
        throw new StorageError(
          'The S3 server did not list object names in ascending order under the prefix asked ' +
            'for; such a server (an S3 Express directory bucket, for one) is not supported',
          { code: 'IO_ERROR' }
        );
      }
      last = name;
      objects.push({ name, bytes: Number.isSafeInteger(entry.Size) ? entry.Size : 0 });
    }
    return { objects, truncated: response.IsTruncated === true && objects.length > 0 };
  }

  /** @inheritdoc */
  async list(ns, opts = {}) {
    assertValidNamespace(ns);
    const { prefix, limit, cursor } = opts || {};
    const keyPrefix = typeof prefix === 'string' ? prefix : '';
    const after = cursor ? decodeBlobCursor(cursor) : null;
    // No key holds a character outside the id alphabet, so nothing matches.
    if (!PREFIX_PATTERN.test(keyPrefix)) return { items: [], nextCursor: null };
    const nsPrefix = `${this._base}${ns}/`;
    const { objects, truncated } = await this._page(nsPrefix + keyPrefix, {
      limit: clampBlobLimit(limit),
      startAfter: after === null ? undefined : nsPrefix + after,
      ns
    });
    const items = [];
    for (const object of objects) {
      const key = object.name.slice(nsPrefix.length);
      // Names come from the bucket and are not trusted: anything that is not a
      // key of this store (a nested name, a stray upload) is not a blob.
      if (!isValidId(key) || isReservedBlobKey(key)) continue;
      items.push({ key, bytes: object.bytes });
    }
    items.sort((a, b) => compareBlobKeys(a.key, b.key));
    const lastName = objects.length > 0 ? objects[objects.length - 1].name : null;
    return {
      items,
      nextCursor: truncated ? encodeBlobCursor(lastName.slice(nsPrefix.length)) : null
    };
  }

  /**
   * @inheritdoc
   *
   * Lists the prefix, then sends one `DeleteObject` per key, a few at a time.
   * No lock and no `HeadObject`: a sweep does not claim anything. The count is
   * the number of deletes the server accepted, so two sweeps of one prefix at
   * the same time may each count a key.
   */
  async deletePrefix(ns, prefix) {
    assertValidNamespace(ns);
    if (typeof prefix !== 'string' || prefix.length === 0) {
      throw new InvalidKeyError('deletePrefix needs a non-empty prefix');
    }
    const keys = [];
    for await (const item of this.scan(ns, { prefix })) keys.push(item.key);
    let removed = 0;
    let failure = null;
    const queue = keys.slice();
    const worker = async () => {
      while (queue.length > 0 && !failure) {
        const key = queue.shift();
        try {
          await this._send(
            'DeleteObjectCommand',
            { Key: `${this._base}${ns}/${key}` },
            { op: 'deletePrefix', ns, key }
          );
          removed += 1;
        } catch (error) {
          failure = error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(DELETE_CONCURRENCY, keys.length) }, worker));
    if (failure) throw failure;
    return removed;
  }

  /**
   * Ask the server for the bucket: proves the endpoint, the certificate, the
   * credentials and the bucket name with one request that changes nothing.
   *
   * @param {number} [deadlineAt] - A deadline (epoch ms) shared with the
   *   call this check belongs to.
   * @returns {Promise<void>}
   * @throws {StorageError} With a `probeCode` saying which of them failed.
   */
  async headBucket(deadlineAt) {
    const { client, commands } = await this._s3();
    const budget =
      this._sendBudgetMs !== null && Number.isFinite(deadlineAt)
        ? Math.max(1, Math.min(this._sendBudgetMs, deadlineAt - Date.now()))
        : this._sendBudgetMs;
    try {
      await this._bounded(
        'headBucket',
        options => client.send(new commands.HeadBucketCommand({ Bucket: this._bucket }), options),
        budget
      );
    } catch (error) {
      // A HEAD has no error body: a 404 here can only be the bucket.
      const mapped = mapS3Error(
        error?.name === 'NotFound' ? Object.assign(error, { name: 'NoSuchBucket' }) : error,
        { op: 'headBucket' }
      );
      logger.warn('The S3 bucket check failed', {
        component: COMPONENT,
        bucket: this._bucket,
        endpointHost: this._endpointHost,
        probeCode: mapped.probeCode,
        ...describeS3Error(error)
      });
      throw mapped;
    }
  }

  /**
   * Whether the store's prefix holds any object outside one namespace. The
   * key check uses it to tell an empty store from one that already has data.
   *
   * @param {string} ns - The namespace to leave out.
   * @returns {Promise<boolean>}
   */
  async hasObjectsOutside(ns) {
    assertValidNamespace(ns);
    const skipped = `${this._base}${ns}/`;
    const first = await this._page(this._base, { limit: 1, op: 'inspect' });
    if (first.objects.length === 0) return false;
    if (!first.objects[0].name.startsWith(skipped)) return true;
    // `0` is the character after `/`: every name under `<ns>/` sorts before it.
    const beyond = await this._page(this._base, {
      limit: 1,
      startAfter: `${this._base}${ns}0`,
      op: 'inspect'
    });
    if (beyond.objects.length > 0) return true;
    // Names before `<ns>/` would have been the first object.
    return false;
  }

  /**
   * Close the client and its connections. Idempotent; the store rejects
   * every call afterwards.
   *
   * @returns {Promise<void>}
   */
  async destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    const connection = this._connection;
    this._connection = null;
    if (!connection) return;
    try {
      (await connection).destroy();
    } catch {
      // The client never came up; nothing to close.
    }
  }
}

export default S3BlobStore;
