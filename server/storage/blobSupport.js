// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What every blob store does the same way: page sizes, the list cursor, key
 * order and payload coercion. Shared so two backends page identically and a
 * cursor means the same thing on each of them.
 *
 * @module storage/blobSupport
 */
import { Readable } from 'node:stream';
import { StorageError } from './errors.js';

const DEFAULT_LIMIT = 100;
const MIN_LIMIT = 1;

/** Largest page a blob listing returns; also what `ListObjectsV2` allows. */
export const MAX_BLOB_PAGE = 1000;

/**
 * Clamp a caller's page size into the supported range instead of throwing.
 *
 * @param {unknown} limit
 * @returns {number} 1 to {@link MAX_BLOB_PAGE}; 100 when `limit` is not a number.
 */
export function clampBlobLimit(limit) {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT;
  const value = Number(limit);
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_BLOB_PAGE, Math.max(MIN_LIMIT, Math.floor(value)));
}

/**
 * Key ordering: plain code-unit comparison, so every provider pages identically.
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1|0|1}
 */
export function compareBlobKeys(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * The cursor for "everything after this key".
 *
 * @param {string} key - Last key of the page handed out.
 * @returns {string}
 */
export function encodeBlobCursor(key) {
  return Buffer.from(JSON.stringify({ k: key })).toString('base64url');
}

/**
 * The key a cursor stands for.
 *
 * @param {string} cursor
 * @returns {string}
 * @throws {StorageError} Code `INVALID_CURSOR` when it is not one of ours.
 */
export function decodeBlobCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (!parsed || typeof parsed.k !== 'string') throw new Error('cursor carries no key');
    return parsed.k;
  } catch (cause) {
    throw new StorageError('Invalid blob list cursor', { code: 'INVALID_CURSOR', cause });
  }
}

/**
 * Coerce accepted payload input into a Buffer without copying when possible.
 *
 * @param {Buffer|Uint8Array|string} data - Payload as the caller passed it.
 * @returns {Buffer}
 * @throws {StorageError} Code `INVALID_DATA` for anything else.
 */
export function toBlobBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  throw new StorageError('Blob data must be a Buffer, Uint8Array or string', {
    code: 'INVALID_DATA'
  });
}

/**
 * The error for a stream that does not hold the bytes it was declared with.
 *
 * @param {string} what - The blob, for the message (`<ns>/<key>`).
 * @param {number} arrived - Bytes that arrived until the mismatch showed.
 * @param {number} declared - Declared length.
 * @returns {StorageError} Code `INVALID_DATA`.
 */
export function streamLengthError(what, arrived, declared) {
  return new StorageError(
    `The stream for blob ${what} has ${arrived > declared ? 'more than ' : `${arrived} of `}${declared} declared bytes`,
    { code: 'INVALID_DATA' }
  );
}

/**
 * Check the declared length of a `putStream` call. On a failure the stream is
 * destroyed, so a caller never has to clean up after a rejected call.
 *
 * @param {unknown} bytes - `opts.bytes`.
 * @param {import('node:stream').Readable} stream - The payload stream.
 * @returns {number} The length.
 * @throws {StorageError} Code `INVALID_DATA` when the length is missing or
 *   not a length, or `stream` is not a readable stream.
 */
export function assertStreamLength(bytes, stream) {
  const readable = stream && typeof stream.pipe === 'function' && typeof stream.on === 'function';
  if (readable && Number.isSafeInteger(bytes) && bytes >= 0) return bytes;
  if (readable) stream.destroy();
  throw new StorageError(
    readable
      ? 'putStream needs the length of the payload (opts.bytes)'
      : 'putStream needs a readable stream',
    { code: 'INVALID_DATA' }
  );
}

/**
 * Read a stream of a declared length into one Buffer.
 *
 * @param {import('node:stream').Readable} stream
 * @param {number} bytes - Declared length; the stream must deliver exactly this.
 * @param {string} what - The blob, for the message.
 * @returns {Promise<Buffer>}
 * @throws {StorageError} Code `INVALID_DATA` for another length. What the
 *   stream fails with is thrown as it is.
 */
export async function collectStream(stream, bytes, what) {
  const target = Buffer.allocUnsafe(bytes);
  let total = 0;
  // Leaving the loop by a throw destroys the stream.
  for await (const chunk of stream) {
    if (total + chunk.length > bytes) throw streamLengthError(what, total + chunk.length, bytes);
    total += Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).copy(target, total);
  }
  if (total !== bytes) throw streamLengthError(what, total, bytes);
  return target;
}

/**
 * Make a stream fail with a storage error instead of the raw error of its
 * source (a file system error, a socket error). The error is translated where
 * the stream is destroyed, so no stream is put in between and no chunk copied.
 *
 * @param {import('node:stream').Readable} stream - A stream this module's
 *   caller created and owns.
 * @param {(error: Error) => Error} map - Translates an error that is not a
 *   `StorageError` already.
 * @returns {import('node:stream').Readable} The same stream.
 */
export function mapStreamError(stream, map) {
  const destroy = stream._destroy.bind(stream);
  stream._destroy = (error, callback) =>
    destroy(error && !(error instanceof StorageError) ? map(error) : error, callback);
  return stream;
}

/**
 * Open a blob for reading through any store: `openRead` where the store has
 * it (every `BlobStore`), else `get` wrapped as a stream, for a hand-written
 * test double that has `get` and nothing else.
 *
 * @param {Object} store - A blob store.
 * @param {string} ns - Namespace.
 * @param {string} key - Key within the namespace.
 * @returns {Promise<{key: string, bytes: number, stream: import('node:stream').Readable}|null>}
 */
export async function openBlobRead(store, ns, key) {
  if (typeof store.openRead === 'function') return store.openRead(ns, key);
  const blob = await store.get(ns, key);
  if (!blob?.data) return null;
  return {
    key,
    bytes: blob.data.length,
    stream: guardStream(Readable.from([blob.data], { objectMode: false }))
  };
}

/**
 * Keep a stream that is handed out through a promise from taking the process
 * down when it fails before its consumer listens.
 *
 * A stream's failure is announced on the next tick, the code that awaits the
 * promise resumes only after that, and an `'error'` event nobody listens for
 * is thrown as an uncaught exception. With this listener the failure is only
 * recorded on the stream (`stream.errored`), and every way of consuming a
 * stream that looks at its state still reports it: `for await`, `pipeline`,
 * `finished`, and `sendStream` (`utils/streamResponse.js`). A consumer that
 * only listens for `'error'` itself must use one of those instead.
 *
 * @param {import('node:stream').Readable} stream
 * @returns {import('node:stream').Readable} The same stream.
 */
export function guardStream(stream) {
  stream.on('error', () => {});
  return stream;
}
