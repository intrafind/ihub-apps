// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * ComposedStorageProvider — a storage provider with a blob backend in front
 * of, or in place of, its own blob facet.
 *
 * Every provider the registry hands out is one of these. Its blob facet is
 * the encrypting blob store (`EncryptingBlobStore`), over one of two stores:
 * - the base provider's own blob facet (`storage.blobs.provider` unset or
 *   `default`), or
 * - a remote blob backend such as S3 (`storage.blobs.provider: "s3"`).
 *
 * Documents, append logs, locks and change events are always the base
 * provider's (`storage.provider`). Repositories keep asking for
 * `provider.blobs` and do not change.
 *
 * It reports the base provider's name and capabilities: everything a caller
 * branches on (locking reach, multi-instance, conditional writes) is still
 * decided by where the documents and locks are.
 *
 * **With a remote backend there is no fallback to the base provider's blob
 * facet.** When the backend cannot start, `initialize()` rejects and the
 * server does not start; serving blobs from local disk while S3 is configured
 * would split the data and store uploads where nobody expects them.
 *
 * @module storage/ComposedStorageProvider
 */
import logger from '../utils/logger.js';
import { StorageProvider } from './StorageProvider.js';
import { StorageError } from './errors.js';
import { BLOB_OPS, timeFacetMethods } from './facetTiming.js';
import { findLocalBlobLeftovers } from './localBlobLeftovers.js';

const COMPONENT = 'BlobStorage';

/** Read a facet without letting a provider that has none throw. */
function facetOf(provider, name) {
  try {
    return provider?.[name] || null;
  } catch {
    return null;
  }
}

/**
 * A base provider with its blob facet replaced.
 */
export class ComposedStorageProvider extends StorageProvider {
  /**
   * @param {Object} options
   * @param {StorageProvider} options.base - Provider for everything but blobs.
   * @param {import('./blobBackends.js').BlobBackend} options.backend - The blob backend.
   */
  constructor({ base, backend } = {}) {
    super(base?.config || {});
    if (!base || !backend?.blobs) {
      throw new StorageError('ComposedStorageProvider needs a base provider and a blob backend', {
        code: 'INVALID_PROVIDER'
      });
    }
    this._base = base;
    this._backend = backend;
    this._blobs = backend.blobs;
    // Same labels as the filesystem facet (`blobs.get:chat-files`), so the
    // admin diagnostics keep their rows when the backend changes. The base
    // provider times its own facet, which is what a local backend wraps.
    if (backend.remote) timeFacetMethods(this._blobs, 'blobs', BLOB_OPS, true);
    this._initialized = false;
    this._initializing = null;
    this._shutdownStarted = false;
    /** @type {Array<{namespace: string, count: number, capped: boolean}>} */
    this._localLeftovers = [];
  }

  /** The base provider's registry name. */
  get name() {
    return this._base.name;
  }

  /** The provider that serves documents, logs, locks and change events. */
  get base() {
    return this._base;
  }

  /** The base provider's data directory, when it has one (filesystem). */
  get baseDir() {
    return this._base.baseDir;
  }

  /** The base provider's `contents/` directory, when it has one (filesystem). */
  get contentsDir() {
    return this._base.contentsDir;
  }

  /** The base provider's raw config store, when it has one (filesystem). */
  get rawDocuments() {
    return this._base.rawDocuments;
  }

  /** Name of the blob backend: `default` or e.g. `s3`. */
  get blobBackend() {
    return this._backend.name;
  }

  /** The blob backend itself: its `probe()`, `describe()` and `lastProbe`. */
  get blobBackendHandle() {
    return this._backend;
  }

  /**
   * Blobs the base provider still holds, per namespace, as found at start.
   * They are not served while this provider is active.
   *
   * @returns {Array<{namespace: string, count: number, capped: boolean}>}
   */
  get localBlobLeftovers() {
    return this._localLeftovers.map(entry => ({ ...entry }));
  }

  get documents() {
    return this._base.documents;
  }

  get logs() {
    return this._base.logs;
  }

  get notifier() {
    return this._base.notifier;
  }

  get locks() {
    return this._base.locks;
  }

  /** The blob backend's facet: the encrypting blob store. */
  get blobs() {
    return this._blobs;
  }

  /**
   * Bring the base provider up, then the blob backend (connection, key check,
   * round trip). Idempotent; concurrent callers share one run.
   *
   * @returns {Promise<void>}
   * @throws {StorageError} When the blob backend's check fails.
   */
  async initialize() {
    if (this._initialized) return;
    if (!this._initializing) {
      this._initializing = (async () => {
        await this._base.initialize?.();
        await this._backend.initialize();
        await this._reportLocalLeftovers();
        this._initialized = true;
      })().finally(() => {
        this._initializing = null;
      });
    }
    return this._initializing;
  }

  /**
   * Warn when the base provider still holds blobs. Never fails a start.
   *
   * @returns {Promise<void>}
   * @private
   */
  async _reportLocalLeftovers() {
    if (!this._backend.remote) return;
    const local = facetOf(this._base, 'blobs');
    if (!local) return;
    try {
      this._localLeftovers = await findLocalBlobLeftovers(local);
    } catch (error) {
      logger.warn('Could not check the previous blob store for leftover blobs', {
        component: COMPONENT,
        error: error.message
      });
      return;
    }
    if (this._localLeftovers.length === 0) return;
    logger.warn(
      `Blob storage is "${this._backend.name}", but the "${this._base.name}" storage still holds ` +
        'blobs from before the switch. They are not served. Copy them with ' +
        '"npm run storage:copy-blobs" while the server is stopped.',
      {
        component: COMPONENT,
        code: 'BLOB_LOCAL_LEFTOVERS',
        namespaces: this._localLeftovers.map(
          ({ namespace, count, capped }) => `${namespace}: ${count}${capped ? '+' : ''}`
        )
      }
    );
  }

  /**
   * Close the blob backend, then the base provider. Idempotent.
   *
   * @returns {Promise<void>}
   */
  async shutdown() {
    if (this._shutdownStarted) return;
    this._shutdownStarted = true;
    try {
      await this._backend.shutdown();
    } catch (error) {
      logger.error('Failed to shut the blob backend down', {
        component: COMPONENT,
        error: error.message
      });
    }
    await this._base.shutdown?.();
  }

  /**
   * The base provider's probe plus the blob backend's check. The base failing
   * is `error`; the base fine and the blob backend failing is `degraded`.
   * The check of a remote backend, and of any backend that encrypts, is a
   * real round trip.
   *
   * @returns {Promise<import('./StorageProvider.js').HealthCheckResult>}
   */
  async healthCheck() {
    const startedAt = Date.now();
    const base = await this._base.healthCheck();
    const probe = await this._backend.probe({ createKeyCheck: false });
    const blobs = {
      provider: probe.provider,
      status: probe.status,
      latencyMs: probe.latencyMs,
      ...(probe.location ? { location: probe.location } : {}),
      ...(probe.error ? { code: probe.error.code, step: probe.error.step } : {})
    };
    return {
      ...base,
      status: base.status !== 'ok' ? base.status : probe.status === 'ok' ? 'ok' : 'degraded',
      latencyMs: Date.now() - startedAt,
      details: { ...base.details, blobs }
    };
  }

  /**
   * The base provider's capabilities, with the blob facet declared.
   *
   * @returns {import('./StorageProvider.js').Capabilities}
   */
  getCapabilities() {
    return { ...this._base.getCapabilities(), blobStore: true };
  }
}

export default ComposedStorageProvider;
