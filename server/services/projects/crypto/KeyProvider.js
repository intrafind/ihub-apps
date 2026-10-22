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
 * a wrapped key copied onto another item does not unwrap.
 *
 * @module services/projects/crypto/KeyProvider
 */
import crypto from 'node:crypto';
import tokenStorageService from '../../TokenStorageService.js';
import { KEY_BYTES } from './streamingAead.js';

export class KeyAccessDenied extends Error {
  constructor(message, keyId) {
    super(message);
    this.name = 'KeyAccessDenied';
    this.code = 'KEY_ACCESS_DENIED';
    this.keyId = keyId;
  }
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
    const previous = this._readPreviousKey();
    if (previous && /^[0-9a-f]{64}$/i.test(previous)) {
      keys.push({
        keyId: fingerprintOf(previous.toLowerCase()),
        key: Buffer.from(previous, 'hex')
      });
    }
    return keys;
  }

  async currentKeyId() {
    const [current] = this._keys();
    if (!current) throw new KeyAccessDenied('The master key is not initialized', null);
    return current.keyId;
  }

  async wrap(dataKey, aad) {
    if (!Buffer.isBuffer(dataKey) || dataKey.length !== KEY_BYTES) {
      throw new Error(`A data key has ${KEY_BYTES} bytes`);
    }
    const [current] = this._keys();
    if (!current) throw new KeyAccessDenied('The master key is not initialized', null);
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', current.key, iv, {
      authTagLength: TAG_BYTES
    });
    cipher.setAAD(Buffer.from(String(aad ?? ''), 'utf8'));
    const body = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      keyId: current.keyId,
      wrapped: Buffer.concat([Buffer.from([WRAP_VERSION]), iv, tag, body])
    };
  }

  async unwrap(wrapped, keyId, aad) {
    if (!Buffer.isBuffer(wrapped) || wrapped.length !== 1 + IV_BYTES + TAG_BYTES + KEY_BYTES) {
      throw new KeyAccessDenied('The wrapped key is malformed', keyId);
    }
    if (wrapped[0] !== WRAP_VERSION)
      throw new KeyAccessDenied('Unknown wrapped key version', keyId);
    const candidates = this._keys().filter(entry => !keyId || entry.keyId === keyId);
    if (!candidates.length) {
      throw new KeyAccessDenied(`No master key with id ${keyId} is available`, keyId);
    }
    const iv = wrapped.subarray(1, 1 + IV_BYTES);
    const tag = wrapped.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const body = wrapped.subarray(1 + IV_BYTES + TAG_BYTES);
    for (const candidate of candidates) {
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', candidate.key, iv, {
          authTagLength: TAG_BYTES
        });
        decipher.setAAD(Buffer.from(String(aad ?? ''), 'utf8'));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]);
      } catch {
        // Try the next key the id names.
      }
    }
    throw new KeyAccessDenied('The data key does not unwrap with the available master key', keyId);
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
 * The configured key provider (`platform.projects.encryption.keyProvider`).
 *
 * @param {string} [id='local-file']
 * @returns {KeyProvider}
 */
export function getKeyProvider(id = 'local-file') {
  const wanted = providers.has(id) ? id : 'local-file';
  if (!active || activeId !== wanted) {
    active = providers.get(wanted)();
    activeId = wanted;
  }
  return active;
}

/** Test hook. */
export function _resetKeyProvider() {
  active = null;
  activeId = null;
}
