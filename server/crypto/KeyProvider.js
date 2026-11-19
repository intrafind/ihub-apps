// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * KeyProvider — who wraps the per-object data keys (spec 3 §6.1, #2906).
 *
 * Every stored text is encrypted with its own random data key; the data key
 * is wrapped by a master key the provider holds and the wrapped form lives
 * in the item's metadata. `local-file` (default) uses the 32-byte key
 * `TokenStorageService` already keeps in `contents/.encryption-key` (or
 * `TOKEN_ENCRYPTION_KEY`), so an installation gets envelope encryption with
 * no new secret. A Transit provider (OpenBao, Vault, KMS) is phase 3 behind
 * the same interface; #2316 (chat message encryption) goes through it too.
 *
 * Wrapped form of `local-file`: `v1 || iv (12) || tag (16) || ciphertext`,
 * AES-256-GCM of the data key with the object's associated data as AAD, so
 * a wrapped key copied onto another item does not unwrap. The associated data
 * is mandatory: wrapping or unwrapping with none throws.
 *
 * The encrypting blob store (`storage/EncryptingBlobStore.js`) wraps its data
 * keys through the same provider, which is why this lives beside the stream
 * format and not under a domain service.
 *
 * @module crypto/KeyProvider
 */
import crypto from 'node:crypto';
import tokenStorageService from '../services/TokenStorageService.js';
import logger from '../utils/logger.js';
import { KEY_BYTES } from './streamingAead.js';

/**
 * Why a key was refused, for callers that must tell "the key is not here"
 * from "the key is here and the object does not open with it".
 *
 * - `not-initialized`: the provider holds no master key yet
 * - `unknown-key`: no master key with the id the object names
 * - `unknown-provider`: no provider registered under the id asked for
 * - `malformed`: the wrapped key is not in the provider's format
 * - `unwrap-failed`: a key with that id exists and the wrapped key does not
 *   open with it (changed bytes, or another object's associated data)
 *
 * @typedef {'not-initialized'|'unknown-key'|'unknown-provider'|'malformed'|'unwrap-failed'} KeyDenialReason
 */

export class KeyAccessDenied extends Error {
  /**
   * @param {string} message
   * @param {string|null} [keyId] - The master key id the object names.
   * @param {KeyDenialReason} [reason]
   */
  constructor(message, keyId, reason = 'unwrap-failed') {
    super(message);
    this.name = 'KeyAccessDenied';
    this.code = 'KEY_ACCESS_DENIED';
    this.keyId = keyId;
    this.reason = reason;
  }
}

/**
 * A key provider id nobody registered: a typo in the configuration, or an
 * object written by a provider this installation does not have. Never
 * answered with another provider: on write that would encrypt under a key
 * the administrator did not choose, and on read the id comes from stored
 * data.
 */
export class UnknownKeyProviderError extends KeyAccessDenied {
  /** @param {string} id - The id that was asked for. */
  constructor(id) {
    super(
      `Unknown key provider '${String(id).slice(0, 64)}'. Registered: ${[...providers.keys()].sort().join(', ')}`,
      null,
      'unknown-provider'
    );
    this.name = 'UnknownKeyProviderError';
    this.code = 'UNKNOWN_KEY_PROVIDER';
    this.providerId = id;
  }
}

/**
 * The associated data of a wrap as bytes. A non-empty string is required: a
 * key wrapped with none unwraps on any object.
 *
 * @param {string} aad
 * @returns {Buffer}
 */
function aadBytes(aad) {
  if (typeof aad !== 'string' || aad.length === 0) {
    throw new Error('A key is wrapped with non-empty associated data');
  }
  return Buffer.from(aad, 'utf8');
}

/** Abstract provider. */
export class KeyProvider {
  get id() {
    throw new Error('KeyProvider.id is not implemented');
  }

  /** The id of the master key a new wrap uses. */
  async currentKeyId() {
    throw new Error('KeyProvider.currentKeyId is not implemented');
  }

  /**
   * @param {Buffer} _dataKey
   * @param {string} _aad
   * @returns {Promise<{keyId: string, wrapped: Buffer}>}
   */
  async wrap(_dataKey, _aad) {
    throw new Error('KeyProvider.wrap is not implemented');
  }

  /**
   * @param {Buffer} _wrapped
   * @param {string} _keyId
   * @param {string} _aad
   * @returns {Promise<Buffer>}
   * @throws {KeyAccessDenied}
   */
  async unwrap(_wrapped, _keyId, _aad) {
    throw new Error('KeyProvider.unwrap is not implemented');
  }
}

const WRAP_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function fingerprintOf(hexKey) {
  return crypto.createHash('sha256').update(String(hexKey)).digest('hex').slice(0, 8);
}

/**
 * The local master key file provider.
 */
export class LocalFileKeyProvider extends KeyProvider {
  /**
   * @param {Object} [options]
   * @param {() => string|null} [options.readMasterKey] - The current master key as hex (tests).
   * @param {() => string|null} [options.readPreviousKey] - A previous master key as hex, for
   *   objects wrapped before a key change (`TOKEN_ENCRYPTION_KEY_PREVIOUS`).
   */
  constructor({ readMasterKey, readPreviousKey } = {}) {
    super();
    this._readMasterKey = readMasterKey || (() => tokenStorageService.encryptionKey || null);
    this._readPreviousKey =
      readPreviousKey || (() => process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS || null);
  }

  get id() {
    return 'local-file';
  }

