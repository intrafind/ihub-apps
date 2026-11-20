// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Document seal `ihub-doc-v1` — the encrypted form of one stored document
 * (#2316). A document store calls this where it writes and reads its envelope;
 * the filesystem provider is the only caller today, a SQL provider would seal
 * its body column with the same functions.
 *
 * The sealed members of an envelope (version 3 on the filesystem):
 *
 *   enc   "ihub-doc-v1"
 *   kp    key provider id ("local-file")
 *   kid   master key id (8 hex characters for local-file)
 *   wk    base64 of the wrapped data key
 *   tag   base64 of the sealed etag: the 64 hex characters of the document's
 *         etag, encrypted like the body under its own associated data
 *   data  base64 of the `tink-aes-gcm-hkdf-v1` stream of the body JSON,
 *         1 MiB segments
 *
 * One random data key per write, wrapped by the key provider. The etag is
 * sealed because it is a hash of the plaintext: stored in the clear it would
 * let a reader of the disk confirm a guessed body.
 *
 * **Associated data** binds the ciphertext to where it belongs:
 *
 *   body and key wrap:  JSON.stringify(["ihub/doc/v1", tenant, ns, key, ownerId, contentType, 1048576])
 *   sealed etag:        JSON.stringify(["ihub/doc-etag/v1", tenant, ns, key, ownerId, contentType, 1048576])
 *
 * A JSON array, because owner ids are external strings (an e-mail address, an
 * OIDC subject) and may hold any character. A document copied to another key
 * or namespace does not open, and neither does one whose owner or content
 * type was edited in the head. `kp` and `kid` are hints and not authenticated:
 * a changed value only makes the document fail to open.
 *
 * The strings above and the member names are part of the format and recorded
 * in `server/tests/fixtures/document-seal/vectors.json`; they cannot change
 * without a new format id.
 *
 * This module does no I/O. The key provider is handed in.
 *
 * @module crypto/documentSeal
 */
import crypto from 'node:crypto';
import {
  DEFAULT_SEGMENT_BYTES,
  KEY_BYTES,
  StreamingAeadError,
  decrypt,
  encrypt
} from './streamingAead.js';

/** Value of `enc` in a sealed envelope. */
export const DOCUMENT_SEAL_FORMAT = 'ihub-doc-v1';

/** Ciphertext segment size of the body stream. A constant of the format. */
export const DOCUMENT_SEGMENT_BYTES = DEFAULT_SEGMENT_BYTES;

/** A document etag: sha256 hex. */
const ETAG_PATTERN = /^[0-9a-f]{64}$/;

/** Characters of standard base64. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * A sealed document cannot be built or opened. `code` says why in a word:
 *
 * - `BAD_ADDRESS`: the address handed in is not usable
 * - `MALFORMED`: a sealed member is missing or not in its format
 * - `KEY_PROVIDER_MISMATCH`: the document names another key provider
 * - `VERIFY_FAILED`: the ciphertext does not verify for this address
 *
 * The message never holds stored bytes. A failure of the key provider itself
 * (`KeyAccessDenied`) is not wrapped and reaches the caller as it is.
 */
export class DocumentSealError extends Error {
  /**
   * @param {string} message
   * @param {'BAD_ADDRESS'|'MALFORMED'|'KEY_PROVIDER_MISMATCH'|'VERIFY_FAILED'} code
   * @param {Object} [details] - `keyId`, `keyProviderId` the document names.
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'DocumentSealError';
    this.code = code;
    this.keyId = details.keyId ?? null;
    this.keyProviderId = details.keyProviderId ?? null;
  }
}

/**
 * @typedef {Object} DocumentAddress
 * @property {string} tenant - `default` until tenants exist.
 * @property {string} ns - Namespace.
 * @property {string} key - Document key.
 * @property {string|null} ownerId - Owner as stored in the envelope head.
 * @property {string} contentType - Content type as stored in the envelope head.
 */

/**
 * Validate an address and return its parts in the order they are bound.
 *
 * @param {DocumentAddress} address
 * @returns {Array<string|null>}
 * @throws {DocumentSealError} Code `BAD_ADDRESS`.
 */
function addressParts({ tenant, ns, key, ownerId, contentType } = {}) {
  for (const [name, part] of [
    ['tenant', tenant],
    ['namespace', ns],
    ['key', key],
    ['content type', contentType]
  ]) {
    if (typeof part !== 'string' || part.length === 0) {
      throw new DocumentSealError(
        `The document ${name} is not usable in an address`,
        'BAD_ADDRESS'
      );
    }
  }
  if (ownerId !== null && (typeof ownerId !== 'string' || ownerId.length === 0)) {
    throw new DocumentSealError('The document owner is a non-empty string or null', 'BAD_ADDRESS');
  }
  return [tenant, ns, key, ownerId, contentType];
}

/**
 * Associated data of a document body and of the wrap of its data key.
 *
 * @param {DocumentAddress} address
 * @returns {string}
 * @throws {DocumentSealError} Code `BAD_ADDRESS`.
 *
 * @example
 * documentAssociatedData({ tenant: 'default', ns: 'chats', key: 'c1', ownerId: 'a@b.c', contentType: 'application/json' });
 * // '["ihub/doc/v1","default","chats","c1","a@b.c","application/json",1048576]'
 */
export function documentAssociatedData(address) {
  return JSON.stringify(['ihub/doc/v1', ...addressParts(address), DOCUMENT_SEGMENT_BYTES]);
}

/**
 * Associated data of the sealed etag. Differs from the body's, so the two
 * ciphertexts of one document cannot be swapped.
 *
 * @param {DocumentAddress} address
 * @returns {string}
 * @throws {DocumentSealError} Code `BAD_ADDRESS`.
 */
export function documentEtagAssociatedData(address) {
  return JSON.stringify(['ihub/doc-etag/v1', ...addressParts(address), DOCUMENT_SEGMENT_BYTES]);
}

/**
 * Whether the head of an envelope carries every sealed member in its format.
 * Says nothing about whether it opens. `data` is not looked at: a head read
 * stops before it.
 *
 * @param {Object} head - Envelope, or the members before `data`.
 * @returns {boolean}
 */
export function isSealedHead(head) {
  return (
    Boolean(head) &&
    head.enc === DOCUMENT_SEAL_FORMAT &&
    typeof head.kp === 'string' &&
    head.kp.length > 0 &&
    typeof head.kid === 'string' &&
    head.kid.length > 0 &&
    typeof head.wk === 'string' &&
    BASE64_PATTERN.test(head.wk) &&
    typeof head.tag === 'string' &&
    BASE64_PATTERN.test(head.tag)
  );
}

/**
 * Seal one document body.
 *
 * @param {Object} options
 * @param {Object} options.keyProvider - `id`, `wrap(dataKey, aad)`, see `crypto/KeyProvider.js`.
 * @param {DocumentAddress} options.address - Where the document is stored.
 * @param {string} options.json - The body as JSON text, as it is returned on read.
 * @param {string} options.etag - The document's etag (sha256 hex of the canonical body).
 * @returns {Promise<{enc: string, kp: string, kid: string, wk: string, tag: string, data: string}>}
 *   The sealed members, `data` last: spread them at the end of the envelope.
 * @throws {DocumentSealError} Code `BAD_ADDRESS` or `MALFORMED` (the etag).
 * @throws {Error} What the key provider throws when it cannot wrap.
 *
 * @example
 * const sealed = await sealDocument({ keyProvider, address, json: '{"title":"x"}', etag });
 * const envelope = { v: 3, key, ownerId, contentType, createdAt, updatedAt, size, ...sealed };
 */
export async function sealDocument({ keyProvider, address, json, etag }) {
  const bodyAad = documentAssociatedData(address);
  const etagAad = documentEtagAssociatedData(address);
  if (typeof json !== 'string') {
    throw new DocumentSealError('The document body is JSON text', 'MALFORMED');
  }
  if (typeof etag !== 'string' || !ETAG_PATTERN.test(etag)) {
    throw new DocumentSealError('The document etag is a sha256 hex digest', 'MALFORMED');
  }
  const dataKey = crypto.randomBytes(KEY_BYTES);
  try {
    const wrap = await keyProvider.wrap(dataKey, bodyAad);
    const options = { segmentBytes: DOCUMENT_SEGMENT_BYTES };
    return {
      enc: DOCUMENT_SEAL_FORMAT,
      kp: keyProvider.id,
      kid: wrap.keyId,
      wk: wrap.wrapped.toString('base64'),
      tag: encrypt(Buffer.from(etag, 'ascii'), dataKey, etagAad, options).toString('base64'),
      data: encrypt(Buffer.from(json, 'utf8'), dataKey, bodyAad, options).toString('base64')
    };
  } finally {
    dataKey.fill(0);
  }
}

/**
 * Unwrap the data key a sealed head names.
 *
 * @param {Object} keyProvider
 * @param {Object} head
 * @param {string} bodyAad
 * @returns {Promise<Buffer>}
 */
async function unwrapDataKey(keyProvider, head, bodyAad) {
  if (!isSealedHead(head)) {
    throw new DocumentSealError('The sealed members of the document are not readable', 'MALFORMED');
  }
  const named = { keyId: head.kid, keyProviderId: head.kp };
  // The id comes from stored bytes. It selects nothing but this one provider.
  if (head.kp !== keyProvider.id) {
    throw new DocumentSealError(
      'The document was sealed with another key provider',
      'KEY_PROVIDER_MISMATCH',
      named
    );
  }
  return keyProvider.unwrap(Buffer.from(head.wk, 'base64'), head.kid, bodyAad);
}

/**
 * Decrypt one sealed member.
 *
 * @param {string} base64
 * @param {Buffer} dataKey
 * @param {string} aad
 * @param {Object} head
 * @returns {Buffer}
 */
function openMember(base64, dataKey, aad, head) {
  try {
    return decrypt(Buffer.from(base64, 'base64'), dataKey, aad, {
      segmentBytes: DOCUMENT_SEGMENT_BYTES
    });
  } catch (error) {
    if (!(error instanceof StreamingAeadError)) throw error;
    throw new DocumentSealError('The document does not verify for this address', 'VERIFY_FAILED', {
      keyId: head.kid,
      keyProviderId: head.kp
    });
  }
}

/**
 * Read the etag from a sealed tag.
 *
 * @param {Buffer} plain
 * @param {Object} head
 * @returns {string}
 */
function etagOf(plain, head) {
  const etag = plain.toString('ascii');
  if (!ETAG_PATTERN.test(etag)) {
    throw new DocumentSealError('The sealed etag is not an etag', 'VERIFY_FAILED', {
      keyId: head.kid,
      keyProviderId: head.kp
    });
  }
  return etag;
}

/**
 * Open the etag of a sealed document from its head, without the body. This
 * also authenticates the `ownerId` and `contentType` the address was built
 * from: with another owner or content type the tag does not open.
 *
 * @param {Object} options
 * @param {Object} options.keyProvider
 * @param {DocumentAddress} options.address - Built from the request (`ns`, `key`) and the head.
 * @param {Object} options.head - The members before `data`.
 * @returns {Promise<string>} The document's etag.
 * @throws {DocumentSealError} `MALFORMED`, `KEY_PROVIDER_MISMATCH` or `VERIFY_FAILED`.
 * @throws {Error} What the key provider throws when it cannot unwrap.
 */
export async function openDocumentEtag({ keyProvider, address, head }) {
  const bodyAad = documentAssociatedData(address);
  const etagAad = documentEtagAssociatedData(address);
  const dataKey = await unwrapDataKey(keyProvider, head, bodyAad);
  try {
    return etagOf(openMember(head.tag, dataKey, etagAad, head), head);
  } finally {
    dataKey.fill(0);
  }
}

/**
 * Open a sealed document: its body and its etag.
 *
 * @param {Object} options
 * @param {Object} options.keyProvider
 * @param {DocumentAddress} options.address - Built from the request (`ns`, `key`) and the head.
 * @param {Object} options.envelope - The whole stored envelope.
 * @returns {Promise<{json: string, etag: string}>} The body as JSON text and the etag.
 * @throws {DocumentSealError} `MALFORMED`, `KEY_PROVIDER_MISMATCH` or `VERIFY_FAILED`.
 * @throws {Error} What the key provider throws when it cannot unwrap.
 */
export async function openDocument({ keyProvider, address, envelope }) {
  const bodyAad = documentAssociatedData(address);
  const etagAad = documentEtagAssociatedData(address);
  if (typeof envelope?.data !== 'string' || !BASE64_PATTERN.test(envelope.data)) {
    throw new DocumentSealError('The sealed body of the document is not readable', 'MALFORMED');
  }
  const dataKey = await unwrapDataKey(keyProvider, envelope, bodyAad);
  try {
    const etag = etagOf(openMember(envelope.tag, dataKey, etagAad, envelope), envelope);
    const json = openMember(envelope.data, dataKey, bodyAad, envelope).toString('utf8');
    return { json, etag };
  } finally {
    dataKey.fill(0);
  }
}
