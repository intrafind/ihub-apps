// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Streaming AEAD in the Tink `AesGcmHkdfStreaming` format (spec 3 §6.2,
 * #2906): the one ciphertext format both products read, implemented here on
 * `node:crypto` so the Java side can open iHub objects with Tink unchanged.
 *
 *   header   = headerLength (1 byte, 40) || salt (32 bytes) || noncePrefix (7 bytes)
 *   derived  = HKDF-SHA256(ikm = dataKey, salt, info = associatedData, 32 bytes)
 *   segments = ciphertextSegmentSize bytes each (1 MiB by default);
 *              the first plaintext segment is segmentSize − headerLength − 16 bytes,
 *              every other one segmentSize − 16, the last may be shorter
 *   nonce_i  = noncePrefix || i (4 bytes big-endian, from 0) || lastSegment (1 byte)
 *   segment  = AES-256-GCM(derived, nonce_i, plaintext_i, aad = empty) || tag
 *
 * The associated data binds the ciphertext to its object through the key
 * derivation, as Tink does; each GCM segment carries no AAD of its own.
 * Decryption fails on a wrong key or associated data, a reordered,
 * truncated or extended stream, and on any flipped byte.
 *
 * @module services/projects/crypto/streamingAead
 */
import crypto from 'node:crypto';

/** Format id recorded on every item (spec 1 §3). */
export const FORMAT_ID = 'tink-aes-gcm-hkdf-v1';

/** Bytes of a data key and of the derived key. */
export const KEY_BYTES = 32;

/** Default ciphertext segment size: 1 MiB, as the storage concept fixes it. */
export const DEFAULT_SEGMENT_BYTES = 1024 * 1024;

const SALT_BYTES = KEY_BYTES;
const NONCE_PREFIX_BYTES = 7;
const HEADER_BYTES = 1 + SALT_BYTES + NONCE_PREFIX_BYTES;
const TAG_BYTES = 16;
const NONCE_BYTES = 12;

/** Smallest segment that still holds the header, one byte and a tag. */
const MIN_SEGMENT_BYTES = HEADER_BYTES + TAG_BYTES + 1;

export class StreamingAeadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StreamingAeadError';
  }
}

function deriveKey(dataKey, salt, associatedData) {
  if (!Buffer.isBuffer(dataKey) || dataKey.length !== KEY_BYTES) {
    throw new StreamingAeadError(`A data key has ${KEY_BYTES} bytes`);
  }
  const info = Buffer.isBuffer(associatedData)
    ? associatedData
    : Buffer.from(String(associatedData ?? ''), 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', dataKey, salt, info, KEY_BYTES));
}

function nonceOf(prefix, index, last) {
  const nonce = Buffer.alloc(NONCE_BYTES);
  prefix.copy(nonce, 0);
  nonce.writeUInt32BE(index, NONCE_PREFIX_BYTES);
  nonce[NONCE_BYTES - 1] = last ? 1 : 0;
  return nonce;
}

function checkSegmentSize(segmentBytes) {
  if (!Number.isInteger(segmentBytes) || segmentBytes < MIN_SEGMENT_BYTES) {
    throw new StreamingAeadError(`The segment size must be at least ${MIN_SEGMENT_BYTES} bytes`);
  }
}

/**
 * Encrypt a whole buffer.
 *
 * @param {Buffer} plaintext
 * @param {Buffer} dataKey - 32 random bytes.
 * @param {Buffer|string} associatedData
 * @param {{segmentBytes?: number}} [options]
 * @returns {Buffer} header followed by the segments.
 */
export function encrypt(
  plaintext,
  dataKey,
  associatedData,
  { segmentBytes = DEFAULT_SEGMENT_BYTES } = {}
) {
  checkSegmentSize(segmentBytes);
  const input = Buffer.isBuffer(plaintext)
    ? plaintext
    : Buffer.from(String(plaintext ?? ''), 'utf8');
  const salt = crypto.randomBytes(SALT_BYTES);
  const noncePrefix = crypto.randomBytes(NONCE_PREFIX_BYTES);
  const key = deriveKey(dataKey, salt, associatedData);
  const header = Buffer.concat([Buffer.from([HEADER_BYTES]), salt, noncePrefix]);

  const firstPlain = segmentBytes - HEADER_BYTES - TAG_BYTES;
  const otherPlain = segmentBytes - TAG_BYTES;
  const chunks = [header];
  let offset = 0;
  let index = 0;
  // An empty plaintext is one empty last segment, as Tink writes it.
  do {
    const size = index === 0 ? firstPlain : otherPlain;
    const end = Math.min(input.length, offset + size);
    const piece = input.subarray(offset, end);
    offset = end;
    const last = offset >= input.length;
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonceOf(noncePrefix, index, last));
    chunks.push(cipher.update(piece), cipher.final(), cipher.getAuthTag());
    index += 1;
    if (index > 0xffffffff) throw new StreamingAeadError('Too many segments');
  } while (offset < input.length);
  return Buffer.concat(chunks);
}

/**
 * Decrypt a whole buffer.
 *
 * @param {Buffer} ciphertext
 * @param {Buffer} dataKey
 * @param {Buffer|string} associatedData
 * @param {{segmentBytes?: number}} [options]
 * @returns {Buffer}
 * @throws {StreamingAeadError} When the stream does not verify.
 */
export function decrypt(
  ciphertext,
  dataKey,
  associatedData,
  { segmentBytes = DEFAULT_SEGMENT_BYTES } = {}
) {
  checkSegmentSize(segmentBytes);
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length < HEADER_BYTES + TAG_BYTES) {
    throw new StreamingAeadError('Ciphertext is too short');
  }
  if (ciphertext[0] !== HEADER_BYTES) throw new StreamingAeadError('Unknown header');
  const salt = ciphertext.subarray(1, 1 + SALT_BYTES);
  const noncePrefix = ciphertext.subarray(1 + SALT_BYTES, HEADER_BYTES);
  const key = deriveKey(dataKey, salt, associatedData);

  const chunks = [];
  let offset = HEADER_BYTES;
  let index = 0;
  const firstCipher = segmentBytes - HEADER_BYTES;
  while (true) {
    const size = index === 0 ? firstCipher : segmentBytes;
    const end = Math.min(ciphertext.length, offset + size);
    const segment = ciphertext.subarray(offset, end);
    if (segment.length < TAG_BYTES) throw new StreamingAeadError('Truncated segment');
    const last = end >= ciphertext.length;
    const body = segment.subarray(0, segment.length - TAG_BYTES);
    const tag = segment.subarray(segment.length - TAG_BYTES);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonceOf(noncePrefix, index, last));
    decipher.setAuthTag(tag);
    try {
      chunks.push(decipher.update(body), decipher.final());
    } catch {
      throw new StreamingAeadError('Ciphertext does not verify');
    }
    offset = end;
    index += 1;
    if (last) break;
  }
  return Buffer.concat(chunks);
}

/** The associated data of a project item's text blob (spec 3 §5). */
export function associatedDataOf({ tenant = 'default', projectId, itemId, versionId }) {
  return `ihub/project-files/${tenant}/${projectId}/${itemId}/${versionId}`;
}

/** A fresh data key. */
export function newDataKey() {
  return crypto.randomBytes(KEY_BYTES);
}
