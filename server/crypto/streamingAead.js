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
 * The associated data is mandatory: a missing or empty value throws. An
 * object encrypted with none is bound to nothing and can be swapped with any
 * other object under the same data key, and no test would notice.
 *
 * Used by the project text store (`services/projects`) and by the encrypting
 * blob store (`storage/EncryptingBlobStore.js`), which is why it lives here
 * and not under a domain service.
 *
 * @module crypto/streamingAead
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

/**
 * The associated data as bytes. A non-empty string or Buffer is required.
 *
 * @param {Buffer|string} associatedData
 * @returns {Buffer}
 * @throws {StreamingAeadError} When it is missing, empty or of another type.
 */
export function associatedDataBytes(associatedData) {
  if (Buffer.isBuffer(associatedData) && associatedData.length > 0) return associatedData;
  if (typeof associatedData === 'string' && associatedData.length > 0) {
    return Buffer.from(associatedData, 'utf8');
  }
  throw new StreamingAeadError('The associated data must be a non-empty string or Buffer');
}

function deriveKey(dataKey, salt, associatedData) {
  if (!Buffer.isBuffer(dataKey) || dataKey.length !== KEY_BYTES) {
    throw new StreamingAeadError(`A data key has ${KEY_BYTES} bytes`);
  }
  const info = associatedDataBytes(associatedData);
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
 * @param {{segmentBytes?: number, leadingBytes?: number}} [options] -
 *   `leadingBytes` reserves that many bytes in front of the ciphertext, in the
 *   same buffer, for a caller that stores its own header there (the blob
 *   envelope) and would otherwise copy the whole ciphertext to join the two.
 *   The reserved bytes are zero; the ciphertext itself is the same either way.
 * @returns {Buffer} `leadingBytes` zero bytes (none by default), then the
 *   header followed by the segments.
 * @throws {StreamingAeadError} For a segment size or `leadingBytes` out of range.
 *
 * @example
 * const stored = encrypt(plain, dataKey, aad, { leadingBytes: 512 });
 * myHeader.copy(stored, 0); // stored.subarray(512) is the ciphertext
 */
export function encrypt(
  plaintext,
  dataKey,
  associatedData,
  { segmentBytes = DEFAULT_SEGMENT_BYTES, leadingBytes = 0 } = {}
) {
  checkSegmentSize(segmentBytes);
  if (!Number.isSafeInteger(leadingBytes) || leadingBytes < 0) {
    throw new StreamingAeadError('The reserved leading length is not usable');
  }
  const input = Buffer.isBuffer(plaintext)
    ? plaintext
    : Buffer.from(String(plaintext ?? ''), 'utf8');
  const salt = crypto.randomBytes(SALT_BYTES);
  const noncePrefix = crypto.randomBytes(NONCE_PREFIX_BYTES);
  const key = deriveKey(dataKey, salt, associatedData);

  const firstPlain = segmentBytes - HEADER_BYTES - TAG_BYTES;
  const otherPlain = segmentBytes - TAG_BYTES;
  // One buffer of the final length, filled segment by segment: the ciphertext
  // is held once, not once as pieces and once joined.
  const output = Buffer.allocUnsafe(leadingBytes + ciphertextLength(input.length, segmentBytes));
  output.fill(0, 0, leadingBytes);
  output[leadingBytes] = HEADER_BYTES;
  salt.copy(output, leadingBytes + 1);
  noncePrefix.copy(output, leadingBytes + 1 + SALT_BYTES);
  let written = leadingBytes + HEADER_BYTES;
  let offset = 0;
  let index = 0;
  // An empty plaintext is one empty last segment, as Tink writes it.
  do {
    const size = index === 0 ? firstPlain : otherPlain;
    const end = Math.min(input.length, offset + size);
    const piece = input.subarray(offset, end);
    offset = end;
    const last = offset >= input.length;
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonceOf(noncePrefix, index, last), {
      authTagLength: TAG_BYTES
    });
    for (const part of [cipher.update(piece), cipher.final(), cipher.getAuthTag()]) {
      written += part.copy(output, written);
    }
    index += 1;
    if (index > 0xffffffff) throw new StreamingAeadError('Too many segments');
  } while (offset < input.length);
  return output;
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

  // One buffer for the plaintext, filled segment by segment. Every segment
  // carries one tag, so this is the plaintext length of a well-formed stream
  // and at least that of any stream the loop below accepts.
  const segments = Math.ceil(ciphertext.length / segmentBytes);
  const output = Buffer.allocUnsafe(
    Math.max(0, ciphertext.length - HEADER_BYTES - segments * TAG_BYTES)
  );
  let written = 0;
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
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      nonceOf(noncePrefix, index, last),
      { authTagLength: TAG_BYTES }
    );
    decipher.setAuthTag(tag);
    let plain;
    try {
      // GCM is a stream mode: `update` returns every byte, `final` only checks the tag.
      plain = decipher.update(body);
      decipher.final();
    } catch {
      throw new StreamingAeadError('Ciphertext does not verify');
    }
    // Nothing of a segment is kept before its tag was checked.
    written += plain.copy(output, written);
    offset = end;
    index += 1;
    if (last) break;
  }
  return output.subarray(0, written);
}

