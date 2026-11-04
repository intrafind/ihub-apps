// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Storage bootstrap — bring the configured provider up once per worker and
 * hand it out.
 *
 * The storage provider is mandatory. The filesystem provider is the default and
 * needs no configuration, so a working installation always has one. A `storage`
 * block that names an unknown provider, or a provider that cannot initialize,
 * is an administrator's mistake of the same weight as an invalid
 * `platform.json`: {@link bootstrapStorage} rejects with a
 * {@link StorageBootstrapError} and the server refuses to start, instead of
 * running chats, workflows and integrations in a mode that forgets everything
 * on the next restart. There is no "persistence is off" state to degrade to.
 *
 * {@link getStorage} returns `null` only before the bootstrap has run and after
 * shutdown. Code that needs the provider calls {@link requireStorage}, which
 * says what is wrong instead of failing on a property of `null`.
 *
 * @module storage/bootstrap
 */
import logger from '../utils/logger.js';
// Deliberately the public surface rather than StorageRegistry.js: importing
// `./index.js` is what registers the built-in providers, so resolving
// `filesystem` here works. Going straight to the registry would resolve
// against an empty factory map.
import { initializeStorage, shutdownStorage } from './index.js';

const COMPONENT = 'StorageBootstrap';

/**
 * The initialized provider, or null before the bootstrap has run.
 * @type {import('./StorageProvider.js').StorageProvider|null}
 */
let activeProvider = null;

/**
 * In-flight bootstrap, so concurrent callers share one initialization.
 * @type {Promise<import('./StorageProvider.js').StorageProvider>|null}
 */
let pendingBootstrap = null;

/**
 * Raised when the storage provider cannot be brought up, or is asked for before
 * it has been. Startup treats it as fatal.
 */
export class StorageBootstrapError extends Error {
  /**
   * @param {string} message - What went wrong and where to look.
   * @param {Object} [options]
   * @param {Error} [options.cause] - The underlying failure.
   */
  constructor(message, { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'StorageBootstrapError';
    this.code = 'STORAGE_BOOTSTRAP_FAILED';
  }
}

/**
 * Capabilities worth knowing at a glance when a chat write later misbehaves:
 * a provider without cross-worker locking cannot serialize two tabs writing
 * the same chat, and that is a property of the deployment, not of the code.
 *
 * @param {import('./StorageProvider.js').StorageProvider} provider
 * @returns {Object} Capability summary, or an empty object when the provider
 *   does not report any.
 */
function describeCapabilities(provider) {
  try {
    const caps = provider.getCapabilities?.() || {};
    return {
      locking: caps.locking,
      multiInstance: caps.multiInstance,
      blobs: caps.blobs,
      blobStore: caps.blobStore
    };
  } catch {
    return {};
  }
}

/**
 * Resolve, initialize and remember the storage provider for this process.
 *
 * Idempotent: a second call returns the provider already running. A failure is
 * not remembered, so a caller may correct the configuration and try again.
 *
 * @param {Object} [platformConfig] - Platform configuration; `storage.provider`
 *   and the provider's own block are read from it.
 * @returns {Promise<import('./StorageProvider.js').StorageProvider>} The provider.
 * @throws {StorageBootstrapError} When the provider cannot be resolved or
 *   initialized.
 */
export async function bootstrapStorage(platformConfig) {
  if (activeProvider) return activeProvider;
  if (pendingBootstrap) return pendingBootstrap;

  pendingBootstrap = (async () => {
    let provider;
    try {
      provider = await initializeStorage({ platformConfig });
    } catch (error) {
      throw new StorageBootstrapError(
        `Storage provider could not be started: ${error.message}. ` +
          'Check the "storage" section of contents/config/platform.json (or the ' +
          "storage environment override) and the provider's own settings.",
        { cause: error }
      );
    }
    if (!provider) {
      throw new StorageBootstrapError('Storage provider could not be started: none was returned');
    }
    activeProvider = provider;
    logger.info('Storage bootstrap complete', {
      component: COMPONENT,
      ...describeCapabilities(activeProvider)
    });
    return activeProvider;
  })();

  try {
    return await pendingBootstrap;
  } finally {
    pendingBootstrap = null;
  }
}

/**
 * The initialized storage provider, or null before {@link bootstrapStorage}
 * has completed (and after shutdown).
 *
 * @returns {import('./StorageProvider.js').StorageProvider|null}
 */
export function getStorage() {
  return activeProvider;
}

/**
 * The initialized storage provider.
 *
 * @returns {import('./StorageProvider.js').StorageProvider}
 * @throws {StorageBootstrapError} When storage has not been bootstrapped.
 */
export function requireStorage() {
  if (!activeProvider) {
    throw new StorageBootstrapError(
      'Storage is not available: bootstrapStorage() has not completed. ' +
        'The storage provider is mandatory and is started before anything that keeps state.'
    );
  }
  return activeProvider;
}

/**
 * Read one facet of a provider without letting an accessor throw out of it.
 *
 * @param {Object|null} provider - Storage provider, or null.
 * @param {string} facet - Facet name: `documents`, `logs`, `locks`, `notifier`.
 * @returns {Object|null} The facet, or null when the provider has none.
 */
export function readFacet(provider, facet) {
  try {
    return provider?.[facet] || null;
  } catch {
    return null;
  }
}

/**
 * Whether a storage provider is up and usable.
 *
 * @returns {boolean}
 */
export function isStorageReady() {
  return activeProvider !== null;
}

/**
 * Shut the provider down and forget it, so the next `bootstrapStorage()`
 * starts clean. Safe to call when nothing was ever initialized and safe to
 * call twice.
 *
 * Never throws: it runs on the signal path, where a rejection would skip the
 * shutdown steps queued behind it.
 *
 * @returns {Promise<void>}
 */
export async function shutdownStorageBootstrap() {
  if (pendingBootstrap) {
    // Let an in-flight bootstrap settle first, otherwise it would publish a
    // provider moments after we cleared the singleton and leak it.
    await pendingBootstrap.catch(() => {});
  }
  // Shut down first, forget second: callers that reach the provider during the
  // flush get either a completed write or a `STORAGE_SHUT_DOWN` rejection, both
  // of which are answerable.
  try {
    await shutdownStorage();
  } catch (error) {
    logger.error('Storage shutdown failed', { component: COMPONENT, error: error.message });
  }
  activeProvider = null;
}
