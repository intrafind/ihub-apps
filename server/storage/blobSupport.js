// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What every blob store does the same way: page sizes, the list cursor, key
 * order and payload coercion. Shared so two backends page identically and a
 * cursor means the same thing on each of them.
 *
 * @module storage/blobSupport
 */
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
