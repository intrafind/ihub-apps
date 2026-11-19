// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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
import { DEFAULT_BLOB_BACKEND, createBlobBackend } from './blobBackends.js';
import { failedBlobProbe, runBlobProbe } from './blobProbe.js';
import { ComposedStorageProvider } from './ComposedStorageProvider.js';
import { createLocalBlobBackend } from './localBlobBackend.js';

const COMPONENT = 'StorageRegistry';

/** Provider used when neither the environment nor `platform.json` names one. */
const DEFAULT_PROVIDER = 'filesystem';

/** Environment variable that overrides the configured provider. */
const PROVIDER_ENV_VAR = 'IHUB_STORAGE_PROVIDER';

/** Environment variable that overrides the configured blob backend. */
const BLOB_PROVIDER_ENV_VAR = 'IHUB_STORAGE_BLOBS_PROVIDER';

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
  const raw = Object.hasOwn(storage, provider) ? storage[provider] : null;
  return { provider, config: isPlainObject(raw) ? resolveEnvVarsInObject(raw) : {} };
}

/**
 * Work out where the blobs go and hand back that backend's configuration.
 *
 * Precedence: `IHUB_STORAGE_BLOBS_PROVIDER` beats
 * `platform.json → storage.blobs.provider`, which beats `'default'` (the blob
 * facet of the storage provider itself). The block is optional and absent on
 * an installation that never set it.
 *
 * `${VAR}` placeholders are resolved in the backend's block and in the `ssl`
 * and `proxy` sections handed back with it. A remote backend connects at
 * bootstrap, before the configuration cache exists, so the SSL whitelist and
 * the proxy settings have to come from the raw file; read from the cache they
 * would be empty and a private-CA endpoint could never be reached.
 *
 * The backend's block is returned as stored otherwise: a secret in it may
 * still be `ENC[...]`. The backend opens it when it connects.
 *
 * @param {Object} [platformConfig={}] - Platform configuration (the raw file).
 * @param {Object} [env=process.env] - Environment to read the override from.
 * `encryption` is `storage.encryption`: one switch, off unless the file says
 * `enabled: true` (a fresh installation's default file does). On, every blob
 * write is encrypted; off, blobs are written as they are and blobs encrypted
 * earlier are still decrypted.
 *
 * `encryption.plaintextReads` says what a read does with a stored object that
 * is not encrypted while encryption is on. **This is the seam for the one-time
 * conversion of existing blobs** (`encryptExistingBlobs`): the default backend
 * answers `accept`, because an installation that switches encryption on still
 * holds plaintext blobs and nothing records yet that they were converted; the
 * S3 backend answers `reject` (strict), because it starts from an empty
 * bucket. Once a completed conversion is recorded somewhere, this is where
 * `accept` turns into `reject` for the default backend.
 *
 * @returns {{provider: string, source: 'environment'|'platform.json'|'default',
 *   config: Object, platformConfig: {ssl: Object, proxy: Object},
 *   encryption: {enabled: boolean, plaintextReads: 'reject'|'accept'}}}
 *
 * @example
 * resolveBlobStorageConfig({ storage: { blobs: { provider: 's3', s3: { bucket: 'ihub' } } } }, {});
 * // { provider: 's3', source: 'platform.json', config: { bucket: 'ihub' },
 * //   platformConfig: { ssl: {}, proxy: {} }, encryption: { enabled: false, plaintextReads: 'accept' } }
 */
export function resolveBlobStorageConfig(platformConfig = {}, env = process.env) {
  const storage = isPlainObject(platformConfig?.storage) ? platformConfig.storage : {};
  const blobs = isPlainObject(storage.blobs) ? storage.blobs : {};
  const fromEnv = readName(env?.[BLOB_PROVIDER_ENV_VAR]);
  const fromFile = readName(blobs.provider);
  const provider = fromEnv || fromFile || DEFAULT_BLOB_BACKEND;
  const raw = Object.hasOwn(blobs, provider) ? blobs[provider] : null;
  const section = name =>
    isPlainObject(platformConfig?.[name]) ? resolveEnvVarsInObject(platformConfig[name]) : {};
  return {
    provider,
    source: fromEnv ? 'environment' : fromFile ? 'platform.json' : 'default',
    config: isPlainObject(raw) ? resolveEnvVarsInObject(raw) : {},
    platformConfig: { ssl: section('ssl'), proxy: section('proxy') },
    encryption: resolveBlobEncryption(storage, provider)
  };
}

/**
 * `storage.encryption` as the blob backends use it.
 *
 * @param {Object} storage - The `storage` block.
 * @param {string} provider - Blob backend name.
 * @returns {{enabled: boolean, plaintextReads: 'reject'|'accept'}}
 */
function resolveBlobEncryption(storage, provider) {
  const enabled = isPlainObject(storage.encryption) && storage.encryption.enabled === true;
  return {
    enabled,
    plaintextReads: enabled && provider !== DEFAULT_BLOB_BACKEND ? 'reject' : 'accept'
  };
}

/** The key module, loaded when a blob backend first needs a key. */
const loadKeys = () => import('../crypto/KeyProvider.js');

