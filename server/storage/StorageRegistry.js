/**
 * StorageRegistry — provider registration and the process-wide storage singleton.
 *
 * Which backend the server runs on is a deployment decision, not something the
 * application code should know: repositories ask the registry for the active
 * provider, and the registry resolves it once from the environment and
 * `platform.json`. Providers register a factory here (see `storage/index.js`)
 * instead of being imported where they are used, so adding a backend never
 * touches a call site.
 *
 * Registration is a module-level side effect of importing `storage/index.js`
 * and of nothing else — a provider module must stay importable (for tests, for
 * documentation tooling) without changing global state.
 *
 * @module storage/StorageRegistry
 */
import logger from '../utils/logger.js';
import { StorageError, UnknownProviderError } from './errors.js';
import { resolveEnvVarsInObject } from '../utils/envVars.js';

const COMPONENT = 'StorageRegistry';

/** Provider used when neither the environment nor `platform.json` names one. */
const DEFAULT_PROVIDER = 'filesystem';

/** Environment variable that overrides the configured provider. */
const PROVIDER_ENV_VAR = 'IHUB_STORAGE_PROVIDER';

/** @type {Map<string, (config: Object) => StorageProvider>} */
const factories = new Map();

/** @type {StorageProvider|null} */
let activeProvider = null;
/** @type {string|null} */
let activeProviderName = null;
/** @type {Promise<StorageProvider>|null} */
let pendingInit = null;
/** @type {string|null} */
let pendingProviderName = null;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readName(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function warnProviderChange(requested, current) {
  if (requested === current) return;
  logger.warn('Storage is already initialized; keeping the running provider', {
    component: COMPONENT,
    requested,
    active: current,
    hint: 'Changing the storage provider requires a restart'
  });
}

/**
 * Register a provider factory under a name.
 *
 * Re-registering a name replaces the previous factory, which is what a test
 * that swaps in a double needs; it has no effect on an already initialized
 * singleton.
 *
 * @param {string} name - Provider name as it appears in `storage.provider`.
 * @param {(config: Object) => StorageProvider} factory - Builds a provider
 *   from its configuration block. Must not do I/O — that belongs in
 *   `initialize()`.
 * @returns {void}
 * @throws {StorageError} Code `INVALID_PROVIDER` when the name is empty or the
 *   factory is not a function.
 */
export function registerProvider(name, factory) {
  const key = readName(name);
  if (!key) {
    throw new StorageError('registerProvider requires a non-empty provider name', {
      code: 'INVALID_PROVIDER'
    });
  }
  if (typeof factory !== 'function') {
    throw new StorageError(`registerProvider('${key}') requires a factory function`, {
      code: 'INVALID_PROVIDER'
    });
  }
  factories.set(key, factory);
}

/**
 * Names of every registered provider, sorted, so the list is stable in error
 * messages and admin output.
 *
 * @returns {string[]}
 */
export function getRegisteredProviders() {
  return [...factories.keys()].sort();
}

/**
 * Whether a provider is registered under this name.
 *
 * @param {string} name - Provider name.
 * @returns {boolean}
 */
export function hasProvider(name) {
  const key = readName(name);
  return key ? factories.has(key) : false;
}

/**
 * Work out which provider to use and hand back its configuration block.
 *
 * Precedence: `IHUB_STORAGE_PROVIDER` beats `platform.json → storage.provider`,
 * which beats `'filesystem'`. The environment wins so one image can be pointed
 * at a different backend per environment without editing configuration.
 *
 * `${VAR}` and `${VAR:-default}` placeholders in the returned block are
 * resolved here. Every other part of `platform.json` gets that from
 * `configCache`, but this block is read before the cache can exist — the
 * provider the cache reads config *through* is built from it — so a
 * `baseDir` or a connection string written as a placeholder used to reach the
 * provider factory as the literal text `${IHUB_STORAGE_DIR}`, and the
 * filesystem provider would dutifully create a directory of that name.
 *
 * @param {Object} [platformConfig={}] - Platform configuration.
 * @param {Object} [env=process.env] - Environment to read the override from.
 * @returns {{provider: string, config: Object}} Resolved provider name and its
 *   configuration block — always an object, `{}` when the provider has none.
 */
export function resolveStorageConfig(platformConfig = {}, env = process.env) {
  const storage = isPlainObject(platformConfig?.storage) ? platformConfig.storage : {};
  const provider =
    readName(env?.[PROVIDER_ENV_VAR]) || readName(storage.provider) || DEFAULT_PROVIDER;
  // Own-property lookup only: the name may come from the environment, and
  // `storage['__proto__']` would otherwise hand back Object.prototype as config.
  const raw = Object.prototype.hasOwnProperty.call(storage, provider) ? storage[provider] : null;
  return { provider, config: isPlainObject(raw) ? resolveEnvVarsInObject(raw) : {} };
}

/**
 * Build a provider instance from a registered factory.
 *
 * The result is not required to extend {@link StorageProvider}: the registry
 * duck-types so a test double or a thin adapter stays cheap to write.
 *
 * @param {string} name - Registered provider name.
 * @param {Object} [config={}] - Provider configuration block.
 * @returns {StorageProvider} The (uninitialized) provider.
 * @throws {UnknownProviderError} When no factory is registered under `name`.
 * @throws {StorageError} Code `INVALID_PROVIDER` when the factory returns
 *   something that is not a provider object.
 */
export function createProvider(name, config = {}) {
  const key = readName(name);
  const factory = key ? factories.get(key) : undefined;
  if (!factory) {
    const registered = getRegisteredProviders();
    const known = registered.length > 0 ? registered.join(', ') : '(none)';
    throw new UnknownProviderError(
      `Unknown storage provider '${String(name)}'. Registered providers: ${known}`
    );
  }
  const provider = factory(config);
  if (!provider || typeof provider !== 'object') {
    throw new StorageError(`Storage provider factory for '${key}' did not return a provider`, {
      code: 'INVALID_PROVIDER'
    });
  }
  return provider;
}

/**
 * Resolve, build and initialize the process-wide storage provider.
 *
 * Called twice without an intervening {@link shutdownStorage} it returns the
 * running singleton and logs a warning when the newly resolved provider name
 * differs — swapping backends at runtime would strand every open handle, so it
 * requires a restart. Concurrent callers share one in-flight initialization.
 *
 * The singleton is published only after `initialize()` resolves, so a backend
 * that failed to come up is never handed out.
 *
 * @param {Object} [options={}]
 * @param {Object} [options.platformConfig] - Platform configuration.
 * @param {Object} [options.env] - Environment to read the override from.
 * @returns {Promise<StorageProvider>} The initialized provider.
 * @throws {UnknownProviderError} When the configured provider is not registered.
 */
export async function initializeStorage({ platformConfig, env } = {}) {
  const { provider: name, config } = resolveStorageConfig(platformConfig, env);

  if (activeProvider) {
    warnProviderChange(name, activeProviderName);
    return activeProvider;
  }
  if (pendingInit) {
    warnProviderChange(name, pendingProviderName);
    return pendingInit;
  }

  pendingProviderName = name;
  pendingInit = (async () => {
    const provider = createProvider(name, config);
    try {
      await provider.initialize?.();
    } catch (error) {
      // A half-initialized provider still has to be shut down. The filesystem
      // one owns nothing worth reclaiming, but the contract tells implementers
      // to open pools and connections here — and a backend that is down puts
      // the server in a restart loop, which is precisely when a leak per
      // attempt compounds. The original failure is what the caller needs, so a
      // failing shutdown is logged and swallowed rather than replacing it.
      try {
        await provider.shutdown?.();
      } catch (shutdownError) {
        logger.warn('Shutdown of a provider that failed to initialize also failed', {
          component: COMPONENT,
          provider: name,
          error: shutdownError.message
        });
      }
      throw error;
    }
    activeProvider = provider;
    activeProviderName = name;
    logger.info('Storage provider initialized', { component: COMPONENT, provider: name });
    return provider;
  })();

  try {
    return await pendingInit;
  } finally {
    pendingInit = null;
    pendingProviderName = null;
  }
}

/**
 * The initialized storage provider.
 *
 * @returns {StorageProvider}
 * @throws {StorageError} Code `STORAGE_NOT_INITIALIZED` when
 *   {@link initializeStorage} has not run (or has been shut down).
 */
export function getStorageProvider() {
  if (!activeProvider) {
    throw new StorageError('Storage is not initialized; call initializeStorage() first', {
      code: 'STORAGE_NOT_INITIALIZED'
    });
  }
  return activeProvider;
}

/**
 * Shut the active provider down and clear the singleton. Safe to call when
 * nothing is initialized, and safe to call twice.
 *
 * The singleton is cleared before the provider's `shutdown()` is awaited, so a
 * failing shutdown can never leave a half-closed provider reachable — the
 * rejection still propagates to the caller.
 *
 * @returns {Promise<void>}
 */
export async function shutdownStorage() {
  if (pendingInit) {
    // An initialization is in flight: let it settle so we shut down a fully
    // constructed provider instead of leaking it.
    await pendingInit.catch(() => {});
  }
  const provider = activeProvider;
  const name = activeProviderName;
  activeProvider = null;
  activeProviderName = null;
  if (!provider) return;
  await provider.shutdown?.();
  logger.info('Storage provider shut down', { component: COMPONENT, provider: name });
}
