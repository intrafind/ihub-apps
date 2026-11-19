// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Blob envelope v1 — the layout of one encrypted blob as the encrypting blob
 * store (`storage/EncryptingBlobStore.js`) hands it to a backend.
 *
 * One object, no sidecar and no object metadata:
 *
 *   offset 0    4   magic "IHB1"
 *          4    1   envelope version = 1
 *          5    1   length of the key provider id (n1)
 *          6    1   length of the master key id (n2)
 *          7    2   length of the wrapped data key (n3, big-endian)
 *          9   n1   key provider id, ASCII ("local-file")
 *              n2   master key id, ASCII (8 hex characters for local-file)
 *              n3   wrapped data key (61 bytes for local-file)
 *          ..       zero bytes up to offset 512
 *        512   ..   `tink-aes-gcm-hkdf-v1` stream, 1 MiB segments
 *
 * **The header length (512) and the segment size (1 MiB) are constants of
 * version 1.** They make the payload length a pure function of the object
 * length, which is how a listing reports payload sizes without reading a
 * single object. Changing either needs a new version with its own magic and a
 * way to read version 1; the recorded vectors in
 * `server/tests/fixtures/blob-envelope/vectors.json` guard that.
 *
 * Nothing in the header is trusted. The provider id and the key id only select
 * a key; a changed value makes the unwrap fail. The associated data is built
 * from the address the caller asked for ({@link blobAssociatedData}), never
 * read from the object, so an object copied to another key, namespace or
 * tenant does not open. No JSON is parsed from stored bytes.
 *
 * This module is pure: no I/O and no key access.
 *
 * @module crypto/blobEnvelope
 */
import {
  DEFAULT_SEGMENT_BYTES,
  StreamingAeadError,
  ciphertextLength,
  plaintextLength
} from './streamingAead.js';

/** First four bytes of every envelope. */
export const ENVELOPE_MAGIC = Buffer.from('IHB1', 'ascii');

/** The only envelope version there is. */
export const ENVELOPE_VERSION = 1;

/** Bytes before the ciphertext stream. A constant of version 1. */
export const ENVELOPE_HEADER_BYTES = 512;

/** Ciphertext segment size of the stream. A constant of version 1. */
export const ENVELOPE_SEGMENT_BYTES = DEFAULT_SEGMENT_BYTES;

/** Offset of the first variable-length field. */
const FIXED_BYTES = 9;

/** Characters allowed in a tenant, namespace or key: the id alphabet of `pathSecurity`. */
const ADDRESS_PART = /^[A-Za-z0-9._-]+$/;

/** Characters allowed in a key provider id and a master key id. */
const HEADER_ID = /^[A-Za-z0-9._:-]+$/;

/** Stored length of an empty payload: the smallest object that can be an envelope. */
export const ENVELOPE_MIN_BYTES = ENVELOPE_HEADER_BYTES + ciphertextLength(0);

/**
 * An object is not a readable envelope. `code` says why in a word, for logs
 * and tests; the message never holds stored bytes.
 */
export class BlobEnvelopeError extends Error {
  /**
   * @param {string} message
   * @param {'NOT_AN_ENVELOPE'|'UNKNOWN_VERSION'|'MALFORMED_HEADER'|'BAD_LENGTH'|'BAD_ADDRESS'} code
   */
  constructor(message, code) {
    super(message);
    this.name = 'BlobEnvelopeError';
    this.code = code;
  }
}

/**
 * The associated data of one blob: the format version, its logical address
 * and the segment size, newline separated. Never the bucket, the endpoint or
 * the key prefix: moving a bucket or changing the prefix keeps every object
 * readable, while copying an object to another key, namespace or tenant makes
 * it unreadable.
 *
 * The string is part of envelope version 1 and recorded in the test vectors;
 * it cannot change without a new version.
 *
 * @param {{tenant: string, ns: string, key: string}} address
 * @returns {string} `ihub/blob/v1\n<tenant>\n<ns>\n<key>\n<segment size>`
 * @throws {BlobEnvelopeError} Code `BAD_ADDRESS` when a part is missing or
 *   holds a character outside `[A-Za-z0-9._-]`, so no part can hold the
 *   separator.
 *
 * @example
 * blobAssociatedData({ tenant: 'default', ns: 'chat-files', key: 'chat__a__f1.txt' });
 * // 'ihub/blob/v1\ndefault\nchat-files\nchat__a__f1.txt\n1048576'
 */
export function blobAssociatedData({ tenant, ns, key } = {}) {
  for (const [name, part] of [
    ['tenant', tenant],
    ['namespace', ns],
    ['key', key]
  ]) {
    if (typeof part !== 'string' || !ADDRESS_PART.test(part)) {
      throw new BlobEnvelopeError(`The blob ${name} is not usable in an address`, 'BAD_ADDRESS');
    }
  }
  return [`ihub/blob/v${ENVELOPE_VERSION}`, tenant, ns, key, ENVELOPE_SEGMENT_BYTES].join('\n');
}

/**
 * Build the 512-byte header.
 *
 * @param {{providerId: string, keyId: string, wrapped: Buffer}} fields
 * @returns {Buffer} Exactly {@link ENVELOPE_HEADER_BYTES} bytes.
 * @throws {BlobEnvelopeError} Code `MALFORMED_HEADER` when a field is empty,
 *   not ASCII, or the three do not fit.
 */