/**
 * Put the configured blob backend, and with it the encrypting blob store, in
 * front of a provider's blob facet.
 *
 * @param {StorageProvider} base - The provider `storage.provider` names.
 * @param {ReturnType<typeof resolveBlobStorageConfig>} blobs - Where the blobs
 *   go and whether they are encrypted.
 * @param {Object} [env=process.env] - Environment for one-start switches.
 * @returns {StorageProvider} A {@link ComposedStorageProvider}; `base` itself
 *   only when it has no blob facet to put anything in front of.
 * @throws {UnknownProviderError} When the blob backend is not registered.
 * @throws {StorageError} When its configuration is wrong. Neither case falls
 *   back to the base provider's blob facet.
 */
export function composeBlobBackend(base, blobs, env = process.env) {
  const facet = name => {
    try {
      return base[name] || null;
    } catch {
      return null;
    }
  };
  let backend;
  if (!blobs || blobs.provider === DEFAULT_BLOB_BACKEND) {
    const local = facet('blobs');
    // A provider without a blob facet (a test double) has nothing to wrap.
    if (!local) return base;
    backend = createLocalBlobBackend(local, {
      encryption: blobs?.encryption || { enabled: false, plaintextReads: 'accept' },
      loadKeys
    });
  } else {
    backend = createBlobBackend(blobs.provider, blobs.config, {
      platformConfig: blobs.platformConfig,
      // Without a lock facet, deletes are exclusive per process only.
      locks: facet('locks'),
      encryption: blobs.encryption,
      loadKeys,
      env
    });
  }
  return new ComposedStorageProvider({ base, backend });
}

/**
 * Check the configured blob storage without starting the storage provider:
 * build the blob backend from the configuration, run its check, close it.
 *
 * This is what a check command runs before the server is started, and what
 * tells an operator why a start failed. It runs the same steps and the same
 * classification as the start itself (`blobBackend.initialize()`), with one
 * difference: unless `createKeyCheck` is set it writes nothing lasting, so on
 * an empty bucket the key check object is reported as not yet written.
 *
 * For the backend of the **running** server, call
 * `getStorageProvider().blobBackendHandle?.probe()` instead; that reuses its
 * connections.
 *
 * Import this from `storage/index.js`, which registers the backends.
 *
 * @param {Object} [options]
 * @param {Object} [options.platformConfig] - Platform configuration (raw file).
 * @param {Object} [options.env=process.env]
 * @param {boolean} [options.createKeyCheck=false] - Write the key check object
 *   into an empty store, as a start would.
 * @returns {Promise<import('./blobProbe.js').BlobProbeResult & {source: string, encryption: Object}>}
 *   Never rejects; a wrong configuration is a failed `config` step.
 *
 * @example
 * const result = await probeBlobStorage({ platformConfig });
 * if (result.status !== 'ok') console.error(result.error.code, result.error.detail);
 */
export async function probeBlobStorage({
  platformConfig,
  env = process.env,
  createKeyCheck = false
} = {}) {
  const blobs = resolveBlobStorageConfig(platformConfig, env);
  if (blobs.provider === DEFAULT_BLOB_BACKEND) {
    // The provider's own blob facet needs the provider; its check is the start itself.
    const result = await runBlobProbe({ provider: DEFAULT_BLOB_BACKEND, steps: [] });
    return { ...result, source: blobs.source, encryption: blobs.encryption };
  }
  let backend;
  try {
    backend = createBlobBackend(blobs.provider, blobs.config, {
      platformConfig: blobs.platformConfig,
      locks: null,
      encryption: blobs.encryption,
      loadKeys,
      env
    });
  } catch (error) {
    return {
      ...failedBlobProbe(blobs.provider, error),
      source: blobs.source,
      encryption: blobs.encryption
    };
  }
  try {
    const result = await backend.probe({ createKeyCheck });
    return { ...result, source: blobs.source, encryption: blobs.encryption };
  } finally {
    await backend.shutdown().catch(() => {});
  }
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
 * The provider returned is a {@link ComposedStorageProvider}: its blob facet is
 * the encrypting blob store, in front of the provider's own blob facet or of
 * the backend `storage.blobs.provider` names (see
 * {@link resolveBlobStorageConfig}). A blob backend that cannot start fails
 * the initialization like any other storage failure.
 *
 * @returns {Promise<StorageProvider>} The initialized provider.
 * @throws {UnknownProviderError} When the configured provider or blob backend
 *   is not registered.
 */
export async function initializeStorage({ platformConfig, env } = {}) {
  const { provider: name, config } = resolveStorageConfig(platformConfig, env);
  const blobs = resolveBlobStorageConfig(platformConfig, env);

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
    // A blob backend that is unknown or misconfigured throws here, before
    // anything is initialized: the same outcome as an unknown provider.
    const provider = composeBlobBackend(createProvider(name, config), blobs, env);
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
    logger.info('Storage provider initialized', {
      component: COMPONENT,
      provider: name,
      blobs: blobs.provider,
      blobEncryption: blobs.encryption.enabled
    });
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
