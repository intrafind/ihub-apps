// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the document store and the append log of the filesystem provider share
 * about encryption at rest: the mode, the tenant and the way to the key
 * provider. One instance per provider, handed to both facets, so the mode the
 * provider decides at `initialize()` reaches both at once.
 *
 * | Mode | Writes | Reading plaintext | Reading sealed |
 * | --- | --- | --- | --- |
 * | `off` | plaintext | yes | yes, when the key is there |
 * | `converting` | sealed | yes | yes |
 * | `enforced` | sealed | error | yes |
 *
 * `converting` is the mode of the one process that converts existing data
 * (the start-up step before the workers exist, or `npm run storage:encrypt`).
 *
 * @module storage/providers/filesystem/atRestContext
 */
import { KeyUnavailableError, StorageError } from '../../errors.js';

/** The modes, in the order of the table above. */
export const AT_REST_MODES = Object.freeze(['off', 'converting', 'enforced']);

/** Reasons a key provider gives that mean "the key is not here". */
const KEY_MISSING_REASONS = new Set(['not-initialized', 'unknown-key', 'unknown-provider']);

/** Error names of `crypto/KeyProvider.js`, matched by name so a test double works. */
const KEY_ERROR_NAMES = new Set(['KeyAccessDenied', 'UnknownKeyProviderError']);

/** Error names of the seal modules (`crypto/documentSeal.js`, `crypto/logSeal.js`). */
const SEAL_ERROR_NAMES = new Set(['DocumentSealError', 'LogSealError']);

/**
 * Mode, tenant and key access of one filesystem provider.
 */
export class AtRestContext {
  /**
   * @param {Object} [options]
   * @param {'off'|'converting'|'enforced'} [options.mode='off']
   * @param {Object|(() => Object)} [options.keyProvider] - A key provider, or
   *   a function returning it (tests, and callers that hold one already).
   * @param {() => Promise<Object>} [options.loadKeys] - Resolves with the key
   *   module (`crypto/KeyProvider.js`); used when no `keyProvider` is given.
   *   Loaded on first use, so a provider with encryption off and no sealed
   *   data never touches the master key.
   * @param {string} [options.tenant='default'] - Tenant part of every address.
   */
  constructor({ mode = 'off', keyProvider = null, loadKeys = null, tenant = 'default' } = {}) {
    this._keyProvider = keyProvider;
    this._loadKeys = loadKeys;
    this._keys = null;
    this._tenant = tenant;
    this._mode = 'off';
    this.setMode(mode);
  }

  /** @returns {'off'|'converting'|'enforced'} */
  get mode() {
    return this._mode;
  }

  /** @returns {string} */
  get tenant() {
    return this._tenant;
  }

  /** Whether writes are sealed. */
  get writesSealed() {
    return this._mode !== 'off';
  }

  /** Whether a plaintext object is an error. */
  get rejectsPlaintext() {
    return this._mode === 'enforced';
  }

  /**
   * @param {'off'|'converting'|'enforced'} mode
   * @throws {StorageError} Code `INVALID_CONFIG` for anything else.
   */
  setMode(mode) {
    if (!AT_REST_MODES.includes(mode)) {
      throw new StorageError(`Unknown encryption mode '${String(mode).slice(0, 32)}'`, {
        code: 'INVALID_CONFIG'
      });
    }
    this._mode = mode;
  }

  /**
   * The key provider that wraps and unwraps data keys.
   *
   * @returns {Promise<Object>}
   * @throws {KeyUnavailableError} When there is none, or the master key
   *   cannot be loaded.
   */
  async keyProvider() {
    try {
      if (this._keyProvider) {
        const provider =
          typeof this._keyProvider === 'function' ? this._keyProvider() : this._keyProvider;
        if (!provider || typeof provider.wrap !== 'function') {
          throw new Error('the key provider is not usable');
        }
        return provider;
      }
      if (!this._loadKeys) throw new Error('no key provider is configured');
      if (!this._keys) {
        const pending = (async () => {
          const keys = await this._loadKeys();
          await keys.ensureMasterKey();
          return keys;
        })();
        this._keys = pending;
        // A failed load is not remembered: the next call tries again.
        pending.catch(() => {
          if (this._keys === pending) this._keys = null;
        });
      }
      return (await this._keys).getKeyProvider();
    } catch (cause) {
      if (cause instanceof StorageError) throw cause;
      throw new KeyUnavailableError(`The master key is not available: ${cause.message}`, { cause });
    }
  }

  /**
   * Sort a failure of a seal or key call: the key is not here, the object
   * does not open, or something else went wrong.
   *
   * @param {unknown} error
   * @param {string} what - The object, for the message (`document chats/c1`).
   * @returns {KeyUnavailableError|null} The error to throw when the key is not
   *   here; null when the object is corrupt (the caller reports that in its
   *   own terms).
   * @throws The error itself when it is neither.
   */
  keyFailure(error, what) {
    if (error instanceof KeyUnavailableError) return error;
    if (KEY_ERROR_NAMES.has(error?.name)) {
      if (!KEY_MISSING_REASONS.has(error.reason)) return null;
      return new KeyUnavailableError(`The key for ${what} is not available: ${error.message}`, {
        keyId: error.keyId ?? null,
        cause: error
      });
    }
    if (SEAL_ERROR_NAMES.has(error?.name)) {
      if (error.code !== 'KEY_PROVIDER_MISMATCH') return null;
      return new KeyUnavailableError(
        `${what} was written with key provider '${error.keyProviderId}', which is not the configured one`,
        { keyId: error.keyId, keyProviderId: error.keyProviderId, cause: error }
      );
    }
    throw error;
  }
}

export default AtRestContext;