/**
 * Length of the ciphertext {@link encrypt} produces for a plaintext length.
 *
 * @param {number} plainBytes - Plaintext length, 0 or more.
 * @param {number} [segmentBytes]
 * @returns {number} Header, segments and tags together.
 * @throws {StreamingAeadError} When `plainBytes` is not a length.
 *
 * @example
 * ciphertextLength(0);  // 56: header (40) and one empty segment's tag (16)
 */
export function ciphertextLength(plainBytes, segmentBytes = DEFAULT_SEGMENT_BYTES) {
  checkSegmentSize(segmentBytes);
  if (!Number.isSafeInteger(plainBytes) || plainBytes < 0) {
    throw new StreamingAeadError('A plaintext length is a non-negative integer');
  }
  const firstPlain = segmentBytes - HEADER_BYTES - TAG_BYTES;
  const otherPlain = segmentBytes - TAG_BYTES;
  const segments =
    plainBytes <= firstPlain ? 1 : 1 + Math.ceil((plainBytes - firstPlain) / otherPlain);
  return HEADER_BYTES + plainBytes + segments * TAG_BYTES;
}

/**
 * Length of the plaintext inside a ciphertext of a given length, without
 * reading it. The inverse of {@link ciphertextLength}: what lets a listing
 * report payload sizes from object sizes.
 *
 * @param {number} cipherBytes - Ciphertext length.
 * @param {number} [segmentBytes]
 * @returns {number}
 * @throws {StreamingAeadError} When no plaintext encrypts to that length.
 */
export function plaintextLength(cipherBytes, segmentBytes = DEFAULT_SEGMENT_BYTES) {
  checkSegmentSize(segmentBytes);
  if (!Number.isSafeInteger(cipherBytes) || cipherBytes < HEADER_BYTES + TAG_BYTES) {
    throw new StreamingAeadError('Ciphertext is too short');
  }
  // Header and first segment fill one `segmentBytes` block, every further
  // segment another one, so the segment count is the block count.
  const segments = Math.ceil(cipherBytes / segmentBytes);
  const lastSegment = cipherBytes - (segments - 1) * segmentBytes;
  // A segment after the first holds at least one byte: `encrypt` ends on the
  // segment that took the last byte and never appends an empty one.
  if (segments > 1 && lastSegment <= TAG_BYTES) {
    throw new StreamingAeadError('No plaintext encrypts to this ciphertext length');
  }
  return cipherBytes - HEADER_BYTES - segments * TAG_BYTES;
}

/** A fresh data key. */
export function newDataKey() {
  return crypto.randomBytes(KEY_BYTES);
}