export function encodeHeader({ providerId, keyId, wrapped } = {}) {
  if (typeof providerId !== 'string' || !HEADER_ID.test(providerId) || providerId.length > 255) {
    throw new BlobEnvelopeError('The key provider id does not fit a header', 'MALFORMED_HEADER');
  }
  if (typeof keyId !== 'string' || !HEADER_ID.test(keyId) || keyId.length > 255) {
    throw new BlobEnvelopeError('The master key id does not fit a header', 'MALFORMED_HEADER');
  }
  if (!Buffer.isBuffer(wrapped) || wrapped.length === 0) {
    throw new BlobEnvelopeError('The wrapped key is missing', 'MALFORMED_HEADER');
  }
  const provider = Buffer.from(providerId, 'ascii');
  const id = Buffer.from(keyId, 'ascii');
  if (FIXED_BYTES + provider.length + id.length + wrapped.length > ENVELOPE_HEADER_BYTES) {
    throw new BlobEnvelopeError('The key fields do not fit a header', 'MALFORMED_HEADER');
  }
  const header = Buffer.alloc(ENVELOPE_HEADER_BYTES);
  ENVELOPE_MAGIC.copy(header, 0);
  header[4] = ENVELOPE_VERSION;
  header[5] = provider.length;
  header[6] = id.length;
  header.writeUInt16BE(wrapped.length, 7);
  let offset = FIXED_BYTES;
  for (const part of [provider, id, wrapped]) {
    part.copy(header, offset);
    offset += part.length;
  }
  return header;
}

/**
 * Read the header of a stored object.
 *
 * @param {Buffer} stored - The whole object, or at least its first 512 bytes.
 * @returns {{providerId: string, keyId: string, wrapped: Buffer}} `wrapped` is a copy.
 * @throws {BlobEnvelopeError} `NOT_AN_ENVELOPE` when the magic is missing
 *   (plaintext where ciphertext is expected), `UNKNOWN_VERSION`, or
 *   `MALFORMED_HEADER` for lengths that leave the header, ids outside the
 *   allowed characters, or padding that is not zero.
 */
export function decodeHeader(stored) {
  if (!Buffer.isBuffer(stored) || stored.length < ENVELOPE_HEADER_BYTES) {
    throw new BlobEnvelopeError('The object is too short to be an envelope', 'NOT_AN_ENVELOPE');
  }
  if (!stored.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC)) {
    throw new BlobEnvelopeError('The object does not start with an envelope', 'NOT_AN_ENVELOPE');
  }
  if (stored[4] !== ENVELOPE_VERSION) {
    throw new BlobEnvelopeError(`Unknown envelope version ${stored[4]}`, 'UNKNOWN_VERSION');
  }
  const providerLength = stored[5];
  const keyIdLength = stored[6];
  const wrappedLength = stored.readUInt16BE(7);
  const end = FIXED_BYTES + providerLength + keyIdLength + wrappedLength;
  if (providerLength === 0 || keyIdLength === 0 || wrappedLength === 0) {
    throw new BlobEnvelopeError('The envelope header has an empty field', 'MALFORMED_HEADER');
  }
  if (end > ENVELOPE_HEADER_BYTES) {
    throw new BlobEnvelopeError('The envelope header fields do not fit', 'MALFORMED_HEADER');
  }
  for (let index = end; index < ENVELOPE_HEADER_BYTES; index++) {
    if (stored[index] !== 0) {
      throw new BlobEnvelopeError('The envelope header padding is not empty', 'MALFORMED_HEADER');
    }
  }
  let offset = FIXED_BYTES;
  const providerId = stored.toString('latin1', offset, offset + providerLength);
  offset += providerLength;
  const keyId = stored.toString('latin1', offset, offset + keyIdLength);
  offset += keyIdLength;
  if (!HEADER_ID.test(providerId) || !HEADER_ID.test(keyId)) {
    throw new BlobEnvelopeError('The envelope header ids are not readable', 'MALFORMED_HEADER');
  }
  return {
    providerId,
    keyId,
    wrapped: Buffer.from(stored.subarray(offset, offset + wrappedLength))
  };
}

/**
 * Stored length of a payload of `plainBytes` bytes.
 *
 * @param {number} plainBytes
 * @returns {number}
 *
 * @example
 * storedLength(0); // 568
 */
export function storedLength(plainBytes) {
  return ENVELOPE_HEADER_BYTES + ciphertextLength(plainBytes, ENVELOPE_SEGMENT_BYTES);
}

/**
 * Payload length inside a stored object of `storedBytes` bytes, from the
 * length alone.
 *
 * @param {number} storedBytes - Object size as a listing reports it.
 * @returns {number}
 * @throws {BlobEnvelopeError} Code `BAD_LENGTH` when no envelope has that length.
 */
export function plainLength(storedBytes) {
  if (!Number.isSafeInteger(storedBytes) || storedBytes < ENVELOPE_MIN_BYTES) {
    throw new BlobEnvelopeError('The object is too short to be an envelope', 'BAD_LENGTH');
  }
  try {
    return plaintextLength(storedBytes - ENVELOPE_HEADER_BYTES, ENVELOPE_SEGMENT_BYTES);
  } catch (error) {
    if (error instanceof StreamingAeadError) {
      throw new BlobEnvelopeError('No envelope has this length', 'BAD_LENGTH');
    }
    throw error;
  }
}
