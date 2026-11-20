// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * File seal — the encrypted form of one file of a store that keeps its files
 * outside the storage layer (agent artifacts, agent memory, agent inboxes,
 * tool-job results, the short-link file; see `storage/atRest/sealedFiles.js`).
 *
 * The stored bytes are the blob envelope of `crypto/blobEnvelope.js`: a
 * 512-byte header that starts with `IHB1` and names the key provider, the
 * master key id and the wrapped data key, followed by the
 * `tink-aes-gcm-hkdf-v1` stream of the content in 1 MiB segments. One random
 * data key per write, wrapped by the key provider.
 *
 * **Associated data** binds the ciphertext to its place, for the key wrap and
 * for the content alike:
 *
 *   JSON.stringify(["ihub/file/v1", tenant, store, name, 1048576])
 *
 * `store` is the id of the store (`agent-memory`), `name` the file's path
 * inside it with `/` as the separator (`research.md`, `<runId>/report.md`).
 * A sealed file copied to another name or another store does not open, and
 * neither does a blob or a spill blob of the storage layer put in its place:
 * their associated data starts with another label.
 *
 * The label and the order of the parts are part of the format; they cannot
 * change without a new label.
 *
 * This module does no I/O. The key provider is handed in.
 *
 * @module crypto/fileSeal
 */
import crypto from 'node:crypto';
import { pipeline } from 'node:stream';
import {
  BlobEnvelopeError,
  ENVELOPE_HEADER_BYTES,
  ENVELOPE_MIN_BYTES,
  ENVELOPE_SEGMENT_BYTES,
  decodeHeader,
  encodeHeader,
  plainLength
} from './blobEnvelope.js';
import { createOpeningStream } from './envelopeStreams.js';
import { KEY_BYTES, StreamingAeadError, decrypt, encrypt } from './streamingAead.js';

/** First part of the associated data. */
export const FILE_SEAL_LABEL = 'ihub/file/v1';

/**
 * A sealed file cannot be built or opened:
 *
 * - `BAD_ADDRESS`: the tenant, store or name is not usable
 * - `MALFORMED`: the stored bytes are not an envelope
 * - `KEY_PROVIDER_MISMATCH`: the file names another key provider
 * - `VERIFY_FAILED`: the ciphertext does not verify for this store and name
 *
 * The message never holds stored bytes. A failure of the key provider itself
 * (`KeyAccessDenied`) is not wrapped and reaches the caller as it is.
 */
