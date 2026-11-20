// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Which namespaces and keys a storage facet accepts, for every provider.
 *
 * The rule is the one the filesystem provider has always applied
 * (`pathSecurity.isValidId()`: ASCII letters, digits, `.`, `_`, `-`, at most
 * 100 characters, no `..`), written once so a second backend cannot accept a
 * key the first one refuses. A blob stored on one backend can therefore
 * always be copied to another under the same name.
 *
 * @module storage/keys
 */
import { isValidId } from '../utils/pathSecurity.js';
import { InvalidKeyError } from './errors.js';

/**
 * Blob key that is the filesystem provider's key-prefix index directory, and
 * the prefix of its scratch files. Neither may be a blob key on any backend.
 */
export const RESERVED_BLOB_KEY = '.prefixes';
export const RESERVED_BLOB_KEY_PREFIX = '.tmp_';

/** Truncate an offending value for an error message so logs stay bounded. */
function describe(value) {
  return String(value).slice(0, 64);
}

/**
 * Assert that `ns` is usable as a namespace.
 *
 * @param {string} ns - Namespace supplied by the caller
 * @returns {string} The namespace, unchanged, so it can be used inline
 * @throws {InvalidKeyError} When `ns` is not a safe id
 */
export function assertValidNamespace(ns) {
  if (!isValidId(ns)) {
    throw new InvalidKeyError(`Invalid storage namespace: ${describe(ns)}`);
  }
  return ns;
}

/**
 * Assert that `key` is usable as a key within a namespace.
 *
 * @param {string} key - Key supplied by the caller
 * @returns {string} The key, unchanged, so it can be used inline
 * @throws {InvalidKeyError} When `key` is not a safe id
 */
export function assertValidKey(key) {
  if (!isValidId(key)) {
    throw new InvalidKeyError(`Invalid storage key: ${describe(key)}`);
  }
  return key;
}

/**
 * Whether a key is one a blob store keeps for its own bookkeeping.
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isReservedBlobKey(key) {
  return key === RESERVED_BLOB_KEY || key.startsWith(RESERVED_BLOB_KEY_PREFIX);
}

/**
 * Assert that `key` is usable as a blob key: a valid key that is not reserved.
 *
 * @param {string} key - Blob key supplied by the caller
 * @returns {string} The key, unchanged
 * @throws {InvalidKeyError} When `key` is not a safe id or is reserved
 */
export function assertValidBlobKey(key) {
  assertValidKey(key);
  if (isReservedBlobKey(key)) throw new InvalidKeyError(`Reserved blob key: ${describe(key)}`);
  return key;
}
