// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * EncryptingBlobStore — a blob store that encrypts payloads before they reach
 * the store behind it, and authenticates what it reads back.
 *
 * It is a decorator over any {@link BlobStore}: the inner store sees opaque
 * bytes and knows nothing about keys. The composition (`StorageRegistry`)
 * puts it in front of the filesystem blob store and of the S3 store alike.
 * There is no list of namespaces that are left out: a blob a domain service
 * already encrypted (`project-files`) is encrypted a second time.
 *
 * Each blob gets its own random data key. The data key is wrapped by the
 * master key the injected {@link module:crypto/KeyProvider~KeyProvider} holds,
 * and the wrapped key travels in a fixed 512-byte header in front of the
 * ciphertext (`crypto/blobEnvelope.js`). Ciphertext and wrapped key are bound
 * to the blob's address (tenant, namespace, key), built from the request and
 * never read from the object.
 *
 * ## Modes (`storage.encryption.enabled`)
 *
 * | `encryptWrites` | `plaintextReads` | Writes | Reading a plaintext object |
 * | --- | --- | --- | --- |
 * | true | `reject` (strict) | encrypted | `CORRUPT_BLOB` |
 * | true | `accept` | encrypted | returned as stored |
 * | false | (always `accept`) | plaintext | returned as stored |
 *
 * An encrypted object is decrypted in every mode, so switching encryption off
 * loses nothing. `accept` with `encryptWrites` is for a store that still holds
 * plaintext from before encryption was switched on, until
 * `encryptExistingBlobs()` has converted it; after that the store is strict.
 * **In an `accept` mode whoever can write to the inner store can plant
 * plaintext that is served as content.** Only the strict mode protects
 * against that.
 *
 * How an object is recognised in an `accept` mode: it is an envelope when it
 * is at least 568 bytes long and its first 512 bytes are a well-formed
 * version 1 header (magic, version, field lengths, zero padding). Such an
 * object is always decrypted and a failure is an error; it is never handed
 * out as stored. Anything else is plaintext.
 *
 * ## What the callers see
 *
 * - `put` returns the length and the SHA-256 of the **payload**, computed
 *   before encryption. The hash is never sent to the inner store.
 * - `get` returns the payload; `openRead` streams it, decrypted segment by
 *   segment, and `putStream` seals a stream the same way. Both read and
 *   write the objects `get` and `put` do.
 * - `list` and `scan` report the payload length; `scan` walks the inner
 *   store's own `scan`. In the strict mode it is
 *   computed from the stored length and no object is read. A stored length
 *   alone cannot tell a plaintext object from an envelope (almost every
 *   length of 568 bytes or more is a possible envelope length), so in an
 *   `accept` mode a listing reads the first 512 bytes of each object that is
 *   long enough to be one (`inner.readHead`, a local read on the filesystem
 *   and a ranged request on S3). A store that never held an envelope (see
 *   {@link EncryptingBlobStore#detectEnvelopes}) is listed and read with no
 *   such look at all.
 *
 * Failures are never folded into "absent":
 * - {@link CorruptBlobError} (`CORRUPT_BLOB`): in the strict mode no envelope
 *   (plaintext where ciphertext is expected); in every mode a changed header
 *   or ciphertext, a truncated or extended object, an object moved to another
 *   key.
 * - {@link KeyUnavailableError} (`KEY_UNAVAILABLE`): the master key is not
 *   initialized, or the object names a master key or a key provider this
 *   installation does not hold.
 *
 * Memory: a payload is held about three times during an encrypted `put`
 * (payload, ciphertext, the stored object) and twice during `get`;
 * `maxBlobBytes` bounds what is accepted. `openRead` and `putStream` hold a
 * few 1 MiB segments whatever the size of the object.
 *
 * @module storage/EncryptingBlobStore
 */
import crypto from 'node:crypto';
import { pipeline } from 'node:stream';
import logger from '../utils/logger.js';
import {
  BlobEnvelopeError,
  ENVELOPE_HEADER_BYTES,
  ENVELOPE_MIN_BYTES,
  ENVELOPE_SEGMENT_BYTES,
  blobAssociatedData,
  decodeHeader,
  encodeHeader,
  plainLength,
  storedLength
} from '../crypto/blobEnvelope.js';
import { createOpeningStream, createSealingStream } from '../crypto/envelopeStreams.js';
import { StreamingAeadError, decrypt, encrypt, newDataKey } from '../crypto/streamingAead.js';
import { BlobStore } from './BlobStore.js';
import { assertStreamLength, guardStream, streamLengthError, toBlobBuffer } from './blobSupport.js';
import { CorruptBlobError, KeyUnavailableError, StorageError } from './errors.js';
import { assertValidBlobKey, assertValidNamespace } from './keys.js';
import { INTERNAL_BLOB_NAMESPACE } from './namespaces.js';

const COMPONENT = 'EncryptingBlobStore';

/**
 * Largest payload accepted when the caller configures none: 128 MiB, the
 * default of `storage.blobs.s3.maxObjectBytes`.
 */
export const DEFAULT_MAX_BLOB_BYTES = 128 * 1024 * 1024;

/** Key of the key check object in {@link INTERNAL_BLOB_NAMESPACE}. */
export const KEY_CHECK_KEY = 'keycheck';

/** Format number inside the key check object. */
const KEY_CHECK_FORMAT = 1;

/** Keys with an impossible stored length already reported by a listing. */
const MAX_REPORTED_KEYS = 1000;

/** Listed objects whose head is read at once in an `accept` mode. */
const HEAD_READ_CONCURRENCY = 16;

/** Reasons a key provider gives that mean "the key is not here". */
const KEY_MISSING_REASONS = new Set(['not-initialized', 'unknown-key', 'unknown-provider']);

/**
 * Stored length of a payload of the largest accepted size: what an inner
 * store must be willing to read back.
 *
 * @param {number} maxBlobBytes
 * @returns {number}
 */
export function maxStoredBytes(maxBlobBytes = DEFAULT_MAX_BLOB_BYTES) {
  return storedLength(maxBlobBytes);
}

/**
 * Whether stored bytes are an envelope: long enough and starting with a
 * well-formed version 1 header. Says nothing about whether it decrypts.
 *
 * @param {Buffer} head - The object, or at least its first 512 bytes.
 * @param {number} [storedBytes=head.length] - The object's full length.
 * @returns {boolean}
 */
export function isBlobEnvelope(head, storedBytes = head?.length) {
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
 * Blob store decorator: envelope encryption around an inner store.
 */
export class EncryptingBlobStore extends BlobStore {
  /**
   * @param {Object} options
   * @param {BlobStore} options.inner - The store that keeps the ciphertext.
   * @param {Object|(() => Object)} options.keyProvider - The key provider that
   *   wraps new data keys and unwraps stored ones (see `crypto/KeyProvider.js`),
   *   or a function returning it. A function is called on every use, so the
   *   provider may be registered after this store is built.
   * @param {string} [options.tenant='default'] - Tenant part of the address.
   * @param {number} [options.maxBlobBytes] - Largest payload `put` accepts.
   * @param {boolean} [options.encryptWrites=true] - Encrypt what `put` stores.
   *   False stores payloads as they are and still decrypts stored envelopes.
   * @param {'reject'|'accept'} [options.plaintextReads='reject'] - What a read
   *   does with a stored object that is not an envelope: `reject` (strict)
   *   throws `CORRUPT_BLOB`, `accept` returns it. Always `accept` when
   *   `encryptWrites` is false.
   * @param {{read: (options?: {migrate?: boolean}) => Promise<Buffer|null>,
   *   write: (data: Buffer) => Promise<void>}} [options.keyCheckStore] - Where
   *   the key check object is kept when that is not the inner store itself
   *   (`atRest/localKeyCheck.js` for a data directory). The object is the
   *   same encrypted blob either way.
   */
  constructor({
    inner,
    keyProvider,
    tenant = 'default',
    maxBlobBytes,
    encryptWrites = true,
    plaintextReads = 'reject',
    keyCheckStore = null
  } = {}) {
    super();
    if (!inner || typeof inner.put !== 'function' || typeof inner.get !== 'function') {
      throw new StorageError('EncryptingBlobStore needs an inner blob store', {
        code: 'INVALID_PROVIDER'
      });
    }
    if (!keyProvider) {
      throw new StorageError('EncryptingBlobStore needs a key provider', {
        code: 'INVALID_PROVIDER'
      });
    }
    this._inner = inner;
    this._keyProvider = keyProvider;
    this._tenant = tenant;
    this._maxBlobBytes =
      Number.isSafeInteger(maxBlobBytes) && maxBlobBytes > 0
        ? maxBlobBytes
        : DEFAULT_MAX_BLOB_BYTES;
    if (plaintextReads !== 'reject' && plaintextReads !== 'accept') {
      throw new StorageError("plaintextReads is 'reject' or 'accept'", {
        code: 'INVALID_PROVIDER'
      });
    }
    this._encryptWrites = encryptWrites !== false;
    this._acceptPlaintext = !this._encryptWrites || plaintextReads === 'accept';
    // Whether the inner store may hold envelopes. Always when this store
    // writes them; a store with encryption off learns it from
    // `detectEnvelopes()` and stays on the safe side until then.
    this._holdsEnvelopes = true;
    this._keyCheckStore = keyCheckStore || null;
    this._reportedKeys = new Set();
    // Fails here, not on the first write, when the tenant is not usable.
    blobAssociatedData({ tenant, ns: 'ns', key: 'key' });
  }

  /** The store that keeps the ciphertext. */
  get inner() {
    return this._inner;
  }

  /** Largest payload `put` accepts, in bytes. */
  get maxBlobBytes() {
    return this._maxBlobBytes;
  }

  /** Whether `put` encrypts. */
  get encryptsWrites() {
    return this._encryptWrites;
  }

  /** Whether a stored object that is not an envelope is returned (`accept`) or refused. */
  get acceptsPlaintext() {
    return this._acceptPlaintext;
  }

  /**
   * Find out whether the inner store has ever held an envelope, for a store
   * with encryption off: it has when the key check object exists, because that
   * is written before the first encrypted blob. Without one, every object is
   * plaintext, and reads and listings pass through with no look at the bytes,
   * exactly as the inner store alone would answer.
   *
   * A store that encrypts its writes always holds envelopes; nothing is read.
   *
   * @returns {Promise<boolean>} Whether envelopes are expected from now on.
   */
  async detectEnvelopes() {
    if (this._encryptWrites) return true;
    this._holdsEnvelopes = (await this._readKeyCheck({ migrate: true })) !== null;
    return this._holdsEnvelopes;
  }

  /**
   * The stored key check object, as stored.
   *
   * @param {Object} [options]
   * @param {boolean} [options.migrate=false] - Let a key check store move an
   *   object it finds at a former place.
   * @returns {Promise<Buffer|null>}
   * @private
   */
  async _readKeyCheck({ migrate = false } = {}) {
    if (this._keyCheckStore) return this._keyCheckStore.read({ migrate });
    return (await this._inner.get(INTERNAL_BLOB_NAMESPACE, KEY_CHECK_KEY))?.data ?? null;
  }

  /**
   * The key provider in use.
   *
   * @returns {Object}
   * @throws {KeyUnavailableError} When it cannot be resolved.
   * @private
   */
  _provider() {
    try {
      const provider =
        typeof this._keyProvider === 'function' ? this._keyProvider() : this._keyProvider;
      if (!provider || typeof provider.wrap !== 'function') {
        throw new Error('The key provider is not available');
      }
      return provider;
    } catch (cause) {
      throw new KeyUnavailableError(`The key provider is not available: ${cause.message}`, {
        cause
      });
    }
  }

  /**
   * Validate an address and build its associated data.
   *
   * @param {string} ns
   * @param {string} key
   * @returns {string}
   * @throws {InvalidKeyError} For a namespace or key that is not a safe id.
   * @private
   */
  _aad(ns, key) {
    assertValidNamespace(ns);
    assertValidBlobKey(key);
    return blobAssociatedData({ tenant: this._tenant, ns, key });
  }

  /**
   * Translate a key provider failure into a storage error.
   *
   * @param {Error} error
   * @param {Object} where - `{ ns, key, keyId, keyProviderId }`
   * @returns {StorageError}
   * @private
   */
  _keyError(error, { ns, key, keyId = null, keyProviderId = null }) {
    if (error?.name !== 'KeyAccessDenied' && error?.name !== 'UnknownKeyProviderError') {
      return new StorageError(`The key provider failed for blob ${ns}/${key}`, {
        code: 'IO_ERROR',
        cause: error
      });
    }
    if (KEY_MISSING_REASONS.has(error.reason)) {
      return new KeyUnavailableError(
        `The key for blob ${ns}/${key} is not available: ${error.message}`,
        { keyId: error.keyId ?? keyId, keyProviderId, cause: error }
      );
    }
    return new CorruptBlobError(`Blob ${ns}/${key} does not open with its key`, { cause: error });
  }

  /**
   * Encrypt one payload for an address.
   *
   * @param {string} ns
   * @param {string} key
   * @param {Buffer} plain
   * @param {string} aad
   * @returns {Promise<Buffer>} Header and ciphertext.
   * @private
   */
  async _seal(ns, key, plain, aad) {
    const provider = this._provider();
    const dataKey = newDataKey();
    try {
      let wrap;
      try {
        wrap = await provider.wrap(dataKey, aad);
      } catch (error) {
        throw this._keyError(error, { ns, key, keyProviderId: provider.id });
      }
      const header = encodeHeader({
        providerId: provider.id,
        keyId: wrap.keyId,
        wrapped: wrap.wrapped
      });
      // The ciphertext is written behind room for the header, so the stored
      // object is built once and not joined from two buffers.
      const sealed = encrypt(plain, dataKey, aad, {
        segmentBytes: ENVELOPE_SEGMENT_BYTES,
        leadingBytes: header.length
      });
      header.copy(sealed, 0);
      return sealed;
    } finally {
      dataKey.fill(0);
    }
  }

  /**
   * Open one stored object for an address.
   *
   * @param {string} ns
   * @param {string} key
   * @param {Buffer} stored
   * @param {string} aad
   * @returns {Promise<Buffer>} The payload.
   * @throws {CorruptBlobError|KeyUnavailableError}
   * @private
   */
  async _open(ns, key, stored, aad) {
    const dataKey = await this._dataKeyOf(ns, key, stored, stored?.length, aad);
    try {
      return decrypt(stored.subarray(ENVELOPE_HEADER_BYTES), dataKey, aad, {
        segmentBytes: ENVELOPE_SEGMENT_BYTES
      });
    } catch (error) {
      if (!(error instanceof StreamingAeadError)) throw error;
      throw new CorruptBlobError(`Blob ${ns}/${key} does not verify`, { cause: error });
    } finally {
      dataKey.fill(0);
    }
  }

  /**
   * The data key of one stored object, unwrapped from its header.
   *
   * @param {string} ns
   * @param {string} key
   * @param {Buffer} head - The object, or at least its first 512 bytes.
   * @param {number} storedBytes - The object's full length.
   * @param {string} aad
   * @returns {Promise<Buffer>} The data key; the caller wipes it.
   * @throws {CorruptBlobError} When the object is no envelope of this store.
   * @throws {KeyUnavailableError} When the key it names is not here.
   * @private
   */
  async _dataKeyOf(ns, key, head, storedBytes, aad) {
    let header;
    try {
      if (!Buffer.isBuffer(head) || !(storedBytes >= ENVELOPE_MIN_BYTES)) {
        throw new BlobEnvelopeError('The object is too short to be an envelope', 'NOT_AN_ENVELOPE');
      }
      header = decodeHeader(head);
    } catch (error) {
      if (!(error instanceof BlobEnvelopeError)) throw error;
      throw new CorruptBlobError(
        `Blob ${ns}/${key} is not an encrypted blob of this store (${error.code})`,
        { cause: error }
      );
    }
    const where = { ns, key, keyId: header.keyId, keyProviderId: header.providerId };
    const provider = this._provider();
    // The id comes from stored bytes. It selects nothing but this one
    // provider: another id is a key this installation does not hold.
    if (header.providerId !== provider.id) {
      throw new KeyUnavailableError(
        `Blob ${ns}/${key} was written with key provider '${header.providerId}', which is not the configured one`,
        { keyId: header.keyId, keyProviderId: header.providerId }
      );
    }
    try {
      return await provider.unwrap(header.wrapped, header.keyId, aad);
    } catch (error) {
      throw this._keyError(error, where);
    }
  }

  /**
   * Log a stored blob that could not be opened, as `get` and `openRead` do.
   *
   * @param {string} ns
   * @param {string} key
   * @param {Error} error
   * @returns {void}
   * @private
   */
  _reportUnreadable(ns, key, error) {
    if (!(error instanceof CorruptBlobError) && !(error instanceof KeyUnavailableError)) return;
    logger.error('A stored blob could not be opened', {
      component: COMPONENT,
      ns,
      key,
      code: error.code,
      keyId: error.keyId ?? undefined,
      reason: error.cause?.code || error.cause?.reason || error.cause?.message
    });
  }

  /**
   * @inheritdoc
   *
   * `bytes` and `sha256` describe the payload, not the stored object. The
   * `contentType` hint is dropped: a media type on an encrypted object says
   * what the bytes are.
   *
   * With `encryptWrites` off the payload is stored as it is.
   *
   * @throws {StorageError} Code `BLOB_TOO_LARGE` above `maxBlobBytes`.
   * @throws {KeyUnavailableError} When the data key cannot be wrapped. Nothing
   *   is written in that case; there is no plaintext fallback.
   */
  async put(ns, key, data, _opts = {}) {
    const aad = this._aad(ns, key);
    const plain = toBlobBuffer(data);
    if (plain.length > this._maxBlobBytes) {
      throw new StorageError(
        `Blob ${ns}/${key} has ${plain.length} bytes; the limit is ${this._maxBlobBytes}`,
        { code: 'BLOB_TOO_LARGE' }
      );
    }
    // Stored as it is: the inner store's own answer describes the payload.
    if (!this._encryptWrites) return this._inner.put(ns, key, plain);
    const sha256 = crypto.createHash('sha256').update(plain).digest('hex');
    const sealed = await this._seal(ns, key, plain, aad);
    await this._inner.put(ns, key, sealed);
    return { key, bytes: plain.length, sha256 };
  }

  /**
   * @inheritdoc
   *
   * @throws {CorruptBlobError} When the stored object is an envelope that does
   *   not verify for this address, or, in the strict mode, is no envelope.
   * @throws {KeyUnavailableError} When the key it needs is not here.
   */
  async get(ns, key) {
    const aad = this._aad(ns, key);
    const stored = await this._inner.get(ns, key);
    if (!stored) return null;
    if (this._acceptPlaintext && (!this._holdsEnvelopes || !isBlobEnvelope(stored.data))) {
      return { key, bytes: stored.data.length, data: stored.data };
    }
    try {
      const data = await this._open(ns, key, stored.data, aad);
      return { key, bytes: data.length, data };
    } catch (error) {
      this._reportUnreadable(ns, key, error);
      throw error;
    }
  }

  /**
   * @inheritdoc
   *
   * The stored object is read as a stream from the inner store, its header
   * read and its data key unwrapped once, and the content decrypted and
   * handed on one 1 MiB segment at a time, each only after its tag verified.
   * About two segments are in memory, whatever the object's size.
   *
   * Which objects are decrypted and which are handed on as stored follows the
   * store's mode exactly as in {@link EncryptingBlobStore#get}.
   *
   * The call resolves after the first segment verified, so everything that
   * makes an object unreadable as a whole rejects here, before the caller
   * has sent anything: no envelope in the strict mode, a key that is not
   * here, a wrong address, a changed header or first segment. An object that
   * is damaged or cut further in makes the stream fail later, with the same
   * error, after the segments before it were delivered; see the note on
   * streams in `BlobStore.js` for what a consumer must do.
   *
   * @throws {CorruptBlobError} As `get`, for the header and the first segment.
   * @throws {KeyUnavailableError} When the key the object needs is not here.
   */
  async openRead(ns, key) {
    const aad = this._aad(ns, key);
    const stored = await this._inner.openRead(ns, key);
    if (!stored) return null;
    if (this._acceptPlaintext && !this._holdsEnvelopes) {
      return { key, bytes: stored.bytes, stream: guardStream(stored.stream) };
    }
    let bytes = stored.bytes;
    const opening = createOpeningStream({
      headBytes: ENVELOPE_HEADER_BYTES,
      begin: async head => {
        if (this._acceptPlaintext && !isBlobEnvelope(head, stored.bytes)) {
          return { passthrough: true };
        }
        const dataKey = await this._dataKeyOf(ns, key, head, stored.bytes, aad);
        try {
          bytes = plainLength(stored.bytes);
        } catch (error) {
          dataKey.fill(0);
          if (!(error instanceof BlobEnvelopeError)) throw error;
          throw new CorruptBlobError(`Blob ${ns}/${key} does not verify`, { cause: error });
        }
        return { dataKey, aad, expectedBytes: bytes };
      },
      mapError: error =>
        error instanceof StreamingAeadError
          ? new CorruptBlobError(`Blob ${ns}/${key} does not verify`, { cause: error })
          : error
    });
    // A failure of either side ends both: a consumer that leaves ends the
    // read of the inner store, a failed read ends the consumer's stream.
    pipeline(stored.stream, opening, error => {
      if (error) this._reportUnreadable(ns, key, error);
    });
    await opening.ready;
    return { key, bytes, stream: guardStream(opening) };
  }

  /**
   * @inheritdoc
   *
   * The payload is sealed one segment at a time while it is handed to the
   * inner store, whose `putStream` gets the stored length up front
   * (`storedLength(bytes)`): the object is the same as the one `put` writes
   * for the same payload. `bytes` and `sha256` describe the payload. With
   * `encryptWrites` off the stream is stored as it is.
   *
   * @throws {StorageError} Code `BLOB_TOO_LARGE` above `maxBlobBytes`, before
   *   anything is read; `INVALID_DATA` for a stream of another length.
   * @throws {KeyUnavailableError} When the data key cannot be wrapped. Nothing
   *   is written in that case.
   */
  async putStream(ns, key, stream, opts = {}) {
    const bytes = assertStreamLength(opts?.bytes, stream);
    let aad;
    let provider;
    try {
      aad = this._aad(ns, key);
      if (bytes > this._maxBlobBytes) {
        throw new StorageError(
          `Blob ${ns}/${key} has ${bytes} bytes; the limit is ${this._maxBlobBytes}`,
          { code: 'BLOB_TOO_LARGE' }
        );
      }
      if (this._encryptWrites) provider = this._provider();
    } catch (error) {
      stream.destroy();
      throw error;
    }
    if (!this._encryptWrites) return this._inner.putStream(ns, key, stream, { bytes });
    const dataKey = newDataKey();
    try {
      let wrap;
      try {
        wrap = await provider.wrap(dataKey, aad);
      } catch (error) {
        stream.destroy();
        throw this._keyError(error, { ns, key, keyProviderId: provider.id });
      }
      const sealing = createSealingStream({
        header: encodeHeader({
          providerId: provider.id,
          keyId: wrap.keyId,
          wrapped: wrap.wrapped
        }),
        dataKey,
        aad,
        bytes,
        lengthError: arrived => streamLengthError(`${ns}/${key}`, arrived, bytes)
      });
      pipeline(stream, sealing, () => {});
      await this._inner.putStream(ns, key, sealing, { bytes: storedLength(bytes) });
      return { key, ...sealing.result() };
    } finally {
      dataKey.fill(0);
    }
  }

  /** @inheritdoc */
  async delete(ns, key) {
    return this._inner.delete(ns, key);
  }

  /**
   * @inheritdoc
   *
   * `bytes` is the payload length. Strict mode: computed from the stored
   * length; an object whose length no envelope has (something else was put
   * there) is listed with `bytes: 0`, and reading it throws
   * {@link CorruptBlobError}. `accept` modes: see the module note.
   */
  async list(ns, opts = {}) {
    const page = await this._inner.list(ns, opts);
    const nextCursor = page.nextCursor || null;
    if (this._acceptPlaintext && !this._holdsEnvelopes) return { items: page.items, nextCursor };
    if (!this._acceptPlaintext) {
      return {
        items: page.items.map(item => ({ key: item.key, bytes: this._payloadBytes(ns, item) })),
        nextCursor
      };
    }
    const items = [];
    for (let start = 0; start < page.items.length; start += HEAD_READ_CONCURRENCY) {
      const batch = page.items.slice(start, start + HEAD_READ_CONCURRENCY);
      items.push(...(await Promise.all(batch.map(item => this._mixedEntry(ns, item)))));
    }
    return { items, nextCursor };
  }

  /**
   * @inheritdoc
   *
   * Walks the inner store's own `scan`, which a backend may serve far cheaper
   * than paging `list` (the filesystem store reads the directory once), and
   * reports payload lengths as `list` does.
   */
  async *scan(ns, opts = {}) {
    if (this._acceptPlaintext && !this._holdsEnvelopes) {
      yield* this._inner.scan(ns, opts);
      return;
    }
    if (!this._acceptPlaintext) {
      for await (const item of this._inner.scan(ns, opts)) {
        yield { key: item.key, bytes: this._payloadBytes(ns, item) };
      }
      return;
    }
    let batch = [];
    for await (const item of this._inner.scan(ns, opts)) {
      batch.push(item);
      if (batch.length < HEAD_READ_CONCURRENCY) continue;
      yield* await Promise.all(batch.map(entry => this._mixedEntry(ns, entry)));
      batch = [];
    }
    yield* await Promise.all(batch.map(entry => this._mixedEntry(ns, entry)));
  }

  /**
   * One listed object of a store that may hold plaintext and envelopes.
   *
   * @param {string} ns
   * @param {{key: string, bytes: number}} item - As the inner store lists it.
   * @returns {Promise<{key: string, bytes: number}>}
   * @private
   */
  async _mixedEntry(ns, item) {
    let payloadBytes;
    try {
      payloadBytes = plainLength(item.bytes);
    } catch (error) {
      if (!(error instanceof BlobEnvelopeError)) throw error;
      // No envelope has this length: plaintext, and nothing needs reading.
      return { key: item.key, bytes: item.bytes };
    }
    const head =
      typeof this._inner.readHead === 'function'
        ? await this._inner.readHead(ns, item.key, ENVELOPE_HEADER_BYTES)
        : (await this._inner.get(ns, item.key))?.data;
    // Gone since it was listed: reported as listed, like a deleted blob in a walk.
    if (!head) return { key: item.key, bytes: item.bytes };
    return { key: item.key, bytes: isBlobEnvelope(head, item.bytes) ? payloadBytes : item.bytes };
  }

  /**
   * Payload length of one listed object in the strict mode.
   *
   * @param {string} ns
   * @param {{key: string, bytes: number}} item
   * @returns {number}
   * @private
   */
  _payloadBytes(ns, item) {
    try {
      return plainLength(item.bytes);
    } catch (error) {
      if (!(error instanceof BlobEnvelopeError)) throw error;
      const id = `${ns}/${item.key}`;
      if (!this._reportedKeys.has(id)) {
        if (this._reportedKeys.size >= MAX_REPORTED_KEYS) this._reportedKeys.clear();
        this._reportedKeys.add(id);
        logger.warn('A listed blob has a length no encrypted blob has; it is not one of ours', {
          component: COMPONENT,
          ns,
          key: item.key,
          storedBytes: item.bytes
        });
      }
      return 0;
    }
  }

  /** @inheritdoc */
  async deletePrefix(ns, prefix) {
    return this._inner.deletePrefix(ns, prefix);
  }

  /**
   * Check that this installation's master key is the one the stored blobs
   * were written with, through one encrypted object,
   * `_ihub/keycheck`.
   *
   * 1. The object opens with the current or the previous key: fine.
   * 2. It exists and does not open: refused. Another master key, or a store
   *    that belongs to another installation.
   * 3. It is missing and the store holds nothing else: it is written.
   * 4. It is missing and the store holds other objects: refused. Writing a
   *    key check now would bless whatever key happens to be loaded. `adopt`
   *    overrides this for one call: the object is written and a warning logged.
   *
   * Whoever first writes into an empty store calls this before its first
   * write: the server at start, and a tool that copies blobs in.
   *
   * @param {Object} [options]
   * @param {() => Promise<boolean>} [options.hasOtherObjects] - Whether the
   *   inner store holds anything outside the internal namespace (rule 4).
   *   Without it, rule 4 is not applied.
   * @param {boolean} [options.create=true] - Write the object under rule 3.
   *   False for a check that must not change anything.
   * @param {boolean} [options.adopt=false] - Under rule 4, write the object
   *   instead of refusing (`IHUB_S3_ADOPT_BUCKET=true` for one start). For a
   *   store whose objects are all encrypted with this key already; it does
   *   not make plaintext objects readable.
   * @param {boolean} [options.migrate=create] - Let a key check store move an
   *   object it finds at a former place.
   * @returns {Promise<{status: 'verified'|'created'|'adopted'|'absent', installationId: string|null}>}
   *   `installationId` is the random id the key check object carries.
   * @throws {KeyUnavailableError} Rule 2, when the object names another key.
   * @throws {CorruptBlobError} Rule 2, when the object does not verify.
   * @throws {StorageError} Code `KEY_CHECK_MISSING` for rule 4.
   */
  async verifyKey({ hasOtherObjects = null, create = true, adopt = false, migrate = create } = {}) {
    const provider = this._provider();
    let currentKeyId = null;
    try {
      currentKeyId = await provider.currentKeyId();
    } catch (error) {
      throw this._keyError(error, { ns: INTERNAL_BLOB_NAMESPACE, key: KEY_CHECK_KEY });
    }

    if (!this._encryptWrites) {
      throw new StorageError('The key check object is only used when encryption is enabled', {
        code: 'NOT_SUPPORTED'
      });
    }
    let marker;
    try {
      // Read strictly whatever the mode: a key check object that is not an
      // envelope proves nothing about the key.
      const stored = await this._readKeyCheck({ migrate });
      marker = stored
        ? {
            data: await this._open(
              INTERNAL_BLOB_NAMESPACE,
              KEY_CHECK_KEY,
              stored,
              this._aad(INTERNAL_BLOB_NAMESPACE, KEY_CHECK_KEY)
            )
          }
        : null;
    } catch (error) {
      if (error instanceof KeyUnavailableError) {
        throw new KeyUnavailableError(
          'The master key of this installation does not match the stored blobs: the blob store ' +
            `was written with another master key (key id ${error.keyId ?? 'unknown'}), the key ` +
            `present here has key id ${currentKeyId ?? 'unknown'}. Restore the correct ` +
            'contents/.encryption-key (or TOKEN_ENCRYPTION_KEY, if the key is set that way); ' +
            'after a deliberate key change, set the old key as TOKEN_ENCRYPTION_KEY_PREVIOUS. ' +
            'Only for a deliberate fresh start without the existing blobs: point storage.blobs ' +
            'at an empty bucket or prefix.',
          { keyId: error.keyId, keyProviderId: error.keyProviderId, cause: error }
        );
      }
      if (error instanceof CorruptBlobError) {
        throw new CorruptBlobError(
          'The key check object of the blob store does not open: it was changed, or the bucket ' +
            'and prefix belong to another installation. Use one bucket or prefix per installation.',
          { cause: error }
        );
      }
      throw error;
    }

    if (marker) {
      let content = null;
      try {
        content = JSON.parse(marker.data.toString('utf8'));
      } catch {
        // Reported below.
      }
      if (content?.format !== KEY_CHECK_FORMAT) {
        throw new CorruptBlobError('The key check object of the blob store is not readable');
      }
      return {
        status: 'verified',
        installationId: typeof content.installationId === 'string' ? content.installationId : null
      };
    }

    const foreign = typeof hasOtherObjects === 'function' && (await hasOtherObjects());
    if (foreign && adopt && create) {
      logger.warn(
        'The blob store holds objects but no key check object; adopting it as asked. Objects written with another master key stay unreadable.',
        { component: COMPONENT, keyId: currentKeyId }
      );
    } else if (foreign) {
      throw new StorageError(
        'The blob store holds objects but no key check object, so it cannot be told whether ' +
          'they are encrypted with this master key. If the objects were stored while storage ' +
          'encryption was off, stop every server and run "npm run storage:encrypt": it encrypts ' +
          'them and writes the key check object. Otherwise use an empty bucket or prefix, or ' +
          'restore the key check object together with the data. Only for a bucket whose objects ' +
          'are all already encrypted with this master key: IHUB_S3_ADOPT_BUCKET=true for one ' +
          'start writes a new key check object; it does not make plaintext objects readable.',
        { code: 'KEY_CHECK_MISSING' }
      );
    }
    if (!create) return { status: 'absent', installationId: null };

    const installationId = crypto.randomUUID();
    const content = JSON.stringify({
      format: KEY_CHECK_FORMAT,
      naming: 'plain',
      installationId,
      createdAt: new Date().toISOString()
    });
    if (this._keyCheckStore) {
      const plain = Buffer.from(content, 'utf8');
      await this._keyCheckStore.write(
        await this._seal(
          INTERNAL_BLOB_NAMESPACE,
          KEY_CHECK_KEY,
          plain,
          this._aad(INTERNAL_BLOB_NAMESPACE, KEY_CHECK_KEY)
        )
      );
    } else {
      await this.put(INTERNAL_BLOB_NAMESPACE, KEY_CHECK_KEY, content);
    }
    logger.info('Wrote the key check object of the blob store', {
      component: COMPONENT,
      keyId: currentKeyId
    });
    return { status: foreign ? 'adopted' : 'created', installationId };
  }
}

export default EncryptingBlobStore;
