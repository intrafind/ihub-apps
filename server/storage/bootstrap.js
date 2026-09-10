/**
 * Storage bootstrap — bring the configured provider up once per worker and
 * hand it out without ever throwing at the call site.
 *
 * The registry deliberately fails loudly: `initializeStorage()` rejects on a
 * misconfigured provider and `getStorageProvider()` throws before it has run.
 * Durable chats must not inherit either behaviour. A broken `storage` block is
 * an administrator's mistake, and the right answer is chats that behave like
 * they did before persistence existed — not a server that refuses to boot. So
 * this module wraps the registry: one error log on failure, and
 * `getStorage() === null` afterwards, which every consumer treats as
 * "persistence is off".
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
 * The initialized provider, or null while storage is unavailable.
 * @type {import('./StorageProvider.js').StorageProvider|null}
 */
let activeProvider = null;

/**
 * In-flight bootstrap, so concurrent callers share one initialization.
 * @type {Promise<import('./StorageProvider.js').StorageProvider|null>|null}
 */
let pendingBootstrap = null;

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
    return { locking: caps.locking, multiInstance: caps.multiInstance, blobs: caps.blobs };
  } catch {
    return {};
  }
}

/**
 * Resolve, initialize and remember the storage provider for this process.
 *
 * Idempotent and non-throwing: a second call returns the provider already
 * running (or null when the first attempt failed), and a failure is logged
 * once and reported as unavailable storage.
 *
 * @param {Object} [platformConfig] - Platform configuration; `storage.provider`
 *   and the provider's own block are read from it.
 * @returns {Promise<import('./StorageProvider.js').StorageProvider|null>} The
 *   provider, or null when storage could not be brought up.
 */
export async function bootstrapStorage(platformConfig) {
  if (activeProvider) return activeProvider;
  if (pendingBootstrap) return pendingBootstrap;

  pendingBootstrap = (async () => {
    try {
      const provider = await initializeStorage({ platformConfig });
      activeProvider = provider || null;
      if (activeProvider) {
        logger.info('Storage bootstrap complete', {
          component: COMPONENT,
          ...describeCapabilities(activeProvider)
        });
      }
    } catch (error) {
      activeProvider = null;
      logger.error('Storage bootstrap failed; features that need it stay off', {
        component: COMPONENT,
        error: error.message
      });
    }
    return activeProvider;
  })();

  try {
    return await pendingBootstrap;
  } finally {
    pendingBootstrap = null;
  }
}

/**
 * The initialized storage provider, or null when storage is unavailable —
 * not bootstrapped yet, or bootstrapped and failed.
 *
 * Null is a supported state, not an error: consumers degrade to their
 * non-persistent behaviour rather than reporting a failure to the user.
 *
 * @returns {import('./StorageProvider.js').StorageProvider|null}
 */
export function getStorage() {
  return activeProvider;
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
  activeProvider = null;
  try {
    await shutdownStorage();
  } catch (error) {
    logger.error('Storage shutdown failed', { component: COMPONENT, error: error.message });
  }
}
