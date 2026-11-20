// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Log seal `ihub-log-v1` — the encrypted form of append-log records and of the
 * blobs a stream spills (#2316).
 *
 * A sealed stream file holds two kinds of lines, one JSON object each:
 *
 *   {"$key":1,"id":"<16 hex>","kp":"local-file","kid":"1a2b3c4d","wk":"<base64 wrapped key>"}
 *   {"$enc":1,"seq":42,"k":"<id of a key line>","c":"<base64 stream of the record JSON>"}
 *
 * Every batch a log writes starts with one key line holding a fresh data key
 * and is followed by its records, so the key travels with the records it
 * protects and nothing has to be cached or shared between processes. `seq`
 * stays readable: a reader selects by it and opens only what it returns.
 *
 * Associated data:
 *
 *   key wrap:    JSON.stringify(["ihub/log-key/v1", tenant, stream, id])
 *   record:      JSON.stringify(["ihub/log/v1", tenant, stream, id, seq])
 *   spill blob:  "ihub/logblob/v1\n<tenant>\n<stream>\n<name>\n1048576"
 *
 * A record moved to another stream, another key line or another sequence
 * number does not open; after opening, the `seq` inside the record must equal
 * the one on the line. The record cipher is the `tink-aes-gcm-hkdf-v1` stream
 * with a fresh random salt per record, so a sequence number that is used twice
 * never repeats a nonce.
 *
 * A spill blob uses the blob envelope (`crypto/blobEnvelope.js`: `IHB1`,
 * 512-byte header, 1 MiB segments) with the associated data above. Its prefix
 * differs from the one of a namespace blob, so the two can never be swapped.
 *
 * Telling the three line kinds apart uses the own properties `$enc` and
 * `$key` only, never the content. A log must therefore refuse a caller's
 * record that has one of them ({@link hasReservedProperty}).
 *
 * `stream` is the canonical stream id: the path segments of the stream joined
 * with `:` (`run:abc`; a stream without a kind is `_:abc`).
 *
 * This module does no I/O. The key provider is handed in.
 *
 * @module crypto/logSeal
 */
import crypto from 'node:crypto';
import {
  BlobEnvelopeError,
  ENVELOPE_HEADER_BYTES,
  ENVELOPE_MIN_BYTES,
  ENVELOPE_SEGMENT_BYTES,
  decodeHeader,
  encodeHeader,
  plainLength
} from './blobEnvelope.js';
import { KEY_BYTES, StreamingAeadError, decrypt, encrypt } from './streamingAead.js';

/** Value of `$key` and `$enc`. */
const LINE_VERSION = 1;

/** A key line id: 16 hex characters. */
const KEY_ID_PATTERN = /^[0-9a-f]{16}$/;

/** Characters of standard base64. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * A sealed record, key line or spill blob cannot be built or opened:
 *
 * - `BAD_ADDRESS`: the tenant, stream or name is not usable
 * - `MALFORMED`: a line or an envelope is not in its format
 * - `KEY_PROVIDER_MISMATCH`: it names another key provider
 * - `VERIFY_FAILED`: the ciphertext does not verify here, or the record's
 *   inner `seq` differs from the line's
 *
 * A failure of the key provider itself (`KeyAccessDenied`) is not wrapped.
 */
export class LogSealError extends Error {
  /**
   * @param {string} message
   * @param {'BAD_ADDRESS'|'MALFORMED'|'KEY_PROVIDER_MISMATCH'|'VERIFY_FAILED'} code
   * @param {Object} [details] - `keyId`, `keyProviderId` the object names.
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'LogSealError';
    this.code = code;
    this.keyId = details.keyId ?? null;
    this.keyProviderId = details.keyProviderId ?? null;
  }
}

/** A tenant, stream or blob name usable in associated data. */
function assertPart(name, part) {
  if (typeof part !== 'string' || part.length === 0 || part.includes('\n')) {
    throw new LogSealError(`The log ${name} is not usable in an address`, 'BAD_ADDRESS');
  }
  return part;
}

/**
 * Associated data of the wrap of a batch key.
 *
 * @param {{tenant: string, stream: string, id: string}} address
 * @returns {string}
 */
export function logKeyAssociatedData({ tenant, stream, id }) {
  return JSON.stringify([
    'ihub/log-key/v1',
    assertPart('tenant', tenant),
    assertPart('stream', stream),
    assertPart('key id', id)
  ]);
}

/**
 * Associated data of one record.
 *
 * @param {{tenant: string, stream: string, id: string, seq: number}} address
 * @returns {string}
 *
 * @example
 * logRecordAssociatedData({ tenant: 'default', stream: 'run:r1', id: '00112233aabbccdd', seq: 7 });
 * // '["ihub/log/v1","default","run:r1","00112233aabbccdd",7]'
 */
export function logRecordAssociatedData({ tenant, stream, id, seq }) {
  if (!Number.isInteger(seq) || seq <= 0) {
    throw new LogSealError('The record seq is a positive integer', 'BAD_ADDRESS');
  }
  return JSON.stringify([
    'ihub/log/v1',
    assertPart('tenant', tenant),
    assertPart('stream', stream),
    assertPart('key id', id),
    seq
  ]);
}

/**
 * Associated data of one spill blob.
 *
 * @param {{tenant: string, stream: string, name: string}} address
 * @returns {string} `ihub/logblob/v1\n<tenant>\n<stream>\n<name>\n<segment size>`
 */
export function logBlobAssociatedData({ tenant, stream, name }) {
  return [
    'ihub/logblob/v1',
    assertPart('tenant', tenant),
    assertPart('stream', stream),
    assertPart('blob name', name),
    ENVELOPE_SEGMENT_BYTES
  ].join('\n');
}

/**
 * Whether a parsed line is a key line.
 *
 * @param {unknown} line
 * @returns {boolean}
 */
export function isKeyLine(line) {
  return Boolean(line) && Object.hasOwn(line, '$key') && line.$key === LINE_VERSION;
}

/**
 * Whether a parsed line is a sealed record.
 *
 * @param {unknown} line
 * @returns {boolean}
 */
export function isSealedLine(line) {
  return Boolean(line) && Object.hasOwn(line, '$enc') && line.$enc === LINE_VERSION;
}

/**
 * Whether a caller's record has a property the line format reserves. A log
 * refuses such a record in every mode: otherwise a caller could store a
 * plaintext record that reads as a sealed one.
 *
 * @param {unknown} entry
 * @returns {boolean}
 */
export function hasReservedProperty(entry) {
  return (
    Boolean(entry) &&
    typeof entry === 'object' &&
    (Object.hasOwn(entry, '$enc') || Object.hasOwn(entry, '$key'))
  );
}

/**
 * Whether a sealed record line has every member in its format.
 *
 * @param {Object} line
 * @returns {boolean}
 */
export function isWellFormedSealedLine(line) {
  return (
    isSealedLine(line) &&
    Number.isInteger(line.seq) &&
    line.seq > 0 &&
    typeof line.k === 'string' &&
    KEY_ID_PATTERN.test(line.k) &&
    typeof line.c === 'string' &&
    BASE64_PATTERN.test(line.c)
  );
}

/**
 * Whether a key line has every member in its format.
 *
 * @param {Object} line
 * @returns {boolean}
 */
export function isWellFormedKeyLine(line) {
  return (
    isKeyLine(line) &&
    typeof line.id === 'string' &&
    KEY_ID_PATTERN.test(line.id) &&
    typeof line.kp === 'string' &&
    line.kp.length > 0 &&
    typeof line.kid === 'string' &&
    line.kid.length > 0 &&
    typeof line.wk === 'string' &&
    BASE64_PATTERN.test(line.wk)
  );
}

/**
 * Create the key of one batch.
 *
 * @param {Object} options
 * @param {Object} options.keyProvider - `id`, `wrap(dataKey, aad)`.
 * @param {string} options.tenant
 * @param {string} options.stream - Canonical stream id.
 * @returns {Promise<{id: string, dataKey: Buffer, line: Object}>} `line` is
 *   written before the batch's records; the caller zeroes `dataKey` after use.
 * @throws {Error} What the key provider throws when it cannot wrap.
 */
export async function newBatchKey({ keyProvider, tenant, stream }) {
  const id = crypto.randomBytes(8).toString('hex');
  const dataKey = crypto.randomBytes(KEY_BYTES);
  try {
    const wrap = await keyProvider.wrap(dataKey, logKeyAssociatedData({ tenant, stream, id }));
    return {
      id,
      dataKey,
      line: {
        $key: LINE_VERSION,
        id,
        kp: keyProvider.id,
        kid: wrap.keyId,
        wk: wrap.wrapped.toString('base64')
      }
    };
  } catch (error) {
    dataKey.fill(0);
    throw error;
  }
}

/**
 * Seal one record under a batch key.
 *
 * @param {Object} options
 * @param {Buffer} options.dataKey - From {@link newBatchKey}.
 * @param {string} options.tenant
 * @param {string} options.stream - Canonical stream id.
 * @param {string} options.id - Id of the batch's key line.
 * @param {number} options.seq - The record's sequence number.
 * @param {string} options.json - The record as JSON text, `seq` included.
 * @returns {{$enc: number, seq: number, k: string, c: string}} The line to write.
 */
export function sealRecord({ dataKey, tenant, stream, id, seq, json }) {
  const aad = logRecordAssociatedData({ tenant, stream, id, seq });
  return {
    $enc: LINE_VERSION,
    seq,
    k: id,
    c: encrypt(Buffer.from(json, 'utf8'), dataKey, aad).toString('base64')
  };
}

/**
 * Unwrap the data key of a key line.
 *
 * @param {Object} options
 * @param {Object} options.keyProvider
 * @param {string} options.tenant
 * @param {string} options.stream - Canonical stream id of the file the line is in.
 * @param {Object} options.line - The parsed key line.
 * @returns {Promise<Buffer>} The data key; the caller zeroes it after use.
 * @throws {LogSealError} `MALFORMED` or `KEY_PROVIDER_MISMATCH`.
 * @throws {Error} What the key provider throws when it cannot unwrap.
 */
export async function openBatchKey({ keyProvider, tenant, stream, line }) {
  if (!isWellFormedKeyLine(line)) {
    throw new LogSealError('A key line of the stream is not readable', 'MALFORMED');
  }
  if (line.kp !== keyProvider.id) {
    throw new LogSealError(
      'The stream was sealed with another key provider',
      'KEY_PROVIDER_MISMATCH',
      { keyId: line.kid, keyProviderId: line.kp }
    );
  }
  return keyProvider.unwrap(
    Buffer.from(line.wk, 'base64'),
    line.kid,
    logKeyAssociatedData({ tenant, stream, id: line.id })
  );
}

/**
 * Open one sealed record.
 *
 * @param {Object} options
 * @param {Buffer} options.dataKey - From {@link openBatchKey} of the key line `line.k` names.
 * @param {string} options.tenant
 * @param {string} options.stream - Canonical stream id of the file the line is in.
 * @param {Object} options.line - The parsed sealed line.
 * @returns {Object} The record as it was appended.
 * @throws {LogSealError} `MALFORMED` or `VERIFY_FAILED`.
 */
export function openRecord({ dataKey, tenant, stream, line }) {
  if (!isWellFormedSealedLine(line)) {
    throw new LogSealError('A sealed record of the stream is not readable', 'MALFORMED');
  }
  const aad = logRecordAssociatedData({ tenant, stream, id: line.k, seq: line.seq });
  let record;
  try {
    record = JSON.parse(decrypt(Buffer.from(line.c, 'base64'), dataKey, aad).toString('utf8'));
  } catch (error) {
    if (!(error instanceof StreamingAeadError) && !(error instanceof SyntaxError)) throw error;
    throw new LogSealError(
      'A sealed record does not verify for its stream and seq',
      'VERIFY_FAILED'
    );
  }
  if (!record || typeof record !== 'object' || record.seq !== line.seq) {
    throw new LogSealError('A sealed record does not carry the seq of its line', 'VERIFY_FAILED');
  }
  return record;
}

/**
 * Whether stored bytes are a spill blob envelope: long enough and starting
 * with a well-formed header. Says nothing about whether it opens.
 *
 * @param {Buffer} head - The object, or at least its first 512 bytes.
 * @param {number} [storedBytes=head.length] - The object's full length.
 * @returns {boolean}
 */
export function isLogBlobEnvelope(head, storedBytes = head?.length) {
  if (!Buffer.isBuffer(head) || !(storedBytes >= ENVELOPE_MIN_BYTES)) return false;
  try {
    decodeHeader(head);
    plainLength(storedBytes);
    return true;
  } catch (error) {
    if (error instanceof BlobEnvelopeError) return false;
    throw error;
  }
}

/**
 * Seal one spill blob.
 *
 * @param {Object} options
 * @param {Object} options.keyProvider
 * @param {string} options.tenant
 * @param {string} options.stream - Canonical stream id.
 * @param {string} options.name - Blob name as it is stored.
 * @param {Buffer} options.plain - The payload.
 * @returns {Promise<Buffer>} Header and ciphertext.
 * @throws {Error} What the key provider throws when it cannot wrap.
 */
export async function sealLogBlob({ keyProvider, tenant, stream, name, plain }) {
  const aad = logBlobAssociatedData({ tenant, stream, name });
  const dataKey = crypto.randomBytes(KEY_BYTES);
  try {
    const wrap = await keyProvider.wrap(dataKey, aad);
    const header = encodeHeader({
      providerId: keyProvider.id,
      keyId: wrap.keyId,
      wrapped: wrap.wrapped
    });
    const body = encrypt(plain, dataKey, aad, { segmentBytes: ENVELOPE_SEGMENT_BYTES });
    return Buffer.concat([header, body]);
  } finally {
    dataKey.fill(0);
  }
}

/**
 * Open one spill blob.
 *
 * @param {Object} options
 * @param {Object} options.keyProvider
 * @param {string} options.tenant
 * @param {string} options.stream - Canonical stream id.
 * @param {string} options.name - Blob name as it is stored.
 * @param {Buffer} options.stored - The whole stored object.
 * @returns {Promise<Buffer>} The payload.
 * @throws {LogSealError} `MALFORMED`, `KEY_PROVIDER_MISMATCH` or `VERIFY_FAILED`.
 * @throws {Error} What the key provider throws when it cannot unwrap.
 */
export async function openLogBlob({ keyProvider, tenant, stream, name, stored }) {
  const aad = logBlobAssociatedData({ tenant, stream, name });
  let header;
  try {
    header = decodeHeader(stored);
  } catch (error) {
    if (!(error instanceof BlobEnvelopeError)) throw error;
    throw new LogSealError('The spill blob is not an envelope', 'MALFORMED');
  }
  const named = { keyId: header.keyId, keyProviderId: header.providerId };
  if (header.providerId !== keyProvider.id) {
    throw new LogSealError(
      'The spill blob was sealed with another key provider',
      'KEY_PROVIDER_MISMATCH',
      named
    );
  }
  const dataKey = await keyProvider.unwrap(header.wrapped, header.keyId, aad);
  try {
    return decrypt(stored.subarray(ENVELOPE_HEADER_BYTES), dataKey, aad, {
      segmentBytes: ENVELOPE_SEGMENT_BYTES
    });
  } catch (error) {
    if (!(error instanceof StreamingAeadError)) throw error;
    throw new LogSealError(
      'The spill blob does not verify for its stream and name',
      'VERIFY_FAILED',
      named
    );
  } finally {
    dataKey.fill(0);
  }
}