  _keys() {
    const keys = [];
    const current = this._readMasterKey();
    if (current) keys.push({ keyId: fingerprintOf(current), key: Buffer.from(current, 'hex') });
    // Trimmed like the current key (`TokenStorageService`): a trailing newline
    // from a secret store must not make every older object unreadable.
    const rawPrevious = this._readPreviousKey();
    const previous = typeof rawPrevious === 'string' ? rawPrevious.trim() : '';
    if (/^[0-9a-f]{64}$/i.test(previous)) {
      keys.push({
        keyId: fingerprintOf(previous.toLowerCase()),
        key: Buffer.from(previous, 'hex')
      });
    } else if (previous && !this._warnedPreviousKey) {
      this._warnedPreviousKey = true;
      logger.error(
        'TOKEN_ENCRYPTION_KEY_PREVIOUS is set but is not a 64-character hex key; it is ignored and objects wrapped with the previous key will not open',
        { component: 'KeyProvider' }
      );
    }
    return keys;
  }

  async currentKeyId() {
    const [current] = this._keys();
    if (!current) {
      throw new KeyAccessDenied('The master key is not initialized', null, 'not-initialized');
    }
    return current.keyId;
  }

  async wrap(dataKey, aad) {
    if (!Buffer.isBuffer(dataKey) || dataKey.length !== KEY_BYTES) {
      throw new Error(`A data key has ${KEY_BYTES} bytes`);
    }
    const associated = aadBytes(aad);
    const [current] = this._keys();
    if (!current) {
      throw new KeyAccessDenied('The master key is not initialized', null, 'not-initialized');
    }
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', current.key, iv, {
      authTagLength: TAG_BYTES
    });
    cipher.setAAD(associated);
    const body = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      keyId: current.keyId,
      wrapped: Buffer.concat([Buffer.from([WRAP_VERSION]), iv, tag, body])
    };
  }

  async unwrap(wrapped, keyId, aad) {
    const associated = aadBytes(aad);
    if (!Buffer.isBuffer(wrapped) || wrapped.length !== 1 + IV_BYTES + TAG_BYTES + KEY_BYTES) {
      throw new KeyAccessDenied('The wrapped key is malformed', keyId, 'malformed');
    }
    if (wrapped[0] !== WRAP_VERSION) {
      throw new KeyAccessDenied('Unknown wrapped key version', keyId, 'malformed');
    }
    const keys = this._keys();
    if (!keys.length) {
      throw new KeyAccessDenied('The master key is not initialized', keyId, 'not-initialized');
    }
    const candidates = keys.filter(entry => !keyId || entry.keyId === keyId);
    if (!candidates.length) {
      throw new KeyAccessDenied(
        `No master key with id ${keyId} is available`,
        keyId,
        'unknown-key'
      );
    }
    const iv = wrapped.subarray(1, 1 + IV_BYTES);
    const tag = wrapped.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const body = wrapped.subarray(1 + IV_BYTES + TAG_BYTES);
    for (const candidate of candidates) {
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', candidate.key, iv, {
          authTagLength: TAG_BYTES
        });
        decipher.setAAD(associated);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]);
      } catch {
        // Try the next key the id names.
      }
    }
    throw new KeyAccessDenied(
      'The data key does not unwrap with the available master key',
      keyId,
      'unwrap-failed'
    );
  }
}

const providers = new Map();

/**
 * Register a provider implementation under its id.
 *
 * @param {string} id
 * @param {() => KeyProvider} factory
 */
export function registerKeyProvider(id, factory) {
  providers.set(id, factory);
}

registerKeyProvider('local-file', () => new LocalFileKeyProvider());

let active = null;
let activeId = null;

/**
 * The key provider registered under an id (`platform.projects.encryption.keyProvider`,
 * `platform.storage.blobs.encryption.keyProvider`, or the id an object records).
 *
 * @param {string} [id='local-file']
 * @returns {KeyProvider}
 * @throws {UnknownKeyProviderError} When no provider is registered under `id`.
 *   There is no fallback to `local-file`.
 */
export function getKeyProvider(id = 'local-file') {
  if (typeof id !== 'string' || !providers.has(id)) throw new UnknownKeyProviderError(id);
  if (!active || activeId !== id) {
    active = providers.get(id)();
    activeId = id;
  }
  return active;
}

/**
 * Where the master key of the `local-file` provider stands, for a start-up
 * check and a status page. Never the key itself.
 *
 * @returns {{initialized: boolean, source: string|null, fingerprint: string|null, keyId: string|null}}
 *   `source` is `env`, `file`, `generated` or `generated-unpersisted`
 *   (`TokenStorageService.keySource`); `keyId` is the id new wraps record.
 */
export function describeMasterKey() {
  const key = tokenStorageService.encryptionKey || null;
  return {
    initialized: Boolean(key),
    source: tokenStorageService.keySource || null,
    fingerprint: tokenStorageService.getKeyFingerprint(),
    keyId: key ? fingerprintOf(key) : null
  };
}

/**
 * Load the master key when nothing has yet. The storage bootstrap runs before
 * the rest of the server (and inside migrations), so it cannot rely on the
 * key having been set up by then.
 *
 * @returns {Promise<{initialized: boolean, source: string|null, fingerprint: string|null, keyId: string|null}>}
 */
export async function ensureMasterKey() {
  if (!tokenStorageService.encryptionKey) await tokenStorageService.initializeEncryptionKey();
  return describeMasterKey();
}

/** Test hook. */
export function _resetKeyProvider() {
  active = null;
  activeId = null;
}

/**
 * The plain text of a configuration secret that may be stored encrypted
 * (`ENC[...]`, see `TokenStorageService`). For code that reads `platform.json`
 * before the configuration cache decrypts it.
 *
 * @param {string} value - The stored value.
 * @returns {string} The plain text; `value` itself when it is not encrypted.
 * @throws {Error} When it is encrypted and does not decrypt with the master key.
 */
export function openConfigSecret(value) {
  if (typeof value !== 'string' || !tokenStorageService.isEncrypted(value)) return value;
  return tokenStorageService.decryptString(value);
}