export class FileSealError extends Error {
  /**
   * @param {string} message
   * @param {'BAD_ADDRESS'|'MALFORMED'|'KEY_PROVIDER_MISMATCH'|'VERIFY_FAILED'} code
   * @param {Object} [details] - `keyId`, `keyProviderId` the file names.
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'FileSealError';
    this.code = code;
    this.keyId = details.keyId ?? null;
    this.keyProviderId = details.keyProviderId ?? null;
  }
}

/**
 * Associated data of one sealed file.
 *
 * @param {{tenant: string, store: string, name: string}} address
 * @returns {string}
 * @throws {FileSealError} Code `BAD_ADDRESS`.
 *
 * @example
 * fileAssociatedData({ tenant: 'default', store: 'agent-memory', name: 'research.md' });
 * // '["ihub/file/v1","default","agent-memory","research.md",1048576]'
 */
export function fileAssociatedData({ tenant, store, name } = {}) {
  for (const [label, part] of [
    ['tenant', tenant],
    ['store', store],
    ['name', name]
  ]) {
    if (typeof part !== 'string' || part.length === 0) {
      throw new FileSealError(`The file ${label} is not usable in an address`, 'BAD_ADDRESS');
    }
  }
  return JSON.stringify([FILE_SEAL_LABEL, tenant, store, name, ENVELOPE_SEGMENT_BYTES]);
}

/**
 * Whether stored bytes are a sealed file: long enough and starting with a
 * well-formed envelope header. Says nothing about whether it opens.
 *
 * @param {Buffer} head - The file, or at least its first 512 bytes.
 * @param {number} [storedBytes=head.length] - The file's full length.
 * @returns {boolean}
 */
export function isSealedFile(head, storedBytes = head?.length) {
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
 * Seal the content of one file.
 *
 * @param {Object} options
 * @param {Object} options.keyProvider
 * @param {string} options.tenant
 * @param {string} options.store - Store id.
 * @param {string} options.name - The file's path inside the store.
 * @param {Buffer} options.plain - The content.
 * @returns {Promise<Buffer>} Header and ciphertext.
 * @throws {Error} What the key provider throws when it cannot wrap.
 */
export async function sealFile({ keyProvider, tenant, store, name, plain }) {
  const aad = fileAssociatedData({ tenant, store, name });
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
 * Open one sealed file.
 *
 * @param {Object} options
 * @param {Object} options.keyProvider
 * @param {string} options.tenant
 * @param {string} options.store - Store id.
 * @param {string} options.name - The file's path inside the store.
 * @param {Buffer} options.stored - The whole stored file.
 * @returns {Promise<Buffer>} The content.
 * @throws {FileSealError} `MALFORMED`, `KEY_PROVIDER_MISMATCH` or `VERIFY_FAILED`.
 * @throws {Error} What the key provider throws when it cannot unwrap.
 */
export async function openFile({ keyProvider, tenant, store, name, stored }) {
  const { dataKey, aad, named } = await unwrapFileKey({
    keyProvider,
    tenant,
    store,
    name,
    head: stored
  });
  try {
    return decrypt(stored.subarray(ENVELOPE_HEADER_BYTES), dataKey, aad, {
      segmentBytes: ENVELOPE_SEGMENT_BYTES
    });
  } catch (error) {
    if (!(error instanceof StreamingAeadError)) throw error;
    throw verifyFailed(named);
  } finally {
    dataKey.fill(0);
  }
}

/** The error for a sealed file whose content does not verify. */
function verifyFailed(named) {
  return new FileSealError('The file does not verify for its store and name', 'VERIFY_FAILED', {
    ...named
  });
}

/**
 * Read the header of a sealed file and unwrap its data key.
 *
 * @param {Object} options
 * @param {Object} options.keyProvider
 * @param {string} options.tenant
 * @param {string} options.store - Store id.
 * @param {string} options.name - The file's path inside the store.
 * @param {Buffer} options.head - The stored file, or at least its first 512 bytes.
 * @returns {Promise<{dataKey: Buffer, aad: string, named: {keyId: string, keyProviderId: string}}>}
 *   The caller wipes `dataKey`.
 * @throws {FileSealError} `MALFORMED` or `KEY_PROVIDER_MISMATCH`.
 * @throws {Error} What the key provider throws when it cannot unwrap.
 */
async function unwrapFileKey({ keyProvider, tenant, store, name, head }) {
  const aad = fileAssociatedData({ tenant, store, name });
  let header;
  try {
    header = decodeHeader(head);
  } catch (error) {
    if (!(error instanceof BlobEnvelopeError)) throw error;
    throw new FileSealError('The file is not an envelope', 'MALFORMED');
  }
  const named = { keyId: header.keyId, keyProviderId: header.providerId };
  if (header.providerId !== keyProvider.id) {
    throw new FileSealError(
      'The file was sealed with another key provider',
      'KEY_PROVIDER_MISMATCH',
      named
    );
  }
  return { dataKey: await keyProvider.unwrap(header.wrapped, header.keyId, aad), aad, named };
}

/**
 * Open one sealed file as a stream: {@link openFile} without the file in
 * memory. The content is decrypted and handed on one 1 MiB segment at a time,
 * each only after its tag verified.
 *
 * Resolves after the first segment verified, so a file that does not open at
 * all (not an envelope, another key, a wrong store or name) rejects here. A
 * file that is damaged or cut further in makes the stream fail with
 * `VERIFY_FAILED` after it handed out the segments before; it never ends
 * cleanly. See `./envelopeStreams.js` for what the consumer owes.
 *
 * @param {Object} options
 * @param {Object} options.keyProvider
 * @param {string} options.tenant
 * @param {string} options.store - Store id.
 * @param {string} options.name - The file's path inside the store.
 * @param {Buffer} options.head - The first 512 bytes of the stored file.
 * @param {number} options.storedBytes - The stored file's size.
 * @param {import('node:stream').Readable} options.source - The stored file
 *   from byte 512 on. Destroyed when the opening fails or the consumer leaves.
 * @param {(error: Error) => Error} [options.mapError] - Translates a
 *   {@link FileSealError} of the stream into the error the consumer gets.
 * @returns {Promise<{bytes: number, stream: import('node:stream').Readable}>}
 *   `bytes` is the length of the content.
 * @throws {FileSealError} `MALFORMED`, `KEY_PROVIDER_MISMATCH` or `VERIFY_FAILED`.
 * @throws {Error} What the key provider throws when it cannot unwrap.
 */
export async function openFileStream({
  keyProvider,
  tenant,
  store,
  name,
  head,
  storedBytes,
  source,
  mapError = error => error
}) {
  let unwrapped;
  let bytes;
  try {
    unwrapped = await unwrapFileKey({ keyProvider, tenant, store, name, head });
    try {
      bytes = plainLength(storedBytes);
    } catch (error) {
      unwrapped.dataKey.fill(0);
      if (!(error instanceof BlobEnvelopeError)) throw error;
      throw verifyFailed(unwrapped.named);
    }
  } catch (error) {
    source.destroy();
    throw error;
  }
  const { dataKey, aad, named } = unwrapped;
  const opening = createOpeningStream({
    begin: () => ({ dataKey, aad, expectedBytes: bytes }),
    mapError: error => mapError(error instanceof StreamingAeadError ? verifyFailed(named) : error)
  });
  pipeline(source, opening, () => {});
  await opening.ready;
  return { bytes, stream: opening };
}
