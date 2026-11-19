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
import logger from '../../../utils/logger.js';
import { BlobStore } from '../../BlobStore.js';
import {
  MAX_BLOB_PAGE,
  clampBlobLimit,
  compareBlobKeys,
  decodeBlobCursor,
  encodeBlobCursor,
  toBlobBuffer
} from '../../blobSupport.js';
import { InvalidKeyError, StorageError } from '../../errors.js';
import { assertValidBlobKey, assertValidNamespace, isReservedBlobKey } from '../../keys.js';
import { isValidId } from '../../../utils/pathSecurity.js';
import { describeS3Error, isNotFound, mapS3Error } from './s3Errors.js';

const COMPONENT = 'S3BlobStore';

/** Deletes a prefix delete sends at once. */
const DELETE_CONCURRENCY = 8;

/** A listing prefix that can match a key at all. */
const PREFIX_PATTERN = /^[A-Za-z0-9._-]*$/;

const CONTENT_TYPE = 'application/octet-stream';

/**
 * Read a response body into one Buffer, giving up at `limit` bytes.
 *
 * @param {AsyncIterable<Uint8Array>} body
 * @param {number} limit
 * @returns {Promise<Buffer|null>} The body, or null when it is longer than `limit`.
 */
async function readBody(body, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > limit) {
      body.destroy?.();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
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
   */
  constructor({
    bucket,
    prefix = '',
    tenant = 'default',
    connect,
    locks,
    maxObjectBytes,
    endpointHost
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
   * @param {{op: string, ns?: string, key?: string, notFound?: *}} where - The
   *   blob call, for the error; `notFound`, when given, is returned for a
   *   missing object instead of throwing.
   * @returns {Promise<Object>} The command output.
   * @private
   */
  async _send(command, input, where) {
    const { client, commands } = await this._s3();
    try {
      return await client.send(new commands[command]({ Bucket: this._bucket, ...input }));
    } catch (error) {
      if ('notFound' in where && isNotFound(error)) return where.notFound;
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
      { op: 'put', ns, key }
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
   * and the read stops at the limit when the server sent no length.
   *
   * @throws {StorageError} Code `BLOB_TOO_LARGE` for an object over the limit.
   */
  async get(ns, key) {
    const name = this.objectKey(ns, key);
    const where = { op: 'get', ns, key };
    const response = await this._send(
      'GetObjectCommand',
      { Key: name },
      { ...where, notFound: null }
    );
    if (!response) return null;
    const tooLarge = () =>
      new StorageError(
        `Blob ${ns}/${key} is larger than the limit of ${this._maxObjectBytes} stored bytes and was not read`,
        { code: 'BLOB_TOO_LARGE' }
      );
    const declared = Number.isSafeInteger(response.ContentLength) ? response.ContentLength : null;
    if (declared !== null && declared > this._maxObjectBytes) {
      response.Body?.destroy?.();
      throw tooLarge();
    }
    let data;
    try {
      data = await readBody(response.Body, this._maxObjectBytes);
    } catch (error) {
      throw mapS3Error(error, where);
    }
    if (data === null) throw tooLarge();
    if (declared !== null && data.length !== declared) {
      throw new StorageError(`Blob ${ns}/${key} arrived with ${data.length} of ${declared} bytes`, {
        code: 'STORAGE_UNAVAILABLE'
      });
    }
    return { key, bytes: data.length, data };
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
    const response = await this._send(
      'GetObjectCommand',
      { Key: name, Range: `bytes=0-${length - 1}` },
      { ...where, notFound: null }
    );
    if (!response) return null;
    try {
      // A server that ignores the range sends the whole object; stop at `length`.
      const chunks = [];
      let total = 0;
      for await (const chunk of response.Body) {
        chunks.push(chunk);
        total += chunk.length;
        if (total >= length) {
          response.Body.destroy?.();
          break;
        }
      }
      return Buffer.concat(chunks, total).subarray(0, length);
    } catch (error) {
      throw mapS3Error(error, where);
    }
  }

  /**
   * @inheritdoc
   *
   * Lock, `HeadObject`, `DeleteObject`: the delete that found the object is
   * the one that reports true.
   */
  async delete(ns, key) {
    const name = this.objectKey(ns, key);
    const where = { op: 'delete', ns, key };
    const claim = async () => {
      const found = await this._send(
        'HeadObjectCommand',
        { Key: name },
        { ...where, notFound: false }
      );
      if (found === false) return false;
      await this._send('DeleteObjectCommand', { Key: name }, where);
      return true;
    };
    if (this._locks) {
      const digest = crypto.createHash('sha256').update(name).digest('hex').slice(0, 32);
      return this._locks.withLock(`blob-delete:${digest}`, claim);
    }
    return this._exclusive(name, claim);
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
   * @returns {Promise<void>}
   * @throws {StorageError} With a `probeCode` saying which of them failed.
   */
  async headBucket() {
    const { client, commands } = await this._s3();
    try {
      await client.send(new commands.HeadBucketCommand({ Bucket: this._bucket }));
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
