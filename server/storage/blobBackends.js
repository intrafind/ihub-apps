// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Blob backends: what `storage.blobs.provider` can name besides `default`.
 *
 * A blob backend replaces the blob facet of the running storage provider and
 * nothing else. Documents, append logs, locks and change events stay on
 * `storage.provider`. Backends register a factory here, in `storage/index.js`,
 * for the same reason providers do: adding one never touches a call site.
 *
 * @module storage/blobBackends
 */
import { StorageError, UnknownProviderError } from './errors.js';

/** The value of `storage.blobs.provider` that means "the provider's own blob facet". */
export const DEFAULT_BLOB_BACKEND = 'default';

/**
 * What a blob backend factory returns.
 *
 * @typedef {Object} BlobBackend
 * @property {string} name - Registry name, e.g. `s3`; `default` for the
 *   storage provider's own blob facet.
 * @property {boolean} remote - Whether the blobs live somewhere else than the
 *   storage provider's own blob facet.
 * @property {import('./BlobStore.js').BlobStore} blobs - The blob facet callers
 *   get. For a remote backend this is the encrypting store, never the bare one.
 * @property {() => Promise<void>} initialize - Connect and run the check with
 *   the right to write the key check object; rejects when the check fails.
 *   Idempotent.
 * @property {(options?: {createKeyCheck?: boolean, adopt?: boolean}) => Promise<import('./blobProbe.js').BlobProbeResult>} probe -
 *   Run the check. Never rejects.
 * @property {(options?: {adopt?: boolean}) => Promise<Object>} ensureKeyCheck -
 *   Verify or write the key check object; what a tool calls before its first
 *   write into a store.
 * @property {() => Object} describe - Where the blobs are and how they are
 *   encrypted, without credentials.
 * @property {import('./blobProbe.js').BlobProbeResult|null} lastProbe - The
 *   most recent check result.
 * @property {() => Promise<void>} shutdown - Close connections. Idempotent.
 */

/** @type {Map<string, (config: Object, context: Object) => BlobBackend>} */
const factories = new Map();

/**
 * Register a blob backend factory under a name.
 *
 * @param {string} name - As it appears in `storage.blobs.provider`.
 * @param {(config: Object, context: {platformConfig: Object, locks: Object|null, env: Object}) => BlobBackend} factory -
 *   Builds the backend from its configuration block. It validates the block
 *   and throws on a wrong one, and does no I/O; that belongs in `initialize()`.
 * @returns {void}
 * @throws {StorageError} Code `INVALID_PROVIDER` for an unusable name or factory.
 */
export function registerBlobBackend(name, factory) {
  if (typeof name !== 'string' || !name.trim() || name === DEFAULT_BLOB_BACKEND) {
    throw new StorageError('registerBlobBackend requires a backend name other than "default"', {
      code: 'INVALID_PROVIDER'
    });
  }
  if (typeof factory !== 'function') {
    throw new StorageError(`registerBlobBackend('${name}') requires a factory function`, {
      code: 'INVALID_PROVIDER'
    });
  }
  factories.set(name.trim(), factory);
}

/**
 * Names of the registered blob backends, sorted.
 *
 * @returns {string[]}
 */
export function getRegisteredBlobBackends() {
  return [...factories.keys()].sort();
}

/**
 * Build a blob backend.
 *
 * @param {string} name - Registered backend name.
 * @param {Object} config - Its configuration block, placeholders resolved.
 * @param {Object} [context]
 * @param {Object} [context.platformConfig] - `{ ssl, proxy }` of the platform
 *   configuration, for the transport.
 * @param {Object|null} [context.locks] - Lock manager of the base provider.
 * @param {Object} [context.env] - Environment to read one-start switches from.
 * @param {{enabled: boolean, plaintextReads: 'reject'|'accept'}} [context.encryption] -
 *   `storage.encryption`, see `resolveBlobStorageConfig`.
 * @returns {BlobBackend} The backend, not yet initialized.
 * @throws {UnknownProviderError} When no backend is registered under `name`.
 *   There is no fallback to the default blob facet.
 */
export function createBlobBackend(name, config, context = {}) {
  const factory = typeof name === 'string' ? factories.get(name) : undefined;
  if (!factory) {
    const known = [DEFAULT_BLOB_BACKEND, ...getRegisteredBlobBackends()].join(', ');
    throw new UnknownProviderError(
      `Unknown blob storage provider '${String(name).slice(0, 64)}'. Known: ${known}`
    );
  }
  const backend = factory(config, context);
  if (!backend || typeof backend !== 'object' || !backend.blobs) {
    throw new StorageError(`Blob backend factory for '${name}' did not return a backend`, {
      code: 'INVALID_PROVIDER'
    });
  }
  return backend;
}
