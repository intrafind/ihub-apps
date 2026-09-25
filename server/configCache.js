import { loadJson, loadBuiltinLocaleJson, listBuiltinLocales } from './configLoader.js';
import { loadAllApps } from './appsLoader.js';
import { loadAllModels } from './modelsLoader.js';
import { loadAllPrompts } from './promptsLoader.js';
import { loadAllWorkflows } from './workflowsLoader.js';
import { loadAllAgentProfiles } from './agentsLoader.js';
import { loadAllTools } from './toolsLoader.js';
import {
  resolveGroupInheritance,
  filterResourcesByPermissions,
  isAnonymousAccessAllowed
} from './utils/authorization.js';
import { loadTools } from './toolLoader.js';
import { announceConfigChange, announceFullConfigReload, setConfigReloader } from './configSync.js';
import { getStorage } from './storage/bootstrap.js';
import { getRawNamespace } from './storage/namespaces.js';
import { loadSkillsMetadata } from './services/skillLoader.js';
import { validateSourceConfig } from './validators/sourceConfigSchema.js';
import { createHash } from 'crypto';
import ApiKeyVerifier from './utils/ApiKeyVerifier.js';
import tokenStorageService from './services/TokenStorageService.js';
import { SECRET_FIELDS_BY_TYPE } from './validators/credentialSchema.js';
import logger from './utils/logger.js';
import { getLocalizedString } from './utils/localize.js';
import { findByIdCaseInsensitive } from './utils/resourceLookup.js';
import { isToolSelected } from './utils/toolSelection.js';
import { resolveEnvVarsInObject } from './utils/envVars.js';

// Re-exported under the name it has always had here: `telemetry.js` and the
// server tests import it from this module.
export { resolveEnvVarsInObject };

/**
 * Decrypt a single value if it has the ENC[...] format
 */
function decryptIfEncrypted(value) {
  if (!value || typeof value !== 'string') return value;
  if (tokenStorageService.isEncrypted(value)) {
    try {
      return tokenStorageService.decryptString(value);
    } catch (error) {
      logger.error('Failed to decrypt config secret', { component: 'ConfigCache', error });
      return value; // Return encrypted value as-is on failure
    }
  }
  return value;
}

/**
 * Decrypt secret fields in the central credential store so CredentialService
 * consumers receive plaintext. Operates in-place on the credentials map.
 */
function decryptCredentials(config) {
  if (!config || typeof config !== 'object' || !config.credentials) return config;
  for (const profile of Object.values(config.credentials)) {
    if (!profile || typeof profile !== 'object') continue;
    const secretFields = SECRET_FIELDS_BY_TYPE[profile.type] || [];
    for (const field of secretFields) {
      if (profile[field]) {
        profile[field] = decryptIfEncrypted(profile[field]);
      }
    }
  }
  return config;
}

/**
 * Convert an UPPER_SNAKE_CASE segment to camelCase
 * Example: SESSION_TIMEOUT_MINUTES → sessionTimeoutMinutes
 */
function toCamelCase(segment) {
  return segment.toLowerCase().replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/**
 * Parse an environment variable string value to the most appropriate type.
 * Numbers and booleans are coerced; JSON arrays/objects are parsed; otherwise string.
 */
function parseEnvValue(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Set a value at a nested path inside an object.
 * Intermediate objects are created as needed.
 */
function setNestedValue(obj, pathParts, value) {
  if (!obj || typeof obj !== 'object' || pathParts.length === 0) return;

  let current = obj;
  for (let i = 0; i < pathParts.length - 1; i++) {
    const key = pathParts[i];
    if (current[key] === undefined || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key];
  }
  current[pathParts[pathParts.length - 1]] = value;
}

/**
 * Mapping from config cache keys to IHUB_* environment variable prefixes.
 * Double underscores (__) separate nested path segments.
 * Each segment is UPPER_SNAKE_CASE and is converted to camelCase before use.
 *
 * Examples:
 *   IHUB_PLATFORM__AUTH__MODE=anonymous         → platform.json  auth.mode
 *   IHUB_PLATFORM__DEFAULT_LANGUAGE=de          → platform.json  defaultLanguage
 *   IHUB_PLATFORM__RATE_LIMIT__DEFAULT__LIMIT=200 → platform.json rateLimit.default.limit
 *   IHUB_UI__THEME__PRIMARY_COLOR=#ff0000       → ui.json        theme.primaryColor
 */
const IHUB_ENV_PREFIXES = {
  'config/platform.json': 'IHUB_PLATFORM__',
  'config/ui.json': 'IHUB_UI__'
};

/**
 * Per-cache-key config paths that must NOT be passed through env var
 * substitution. Used by `setCacheEntry` to opt specific fields out.
 *
 * Add an entry here when a config field is a *user-data* template
 * (e.g. `${user.username}` placeholder) rather than an env var reference.
 * Without this, `${name}` would be eaten by `resolveEnvVars` when an OS
 * env var of the same name exists (notably Windows `process.env.username`
 * = the OS user running the server) — silently leaking that value into
 * the templated field.
 */
const ENV_VAR_SKIP_PATHS_BY_KEY = {
  'config/platform.json': ['iFinder.jwtSubjectField']
};

/**
 * Scan process.env for IHUB_* overrides and apply them to the given config object.
 * Only configs listed in IHUB_ENV_PREFIXES are processed.
 * Returns the (potentially mutated) data object.
 */
function applyIhubEnvOverrides(configPath, data) {
  const prefix = IHUB_ENV_PREFIXES[configPath];
  if (!prefix || !data || typeof data !== 'object' || Array.isArray(data)) return data;

  for (const [envKey, envValue] of Object.entries(process.env)) {
    if (!envKey.startsWith(prefix)) continue;

    const pathStr = envKey.slice(prefix.length);
    if (!pathStr) continue;

    const pathParts = pathStr.split('__').map(toCamelCase);
    if (pathParts.some(p => !p)) continue; // skip malformed keys

    const parsedValue = parseEnvValue(envValue);
    setNestedValue(data, pathParts, parsedValue);

    logger.info(
      `Applied IHUB env override: ${envKey} → ${pathParts.join('.')} = ${JSON.stringify(parsedValue)}`,
      { component: 'ConfigCache' }
    );
  }

  return data;
}

function expandToolFunctions(tools = []) {
  const expanded = [];
  for (const tool of tools) {
    if (tool.functions && typeof tool.functions === 'object') {
      for (const [fn, cfg] of Object.entries(tool.functions)) {
        // Always extract string value from name (support both string and multilingual object)
        let toolName = tool.name;
        if (typeof toolName === 'object') {
          toolName = getLocalizedString(toolName, 'en', undefined, tool.id);
        } else if (typeof toolName !== 'string') {
          // Fallback to ID if name is neither string nor object
          toolName = tool.id;
        }

        expanded.push({
          ...tool,
          id: `${tool.id}_${fn}`,
          name: cfg.name || `${toolName}_${fn}`,
          description: cfg.description || tool.description,
          parameters: cfg.parameters || {},
          method: fn,
          // Inherit passthrough setting from function definition or tool
          passthrough: cfg.passthrough || tool.passthrough || false
        });
      }
    } else {
      expanded.push(tool);
    }
  }
  return expanded;
}

/**
 * How long change events from the storage provider accumulate before the
 * affected entries are reloaded. Same window as `configSync`'s, and for the
 * same reason: one admin save frequently touches several files (a bulk app
 * import writes one document per app), and reloading a key once per burst
 * beats reloading it once per event.
 */
const STORAGE_CHANGE_COALESCE_MS = 25;

/**
 * Cache key holding the assembled contents of a raw configuration namespace.
 *
 * These six keys are the trap in mapping a storage change onto a cache entry:
 * `config/apps.json` is *not* the file at that path, it is the array
 * `loadAllApps()` builds out of every file under `contents/apps/`. A write to
 * `apps/support-bot.json` therefore invalidates the aggregate, and the cache
 * has never held — and must not start holding — a per-document entry beside
 * it. The `config` and `locales` namespaces are the plain case: one file, one
 * entry, keyed by the path it lives at.
 *
 * @type {Readonly<Object<string, string>>}
 */
const AGGREGATE_KEY_BY_NAMESPACE = Object.freeze({
  apps: 'config/apps.json',
  models: 'config/models.json',
  prompts: 'config/prompts.json',
  workflows: 'config/workflows.json',
  tools: 'config/tools.json',
  agents: 'config/agents.json'
});

/**
 * The cache key a storage change event invalidates, or null when it
 * invalidates nothing this cache could hold.
 *
 * @param {{type?: string, ns?: string, key?: string}} event - A change event
 *   as published by the provider's document store
 * @returns {string|null} Cache key, or null when the event is not a config
 *   document change
 */
function cacheKeyForStorageChange(event) {
  const type = event?.type;
  if (typeof type !== 'string' || !type.startsWith('document.')) return null;
  // Runtime namespaces (chats, runs, interactions) publish an event per
  // message written, so the cheap "is this configuration at all" test runs
  // first and rejects the overwhelming majority of traffic.
  const namespace = getRawNamespace(event?.ns);
  if (!namespace) return null;
  const aggregate = AGGREGATE_KEY_BY_NAMESPACE[event.ns];
  if (aggregate) return aggregate;
  const key = event?.key;
  if (typeof key !== 'string' || !key) return null;
  return `${namespace.dir}/${key}.json`;
}

/**
 * Decrypt the speech secrets platform.json stores encrypted at rest, in place.
 *
 * The realtime WS proxy and the Azure token broker (`/api/voice/azure/token`)
 * read these from the cache and expect plaintext. Env-var placeholders are
 * resolved later, when the entry is stored.
 *
 * @param {Object} platformData - Parsed platform.json
 * @returns {Object} The same object
 */
function decryptPlatformSecrets(platformData) {
  if (platformData.speech?.realtime?.apiKey) {
    platformData.speech.realtime.apiKey = decryptIfEncrypted(platformData.speech.realtime.apiKey);
  }
  if (platformData.speech?.azure?.subscriptionKey) {
    platformData.speech.azure.subscriptionKey = decryptIfEncrypted(
      platformData.speech.azure.subscriptionKey
    );
  }
  return platformData;
}

/**
 * How each cache key is loaded, in one place.
 *
 * `initialize()` and `_reloadEntry()` both read this table, so a type's
 * load/transform logic cannot drift between boot and refresh — which is how
 * a TTL refresh of platform.json came to cache the speech keys still
 * encrypted while boot decrypted them.
 *
 * - `label` names the entry in log lines ("Cached <label>").
 * - `load({ verbose })` resolves the entry's data, or `null` when there is
 *   nothing readable (the `loadJson` contract). Omitted: `loadJson(key)`.
 * - `count(data)` is the item count logged for non-array data. Omitted:
 *   `data.length` for arrays, no count otherwise.
 * - `emptyOnError` marks a best-effort loader: a thrown error is logged as a
 *   warning and boot caches this value instead of failing the entry.
 *
 * Keys not listed here load through the same default as an entry that omits
 * `load`, under the label "config".
 */
const CONFIG_LOADERS = {
  'config/apps.json': {
    label: 'apps',
    load: ({ verbose }) => loadAllApps(true, verbose)
  },
  'config/models.json': {
    label: 'models',
    load: ({ verbose }) => loadAllModels(true, verbose)
  },
  'config/prompts.json': {
    label: 'prompts',
    load: ({ verbose }) => loadAllPrompts(true, verbose)
  },
  'config/workflows.json': {
    label: 'workflows',
    load: ({ verbose }) => loadAllWorkflows(true, verbose)
  },
  'config/agents.json': {
    label: 'agent profiles',
    load: ({ verbose }) => loadAllAgentProfiles(true, verbose),
    emptyOnError: []
  },
  'config/tools.json': {
    label: 'tools',
    load: async ({ verbose }) => expandToolFunctions(await loadAllTools(true, verbose))
  },
  'config/groups.json': {
    label: 'groups with resolved inheritance',
    load: async () => {
      const groupsConfig = await loadJson('config/groups.json');
      return groupsConfig !== null ? resolveGroupInheritance(groupsConfig) : null;
    },
    count: data => Object.keys(data.groups || {}).length
  },
  'config/platform.json': {
    label: 'platform config',
    load: async () => {
      const platformData = await loadJson('config/platform.json');
      return platformData !== null ? decryptPlatformSecrets(platformData) : null;
    }
  },
  'config/credentials.json': {
    label: 'credential store',
    load: async () => {
      // A missing store is valid — it means no credentials.
      const credentialsData = (await loadJson('config/credentials.json')) || { credentials: {} };
      return decryptCredentials(credentialsData);
    },
    count: data => Object.keys(data.credentials || {}).length
  },
  'config/sources.json': {
    label: 'sources'
  },
  'config/providers.json': {
    label: 'providers',
    count: data => (Array.isArray(data) ? data : data.providers || []).length
  },
  'config/registries.json': {
    label: 'registries',
    count: data => (data.registries || []).length
  },
  'config/installations.json': {
    label: 'installations',
    count: data => Object.keys(data.installations || {}).length
  }
};

/**
 * The loader for a cache key, with the defaults filled in.
 *
 * @param {string} key - Cache key, e.g. `'config/apps.json'`
 * @returns {{label: string, load: Function, count?: Function, emptyOnError?: *}}
 */
function loaderFor(key) {
  return { label: 'config', load: () => loadJson(key), ...CONFIG_LOADERS[key] };
}

/**
 * The item count to log for freshly loaded data, or undefined for none.
 *
 * @param {{count?: Function}} loader - Entry from {@link loaderFor}
 * @param {*} data - Loaded data
 * @returns {number|undefined}
 */
function loadedItemCount(loader, data) {
  if (loader.count) return loader.count(data);
  return Array.isArray(data) ? data.length : undefined;
}

/**
 * Configuration Cache Service
 *
 * This service provides memory-based caching for frequently accessed configuration files
 * to eliminate the performance bottleneck of reading from disk on every API request.
 *
 * Features:
 * - Preloads critical configuration files at startup
 * - Provides synchronous access to cached data
 * - Automatic cache refresh with configurable TTL
 */

class ConfigCache {
  constructor() {
    this.cache = new Map();
    this.refreshTimers = new Map();
    this.isInitialized = false;
    this.localeLoadingLocks = new Map();
    this.apiKeyVerifier = new ApiKeyVerifier();

    // Inbound half of the storage provider's change stream; see
    // _subscribeToStorageChanges().
    this.storageChangeProvider = null;
    this.storageChangeUnsubscribe = null;
    this.pendingStorageChanges = new Set();
    this.storageChangeTimer = null;
    this.storageChangeDraining = false;

    // Cache TTL in milliseconds (default: 5 minutes for production, shorter for development)
    this.cacheTTL = process.env.NODE_ENV === 'production' ? 5 * 60 * 1000 : 60 * 1000;

    // List of critical configuration files to preload
    this.criticalConfigs = [
      'config/models.json',
      'config/apps.json',
      'config/tools.json',
      'config/styles.json',
      'config/prompts.json',
      'config/workflows.json',
      'config/platform.json',
      'config/ui.json',
      'config/groups.json',
      'config/users.json',
      'config/sources.json',
      'config/providers.json',
      'config/mimetypes.json',
      'config/features.json',
      'config/registries.json',
      'config/installations.json',
      'config/mcpServers.json',
      'config/credentials.json',
      'config/agents.json',
      // Alongside users.json, and for the same reason: `loadOAuthClients` is a
      // synchronous middleware-path read that consults this cache first and
      // falls back to disk on a miss. Left unpreloaded, every request that
      // resolves an OAuth client took the fallback and logged a warning about
      // it — a cache with a hole in exactly the shape of its hottest reader.
      'config/oauth-clients.json'
    ];

    // Built-in locales that should always be preloaded (resolved dynamically during initialize())
    this.defaultLocales = ['en', 'de'];
  }

  /**
   * Initialize the cache by preloading all critical configuration files
   * Should be called at server startup
   */
  async initialize() {
    logger.info('Initializing configuration cache', { component: 'ConfigCache' });

    // The provider is brought up before this runs (`server/server.js`), so the
    // subscription is attached here rather than at module load, where there is
    // nothing to subscribe to yet.
    this._subscribeToStorageChanges();

    // Discover supported languages from built-in locale files
    this.defaultLocales = await listBuiltinLocales();
    logger.info('Discovered built-in locales', {
      component: 'ConfigCache',
      locales: this.defaultLocales
    });

    const loadPromises = this.criticalConfigs.map(async configPath => {
      try {
        const loader = loaderFor(configPath);
        let data;
        try {
          data = await loader.load({ verbose: true });
        } catch (err) {
          if (loader.emptyOnError === undefined) throw err;
          logger.warn(`Failed to load ${loader.label} (cache will be empty)`, {
            component: 'ConfigCache',
            configPath,
            error: err.message
          });
          this.setCacheEntry(configPath, loader.emptyOnError);
          return;
        }

        if (data !== null) {
          this.setCacheEntry(configPath, data);
          const count = loadedItemCount(loader, data);
          logger.info(`Cached ${loader.label}`, {
            component: 'ConfigCache',
            configPath,
            ...(count !== undefined && { count })
          });
        } else {
          logger.warn(`Failed to load ${loader.label}`, { component: 'ConfigCache', configPath });
        }
      } catch (error) {
        logger.error('Error caching config', { component: 'ConfigCache', configPath, error });
      }
    });

    const localePromises = this.defaultLocales.map(lang => this.loadAndCacheLocale(lang));

    try {
      await Promise.all([...loadPromises, ...localePromises]);

      // Validate that all default locales were loaded successfully
      const failedLocales = [];
      for (const lang of this.defaultLocales) {
        const locale = this.getLocalizations(lang);
        if (!locale) {
          failedLocales.push(lang);
        }
      }

      if (failedLocales.length > 0) {
        logger.error('Failed to load default locales', {
          component: 'ConfigCache',
          failedLocales
        });
        // Don't fail startup, but log the issue
      }

      // Validate API keys for enabled models
      const modelsResult = this.getModels();
      if (modelsResult && modelsResult.data) {
        await this.apiKeyVerifier.validateEnabledModelsApiKeys(modelsResult.data);
      }

      // Validate environment variables in platform configuration
      const platformConfig = this.getPlatform();
      if (platformConfig) {
        this.apiKeyVerifier.validateEnvironmentVariables(platformConfig, 'platform.json');
      }

      // Load skills from filesystem using platform config settings
      await this._loadSkillsFromFilesystem(platformConfig);

      this.isInitialized = true;
      logger.info('Configuration cache initialized', {
        component: 'ConfigCache',
        fileCount: this.cache.size
      });
    } catch (error) {
      logger.error('Error during cache initialization', { component: 'ConfigCache', error });
      this.isInitialized = true; // Still mark as initialized to avoid blocking
      logger.info('Configuration cache initialized with errors', { component: 'ConfigCache' });
    }
  }

  /**
   * Generate ETag for data
   */
  generateETag(data) {
    const hash = createHash('sha256'); // lgtm[js/insufficient-password-hash] -- ETag, not a password hash
    hash.update(JSON.stringify(data));
    return `"${hash.digest('hex').substring(0, 32)}"`;
  }

  mergeLocaleData(base = {}, overrides = {}, path = '') {
    const result = { ...base };
    if (typeof overrides !== 'object' || overrides === null) return result;
    for (const [key, value] of Object.entries(overrides)) {
      if (!(key in base)) {
        logger.warn('Unknown locale key in overrides', {
          component: 'ConfigCache',
          key: path + key
        });
        continue;
      }
      if (typeof value === 'object' && value !== null && typeof base[key] === 'object') {
        result[key] = this.mergeLocaleData(base[key], value, `${path + key}.`);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * Set a cache entry with automatic refresh timer
   */
  setCacheEntry(key, data) {
    this._storeEntry(key, this._resolveEntry(key, data));
  }

  /**
   * Resolve raw loaded data into what the cache holds for `key`, and its ETag.
   *
   * The ETag is computed over the resolved data, so a reload has to compare
   * against this — not against the raw data — to tell whether anything
   * changed: any env-var placeholder or `IHUB_*` override otherwise makes
   * every re-read look like an edit.
   *
   * @param {string} key - Cache key
   * @param {*} data - Data as loaded
   * @returns {{data: *, etag: string}}
   * @private
   */
  _resolveEntry(key, data) {
    // Resolve environment variables in the data, opting specific fields out
    // when they contain user-data templates instead of env var references.
    const resolvedData = resolveEnvVarsInObject(data, {
      skipPaths: ENV_VAR_SKIP_PATHS_BY_KEY[key]
    });

    // Apply IHUB_* environment variable overrides
    applyIhubEnvOverrides(key, resolvedData);

    return { data: resolvedData, etag: this.generateETag(resolvedData) };
  }

  /**
   * Store a resolved entry and schedule its next re-read.
   *
   * @param {string} key - Cache key
   * @param {{data: *, etag: string}} entry - From {@link ConfigCache#_resolveEntry}
   * @private
   */
  _storeEntry(key, { data, etag }) {
    this.cache.set(key, {
      data,
      etag,
      timestamp: Date.now()
    });

    this._armRefreshTimer(key);
  }

  /**
   * Schedule the next TTL re-read of one entry.
   *
   * Uses the private reload so a periodic refresh is not announced to the
   * cluster — every worker runs its own timer, and announcing would turn a
   * quiet re-read into N² bus messages and disk reads.
   *
   * Separate from {@link ConfigCache#setCacheEntry} because the chain has to
   * continue when a re-read finds *nothing changed*, which is the common case.
   * `_reloadEntry` only stores an entry when its etag differs, and while the
   * timer lived inside the store, the first unchanged tick after boot armed
   * nothing and the entry
   * simply stopped refreshing for the life of the process. For `groups.json`
   * that meant an edit made outside the admin UI — dropping `adminAccess` from
   * a group, say — never took effect: `get()` is a plain map read with no
   * timestamp check, and the provider's change stream only publishes writes
   * that went through it, never an operator's editor.
   *
   * @param {string} key - Cache key to schedule.
   * @private
   */
  _armRefreshTimer(key) {
    if (this.refreshTimers.has(key)) {
      clearTimeout(this.refreshTimers.get(key));
    }
    const refreshTimer = setTimeout(() => {
      this._reloadEntry(key);
    }, this.cacheTTL);
    // A TTL refresh must never be the only thing keeping the process alive
    // (test runners and CLI scripts that merely read config would hang).
    if (typeof refreshTimer.unref === 'function') refreshTimer.unref();

    this.refreshTimers.set(key, refreshTimer);
  }

  /**
   * Refresh a single cache entry and tell the rest of the cluster to do the same.
   *
   * This is the entry point for the admin routes: they write the JSON file and
   * then call this, so the announcement is what stops the other workers from
   * serving the pre-write contents until their TTL happens to fire.
   *
   * The announcement stays even though the storage provider now publishes a
   * change event of its own for the same write — the two reach different
   * places, see {@link ConfigCache#_subscribeToStorageChanges}.
   *
   * @param {string} key - Cache key, e.g. `'config/platform.json'`.
   */
  async refreshCacheEntry(key) {
    await this._reloadEntry(key);
    announceConfigChange(key);
  }

  /**
   * Reload a single cache entry from disk without announcing it.
   *
   * Used by the TTL timer, by anything applying a change another worker
   * already announced, and by the provider's change stream — re-announcing in
   * any of those would bounce the invalidation around the cluster.
   *
   * Every read here is unconditionally fresh: the reads go through the
   * configuration store, which no longer keeps a cache of its own below this
   * one. The TTL cache `configLoader` used to hold was invisible to
   * {@link ConfigCache#refreshCacheEntry} and gave an admin save up to a
   * minute in which readers still saw the old value.
   *
   * @param {string} key - Cache key.
   */
  async _reloadEntry(key) {
    const reloadStart = Date.now();
    let reloadError = null;
    try {
      if (key.startsWith('locales/')) {
        const lang = key.split('/')[1].replace('.json', '');
        await this.loadAndCacheLocale(lang);
        return;
      }

      // Special handling for skills - load from filesystem, not a JSON file
      if (key === 'skills') {
        const platformConfig = this.getPlatform();
        await this._loadSkillsFromFilesystem(platformConfig);
        return;
      }

      const loader = loaderFor(key);
      let data;
      try {
        data = await loader.load({ verbose: false });
      } catch (err) {
        if (loader.emptyOnError === undefined) throw err;
        logger.warn(`Failed to refresh ${loader.label}`, {
          component: 'ConfigCache',
          key,
          error: err.message
        });
        this._armRefreshTimer(key);
        return;
      }

      if (data === null) {
        // Unreadable right now — a half-written save, a transient EACCES. The
        // cached copy stays, and so must the chain that will try again.
        this._armRefreshTimer(key);
        return;
      }

      const entry = this._resolveEntry(key, data);
      if (this.cache.get(key)?.etag === entry.etag) {
        // Unchanged: nothing to store, and nothing downstream to invalidate —
        // but the chain continues, see _armRefreshTimer().
        this._armRefreshTimer(key);
        return;
      }

      this._storeEntry(key, entry);
      const count = loadedItemCount(loader, entry.data);
      logger.info(`Cached ${loader.label} on refresh`, {
        component: 'ConfigCache',
        configPath: key,
        ...(count !== undefined && { count })
      });
    } catch (error) {
      reloadError = error;
      logger.error('Error refreshing cache entry', {
        component: 'ConfigCache',
        key,
        error
      });
      // Keep the old data in cache on refresh failure, and keep retrying it.
      if (this.cache.has(key)) this._armRefreshTimer(key);
    } finally {
      // Telemetry: emit reload counter + duration. Lazy-imported because
      // configCache.js is itself imported very early in the boot sequence.
      try {
        const { recordConfigReload } = await import('./telemetry/metrics.js');
        recordConfigReload(key, (Date.now() - reloadStart) / 1000, reloadError);
      } catch {
        // never break a reload because telemetry isn't ready yet
      }
    }
  }

  /**
   * Follow the storage provider's change stream into this cache.
   *
   * This runs **in addition to** the cluster announcement
   * {@link ConfigCache#refreshCacheEntry} sends, never instead of it. The two
   * carry the same invalidation over different distances, and neither covers
   * the other's ground:
   *
   * - `announceConfigChange` goes over the cluster IPC bus and is the only
   *   thing that reaches this machine's *other workers*. The filesystem
   *   provider's notifier is a bare in-process `EventEmitter`
   *   (`getCapabilities().notifications === 'in-process'`), so replacing the
   *   announcement with it would silently undo the cross-worker invalidation
   *   `server/configSync.js` exists to provide: an admin save would land on
   *   one worker and every other worker would keep serving the pre-write
   *   config until its TTL happened to fire.
   * - The notifier, in turn, catches writes the announcement never sees — a
   *   write from another instance once a push-capable provider lands, or one
   *   from code that forgot its `refreshCacheEntry` call. On today's
   *   single-instance provider the writer has already refreshed its own cache
   *   by the time the event arrives, so this is a same-process no-op.
   *
   * The sink is `_reloadEntry`, not `refreshCacheEntry`, mirroring the
   * reloader `configSync` injects at the bottom of this module: an
   * invalidation that arrived from elsewhere must not be announced back out,
   * or two workers bounce it between them forever.
   *
   * Idempotent, and re-subscribes when the provider instance changes (a test
   * harness bringing a second one up), because a notifier that has been closed
   * has dropped every handler it held.
   *
   * @returns {boolean} Whether this cache is now following a provider
   */
  _subscribeToStorageChanges() {
    const provider = getStorage();
    if (!provider) return false;
    if (provider === this.storageChangeProvider) return true;

    this.storageChangeUnsubscribe?.();
    this.storageChangeUnsubscribe = null;
    this.storageChangeProvider = null;

    try {
      const notifier = provider.notifier;
      if (typeof notifier?.subscribe !== 'function') {
        logger.warn('Storage provider publishes no change events', {
          component: 'ConfigCache',
          provider: provider.name
        });
        return false;
      }
      this.storageChangeUnsubscribe = notifier.subscribe(event => this._onStorageChange(event));
      this.storageChangeProvider = provider;
      logger.info('Following configuration changes from the storage provider', {
        component: 'ConfigCache',
        provider: provider.name,
        reach: provider.getCapabilities?.().notifications
      });
      return true;
    } catch (error) {
      // A provider without a notifier facet is usable for everything else; the
      // cluster announcement still invalidates, so this is a warning.
      logger.warn('Unable to follow storage provider change events', {
        component: 'ConfigCache',
        error: error.message
      });
      return false;
    }
  }

  /**
   * Queue the cache entry a change event invalidates.
   *
   * @param {{type?: string, ns?: string, key?: string}} event - Change event
   * @returns {void}
   */
  _onStorageChange(event) {
    const key = cacheKeyForStorageChange(event);
    // Only what is actually held: a write to a locale nobody loaded, or to a
    // config file outside `criticalConfigs`, has nothing to invalidate here,
    // and reloading it would put an entry in the cache that boot never chose.
    if (!key || !this.cache.has(key)) return;
    this.pendingStorageChanges.add(key);
    this._scheduleStorageChangeDrain();
  }

  /**
   * Arm the coalescing window, unless it is already armed.
   *
   * @returns {void}
   */
  _scheduleStorageChangeDrain() {
    if (this.storageChangeTimer) return;
    const timer = setTimeout(() => this._drainStorageChanges(), STORAGE_CHANGE_COALESCE_MS);
    // A queued invalidation must never be the only thing keeping the process
    // alive, exactly as the TTL timers above must not.
    if (typeof timer.unref === 'function') timer.unref();
    this.storageChangeTimer = timer;
  }

  /**
   * Reload the entries queued by the change stream.
   *
   * @returns {Promise<void>}
   */
  async _drainStorageChanges() {
    this.storageChangeTimer = null;

    if (this.storageChangeDraining) {
      // A drain in flight took its snapshot already; re-arm instead of running
      // a second reload of the same key concurrently.
      this._scheduleStorageChangeDrain();
      return;
    }

    const keys = [...this.pendingStorageChanges];
    this.pendingStorageChanges.clear();
    if (keys.length === 0) return;

    this.storageChangeDraining = true;
    try {
      // Sequential: a burst is a handful of keys, and reloading them one at a
      // time keeps a config save from competing with request traffic for I/O.
      // `_reloadEntry` handles its own failures and keeps the old data.
      for (const key of keys) {
        await this._reloadEntry(key);
      }
      logger.debug('Applied config change from the storage provider', {
        component: 'ConfigCache',
        keys
      });
    } finally {
      this.storageChangeDraining = false;
      if (this.pendingStorageChanges.size > 0) this._scheduleStorageChangeDrain();
    }
  }

  /**
   * Get configuration data from cache (synchronous)
   * Returns null if not found in cache
   */
  get(configPath) {
    const entry = this.cache.get(configPath);
    if (!entry) {
      return {
        data: null,
        etag: null
      };
    }

    // Validate cache entry structure
    if (!entry.data || typeof entry.data !== 'object') {
      logger.warn('Cache entry has invalid data structure', {
        component: 'ConfigCache',
        configPath
      });
      return {
        data: null,
        etag: null
      };
    }

    return entry;
  }

  /**
   * Get models configuration (most frequently accessed)
   */
  getModels(includeDisabled = false) {
    // After cache simplification, all models (including disabled) are now stored in config/models.json
    const models = this.get('config/models.json');
    if (models === null || !models.data) {
      logger.warn('Models cache not initialized - returning empty object', {
        component: 'ConfigCache'
      });
      return { data: [], etag: null };
    }

    if (includeDisabled) {
      return models;
    }

    // Filter to only enabled models
    return {
      data: models.data.filter(model => model.enabled !== false),
      etag: models.etag
    };
  }

  /**
   * Get agent profiles configuration
   */
  getAgentProfiles(includeDisabled = false) {
    const profiles = this.get('config/agents.json');
    if (profiles === null || !profiles.data) {
      return { data: [], etag: null };
    }
    if (includeDisabled) return profiles;
    return {
      data: profiles.data.filter(p => p.enabled !== false),
      etag: profiles.etag
    };
  }

  /**
   * Get apps configuration
   */
  getApps(includeDisabled = false) {
    // After cache simplification, all apps (including disabled) are now stored in config/apps.json
    const apps = this.get('config/apps.json');
    if (apps === null || !apps.data) {
      logger.warn('Apps cache not initialized - returning empty array', {
        component: 'ConfigCache'
      });
      return { data: [], etag: null };
    }

    if (includeDisabled) {
      return apps;
    }

    // Filter to only enabled apps
    return {
      data: apps.data.filter(app => app.enabled !== false),
      etag: apps.etag
    };
  }

  /**
   * Get tools configuration
   */
  getTools(includeDisabled = false) {
    // After cache simplification, all tools (including disabled) are now stored in config/tools.json
    const tools = this.get('config/tools.json');
    if (tools === null || !tools.data) {
      logger.warn('Tools cache not initialized - returning empty array', {
        component: 'ConfigCache'
      });
      return { data: [], etag: null };
    }

    if (includeDisabled) {
      return tools;
    }

    // Filter to only enabled tools
    return {
      data: tools.data.filter(tool => tool.enabled !== false),
      etag: tools.etag
    };
  }

  /**
   * Get styles configuration
   */
  getStyles() {
    return this.get('config/styles.json');
  }

  /**
   * Get prompts configuration
   */
  getPrompts(includeDisabled = false) {
    const cacheKey = 'config/prompts.json';
    const prompts = this.get(cacheKey);

    if (prompts === null || !prompts.data) {
      logger.warn('Prompts cache not initialized - returning empty array', {
        component: 'ConfigCache'
      });
      return { data: [], etag: null };
    }

    if (includeDisabled) {
      return prompts;
    }

    // Filter to only enabled prompts
    return {
      data: prompts.data.filter(prompt => prompt.enabled !== false),
      etag: prompts.etag
    };
  }

  /**
   * Get all workflow definitions
   * @param {boolean} includeDisabled - Include disabled workflows
   * @returns {{ data: Array, etag: string }} Workflows with ETag
   */
  getWorkflows(includeDisabled = false) {
    const cacheKey = 'config/workflows.json';
    const workflows = this.get(cacheKey);

    if (workflows === null || !workflows.data) {
      logger.warn('Workflows cache not initialized - returning empty array', {
        component: 'ConfigCache'
      });
      return { data: [], etag: null };
    }

    if (includeDisabled) {
      return workflows;
    }

    // Filter to only enabled workflows
    return {
      data: workflows.data.filter(workflow => workflow.enabled !== false),
      etag: workflows.etag
    };
  }

  /**
   * Get a single workflow by ID
   * @param {string} id - Workflow ID
   * @returns {object|null} Workflow definition or null if not found
   */
  getWorkflowById(id) {
    const { data } = this.getWorkflows(true);
    return findByIdCaseInsensitive(data, id) || null;
  }

  /**
   * Get workflows accessible to a specific user based on their groups
   * @param {object} user - User object with groups array
   * @returns {{ data: Array, etag: string }} Filtered workflows with ETag
   */
  getWorkflowsForUser(user) {
    const { data, etag } = this.getWorkflows();

    const filtered = data.filter(workflow => {
      // No restrictions means everyone can access
      if (!workflow.allowedGroups || workflow.allowedGroups.length === 0) {
        return true;
      }
      // User must have at least one matching group
      if (!user?.groups) return false;
      return workflow.allowedGroups.some(group => user.groups.includes(group));
    });

    // Generate user-specific ETag if workflows were filtered
    let userSpecificEtag = etag;
    if (filtered.length < data.length) {
      const workflowIds = filtered.map(w => w.id).sort();
      const contentHash = createHash('md5')
        .update(JSON.stringify(workflowIds))
        .digest('hex')
        .substring(0, 8);
      userSpecificEtag = `${etag}-${contentHash}`;
    }

    return { data: filtered, etag: userSpecificEtag };
  }

  /**
   * Get sources configuration
   */
  getSources(includeDisabled = false) {
    try {
      const cached = this.get('config/sources.json');
      if (!cached) {
        return { data: [], etag: null };
      }

      // Handle both array format and object format
      let sources;
      if (Array.isArray(cached.data)) {
        sources = { data: cached.data, etag: cached.etag };
      } else if (cached.data && typeof cached.data === 'object') {
        sources = cached;
      } else {
        return { data: [], etag: null };
      }

      if (includeDisabled) return sources;

      return {
        data: sources.data.filter(source => source.enabled !== false),
        etag: sources.etag
      };
    } catch (error) {
      logger.error('Error loading sources', { component: 'ConfigCache', error });
      return { data: [], etag: null };
    }
  }

  /**
   * Get providers configuration
   */
  getProviders(includeDisabled = false) {
    try {
      const cached = this.get('config/providers.json');
      if (!cached) {
        return { data: [], etag: null };
      }

      // Handle both array format and object format
      let providers;
      if (Array.isArray(cached.data)) {
        providers = { data: cached.data, etag: cached.etag };
      } else if (cached.data && cached.data.providers && Array.isArray(cached.data.providers)) {
        providers = { data: cached.data.providers, etag: cached.etag };
      } else {
        return { data: [], etag: null };
      }

      if (includeDisabled) return providers;

      return {
        data: providers.data.filter(provider => provider.enabled !== false),
        etag: providers.etag
      };
    } catch (error) {
      logger.error('Error loading providers', { component: 'ConfigCache', error });
      return { data: [], etag: null };
    }
  }

  /**
   * Get platform configuration
   */
  getPlatform() {
    return this.get('config/platform.json').data;
  }

  /**
   * Get the decrypted central credential store ({ credentials: { id: profile } }).
   */
  getCredentials() {
    return this.get('config/credentials.json').data || { credentials: {} };
  }

  /**
   * Refresh the credential store cache entry (after admin writes).
   */
  async refreshCredentialsCache() {
    await this.refreshCacheEntry('config/credentials.json');
  }

  /**
   * Get groups configuration with resolved inheritance
   */
  getGroups() {
    return this.get('config/groups.json');
  }

  /**
   * Get UI configuration
   */
  getUI() {
    return this.get('config/ui.json');
  }

  /**
   * Get mimetypes configuration
   */
  getMimetypes() {
    return this.get('config/mimetypes.json');
  }

  /**
   * Get features configuration
   */
  getFeatures() {
    const result = this.get('config/features.json');
    return result?.data || {};
  }

  /**
   * Get the list of supported language codes, derived from built-in locale files.
   */
  getSupportedLanguages() {
    return this.defaultLocales;
  }

  /**
   * Get localization data for a specific language
   */
  getLocalizations(language = 'en') {
    return this.get(`locales/${language}.json`);
  }

  async loadAndCacheLocale(language) {
    const lockKey = `locale-${language}`;

    // Check if this locale is already being loaded
    if (this.localeLoadingLocks.has(lockKey)) {
      logger.info('Locale already being loaded, waiting', {
        component: 'ConfigCache',
        language
      });
      return await this.localeLoadingLocks.get(lockKey);
    }

    // Create a promise to lock this locale loading
    const loadPromise = this._loadAndCacheLocaleInternal(language);
    this.localeLoadingLocks.set(lockKey, loadPromise);

    try {
      const result = await loadPromise;
      return result;
    } finally {
      // Always clean up the lock
      this.localeLoadingLocks.delete(lockKey);
    }
  }

  async _loadAndCacheLocaleInternal(language) {
    try {
      // Check if locale is already cached
      const existing = this.cache.get(`locales/${language}.json`);
      const wasInCache = !!existing;

      const base = await loadBuiltinLocaleJson(`${language}.json`);
      if (!base) {
        logger.warn('Failed to load builtin locale', {
          component: 'ConfigCache',
          language
        });
        return null;
      }

      const overrides = (await loadJson(`locales/${language}.json`)) || {};
      const merged = this.mergeLocaleData(base, overrides);

      // Generate ETag to check if content has changed
      const newEtag = this.generateETag(merged);
      const hasChanged = !existing || existing.etag !== newEtag;

      // Only log if this is initial load or content has changed
      if (!wasInCache || hasChanged) {
        logger.info('Loading locale', { component: 'ConfigCache', language });
      }

      this.setCacheEntry(`locales/${language}.json`, merged);

      // Only log success if this is initial load or content has changed
      if (!wasInCache || hasChanged) {
        logger.info('Locale cached', {
          component: 'ConfigCache',
          language,
          keyCount: Object.keys(merged).length,
          overrideCount: Object.keys(overrides).length
        });
      }

      return merged;
    } catch (error) {
      logger.error('Error caching locale', {
        component: 'ConfigCache',
        language,
        error
      });
      return null;
    }
  }

  /**
   * Refresh models cache (both enabled and all models)
   * Should be called when models are modified (create, update, delete, toggle)
   */
  async refreshModelsCache() {
    logger.info('Refreshing models cache', { component: 'ConfigCache' });

    try {
      await this.refreshCacheEntry('config/models.json');
      const { data: models } = this.getModels(true);
      logger.info('Models cache refreshed', { component: 'ConfigCache', count: models.length });
    } catch (error) {
      logger.error('Error refreshing models cache', { component: 'ConfigCache', error });
    }
  }

  /**
   * Refresh agent profiles cache.
   * Call when profiles are created, updated, or deleted.
   */
  async refreshAgentProfilesCache() {
    logger.info('Refreshing agent profiles cache', { component: 'ConfigCache' });
    try {
      await this.refreshCacheEntry('config/agents.json');
      const { data: profiles } = this.getAgentProfiles(true);
      logger.info('Agent profiles cache refreshed', {
        component: 'ConfigCache',
        count: profiles.length
      });
    } catch (error) {
      logger.error('Error refreshing agent profiles cache', {
        component: 'ConfigCache',
        error
      });
    }
  }

  /**
   * Refresh apps cache (both enabled and all apps)
   * Should be called when apps are modified (create, update, delete, toggle)
   */
  async refreshAppsCache() {
    logger.info('Refreshing apps cache', { component: 'ConfigCache' });

    try {
      await this.refreshCacheEntry('config/apps.json');
      const { data: apps } = this.getApps(true);
      logger.info('Apps cache refreshed', { component: 'ConfigCache', count: apps.length });
    } catch (error) {
      logger.error('Error refreshing apps cache', { component: 'ConfigCache', error });
    }
  }

  /**
   * Refresh prompts cache (both enabled and all prompts)
   * Should be called when prompts are modified (create, update, delete, toggle)
   */
  async refreshPromptsCache() {
    logger.info('Refreshing prompts cache', { component: 'ConfigCache' });

    try {
      await this.refreshCacheEntry('config/prompts.json');
      const { data: prompts } = this.getPrompts(true);
      logger.info('Prompts cache refreshed', { component: 'ConfigCache', count: prompts.length });
    } catch (error) {
      logger.error('Error refreshing prompts cache', { component: 'ConfigCache', error });
    }
  }

  /**
   * Refresh tools cache (both enabled and all tools)
   * Should be called when tools are modified (create, update, delete, toggle)
   */
  async refreshToolsCache() {
    logger.info('Refreshing tools cache', { component: 'ConfigCache' });

    try {
      await this.refreshCacheEntry('config/tools.json');
      const { data: tools } = this.getTools(true);
      logger.info('Tools cache refreshed', { component: 'ConfigCache', count: tools.length });
    } catch (error) {
      logger.error('Error refreshing tools cache', { component: 'ConfigCache', error });
    }
  }

  /**
   * Refresh workflows cache (both enabled and all workflows)
   * Should be called when workflows are modified (create, update, delete, toggle)
   */
  async refreshWorkflowsCache() {
    logger.info('Refreshing workflows cache', { component: 'ConfigCache' });

    try {
      await this.refreshCacheEntry('config/workflows.json');
      const { data: workflows } = this.getWorkflows(true);
      logger.info('Workflows cache refreshed', {
        component: 'ConfigCache',
        count: workflows.length
      });
    } catch (error) {
      logger.error('Error refreshing workflows cache', { component: 'ConfigCache', error });
    }
  }

  /**
   * Refresh sources cache
   * Should be called when sources are modified (create, update, delete, toggle)
   */
  async refreshSourcesCache() {
    logger.info('Refreshing sources cache', { component: 'ConfigCache' });

    try {
      await this.refreshCacheEntry('config/sources.json');

      // Validate sources after refresh
      const { data: sources } = this.getSources(true);
      for (const source of sources) {
        const validation = validateSourceConfig(source);
        if (!validation.success) {
          logger.warn('Invalid source configuration', {
            component: 'ConfigCache',
            sourceId: source.id,
            errors: validation.errors
          });
        }
      }

      logger.info('Sources cache refreshed', { component: 'ConfigCache', count: sources.length });
      return true;
    } catch (error) {
      logger.error('Failed to refresh sources cache', { component: 'ConfigCache', error });
      return false;
    }
  }

  /**
   * Refresh providers cache
   * Should be called when providers are modified (create, update, delete, toggle)
   */
  async refreshProvidersCache() {
    logger.info('Refreshing providers cache', { component: 'ConfigCache' });

    try {
      await this.refreshCacheEntry('config/providers.json');
      const { data: providers } = this.getProviders(true);
      logger.info('Providers cache refreshed', {
        component: 'ConfigCache',
        count: providers.length
      });
      return true;
    } catch (error) {
      logger.error('Failed to refresh providers cache', { component: 'ConfigCache', error });
      return false;
    }
  }

  /**
   * Get registries configuration
   * @returns {{ data: { registries: Array }, etag: string|null }}
   */
  getRegistries() {
    const cached = this.get('config/registries.json');
    if (!cached || !cached.data) {
      return { data: { registries: [] }, etag: null };
    }
    return cached;
  }

  /**
   * Get installations manifest tracking all marketplace-installed content
   * @returns {{ data: { installations: Object }, etag: string|null }}
   */
  getInstallations() {
    const cached = this.get('config/installations.json');
    if (!cached || !cached.data) {
      return { data: { installations: {} }, etag: null };
    }
    return cached;
  }

  /**
   * Get the MCP outbound servers configuration.
   * @returns {{ data: { servers: Array, security: Object }, etag: string|null }}
   */
  getMcpServers() {
    const cached = this.get('config/mcpServers.json');
    if (!cached || !cached.data) {
      return {
        data: { servers: [], security: { blockPrivateIps: true, allowedHosts: [] } },
        etag: null
      };
    }
    return cached;
  }

  /**
   * Refresh registries cache from disk.
   * Should be called when registries are added, updated, or removed.
   * @returns {Promise<boolean>} True on success, false on failure
   */
  async refreshRegistriesCache() {
    logger.info('Refreshing registries cache', { component: 'ConfigCache' });
    try {
      await this.refreshCacheEntry('config/registries.json');
      const { data } = this.getRegistries();
      logger.info('Registries cache refreshed', {
        component: 'ConfigCache',
        count: (data?.registries || []).length
      });
      return true;
    } catch (error) {
      logger.error('Failed to refresh registries cache', { component: 'ConfigCache', error });
      return false;
    }
  }

  /**
   * Refresh installations cache from disk.
   * Should be called when items are installed, updated, or removed via the marketplace.
   * @returns {Promise<boolean>} True on success, false on failure
   */
  async refreshInstallationsCache() {
    logger.info('Refreshing installations cache', { component: 'ConfigCache' });
    try {
      await this.refreshCacheEntry('config/installations.json');
      const { data } = this.getInstallations();
      const count = Object.keys(data?.installations || {}).length;
      logger.info('Installations cache refreshed', { component: 'ConfigCache', count });
      return true;
    } catch (error) {
      logger.error('Failed to refresh installations cache', { component: 'ConfigCache', error });
      return false;
    }
  }

  /**
   * Load skills from the filesystem using platform config settings.
   * Skills are determined purely by directory presence — no external registry.
   * @param {object} [platformConfig] - Platform config (reads skills.skillsDirectory)
   */
  async _loadSkillsFromFilesystem(platformConfig) {
    try {
      const customDir = platformConfig?.skills?.skillsDirectory || undefined;
      const discoveredSkills = await loadSkillsMetadata(customDir);
      const skills = [...discoveredSkills.values()];

      // Only update cache and log if content has changed (same pattern as other caches)
      const newEtag = this.generateETag(skills);
      const existing = this.cache.get('skills');
      if (!existing || existing.etag !== newEtag) {
        this.setCacheEntry('skills', skills);
        logger.info('Skills discovered and cached', {
          component: 'ConfigCache',
          count: skills.length
        });
      }
    } catch (error) {
      logger.error('Error loading skills from filesystem', { component: 'ConfigCache', error });
      this.setCacheEntry('skills', []);
    }
  }

  /**
   * Refresh skills cache by rescanning the filesystem.
   * Should be called when skills are added, removed, or their SKILL.md is modified.
   */
  async refreshSkillsCache() {
    logger.info('Refreshing skills cache...', { component: 'ConfigCache' });

    try {
      const platformConfig = this.getPlatform();
      await this._loadSkillsFromFilesystem(platformConfig);
      const { data: skills } = this.getSkills();
      logger.info('Skills cache refreshed', { component: 'ConfigCache', count: skills.length });
      return true;
    } catch (error) {
      logger.error('Failed to refresh skills cache', { component: 'ConfigCache', error });
      return false;
    }
  }

  /**
   * Invalidate and refresh all cached entries, cluster-wide.
   */
  async refreshAll() {
    await this._reloadAll();
    // One announcement rather than one per key: the other workers may hold a
    // different key set (locales are loaded on demand), so each decides for
    // itself what "all" means.
    announceFullConfigReload();
  }

  /**
   * Refresh every held cache entry without announcing it.
   */
  async _reloadAll() {
    logger.info('Refreshing all cached configurations', { component: 'ConfigCache' });

    const refreshPromises = Array.from(this.cache.keys()).map(async configPath => {
      await this._reloadEntry(configPath);
    });

    await Promise.all(refreshPromises);
    logger.info('All configurations refreshed', { component: 'ConfigCache' });
  }

  /**
   * Clear all cache entries and timers
   */
  clear() {
    // Clear all refresh timers
    for (const timer of this.refreshTimers.values()) {
      clearTimeout(timer);
    }

    this.refreshTimers.clear();
    this.cache.clear();

    // Queued invalidations name entries that no longer exist. The subscription
    // itself stays: the provider is still up, and `initialize()` re-attaching
    // to the same one is a no-op.
    if (this.storageChangeTimer) clearTimeout(this.storageChangeTimer);
    this.storageChangeTimer = null;
    this.pendingStorageChanges.clear();

    this.isInitialized = false;
    logger.info('Configuration cache cleared', { component: 'ConfigCache' });
  }

  /**
   * Get apps filtered by user permissions with user-specific ETag
   * @param {Object} user - User object with permissions
   * @param {Object} platformConfig - Platform configuration
   * @returns {Promise<Object>} Filtered apps with user-specific ETag
   */
  async getAppsForUser(user, platformConfig) {
    // Get all apps from cache
    let { data: apps = [], etag: appsEtag } = this.getApps();

    if (!apps) {
      return { data: [], etag: null };
    }

    const originalAppsCount = apps.length;
    let userSpecificEtag = appsEtag;

    // Apply filtering based on user permissions
    if (user && user.permissions) {
      const allowedApps = user.permissions.apps || new Set();
      apps = filterResourcesByPermissions(apps, allowedApps, 'apps');
    } else {
      // For anonymous users, apply anonymous filtering
      if (isAnonymousAccessAllowed(platformConfig)) {
        const allowedApps = new Set(['chat']); // Default anonymous apps
        apps = filterResourcesByPermissions(apps, allowedApps, 'apps');
      }
    }

    // Generate user-specific ETag if apps were filtered
    if (apps.length < originalAppsCount) {
      const appIds = apps.map(app => app.id).sort();
      const contentHash = createHash('md5')
        .update(JSON.stringify(appIds))
        .digest('hex')
        .substring(0, 8);
      userSpecificEtag = `${appsEtag}-${contentHash}`;
    }

    return { data: apps, etag: userSpecificEtag };
  }

  /**
   * Get models filtered by user permissions with user-specific ETag
   * @param {Object} user - User object with permissions
   * @param {Object} platformConfig - Platform configuration
   * @returns {Promise<Object>} Filtered models with user-specific ETag
   */
  async getModelsForUser(user) {
    // Get all models from cache
    let { data: models = [], etag: modelsEtag } = this.getModels();

    if (!models) {
      return { data: [], etag: null };
    }

    const originalModelsCount = models.length;
    let userSpecificEtag = modelsEtag;

    // Apply filtering based on user permissions
    if (user && user.permissions) {
      const allowedModels = user.permissions.models || new Set();
      models = filterResourcesByPermissions(models, allowedModels, 'models');
    }

    // Generate user-specific ETag if models were filtered
    if (models.length < originalModelsCount) {
      const modelIds = models.map(model => model.id || model.modelId || model.name).sort();
      const contentHash = createHash('md5')
        .update(JSON.stringify(modelIds))
        .digest('hex')
        .substring(0, 8);
      userSpecificEtag = `${modelsEtag}-${contentHash}`;
    }

    return { data: models, etag: userSpecificEtag };
  }

  /**
   * Get tools filtered by user permissions with user-specific ETag
   * @param {Object} user - User object with permissions
   * @param {Object} platformConfig - Platform configuration
   * @param {string} language - User language for localization
   * @returns {Promise<Object>} Filtered tools with user-specific ETag
   */
  async getToolsForUser(user, platformConfig, language = 'en', { appId } = {}) {
    // Get all tools (including MCP discovered ones) with localization
    let tools = await loadTools(language);
    const { etag: toolsEtag } = this.getTools();

    if (!tools) {
      return { data: [], etag: null };
    }

    // Workflows are first-class citizens (app.workflows). They are NOT mixed
    // into the tools list returned to the chat UI.

    const originalToolsCount = tools.length;
    let userSpecificEtag = toolsEtag || 'no-etag';

    // Apply filtering based on user permissions
    let allowedTools = null;
    if (user && user.permissions && user.permissions.tools) {
      allowedTools = user.permissions.tools;
    } else if (isAnonymousAccessAllowed(platformConfig)) {
      // For anonymous users, filter to only anonymous-allowed tools
      allowedTools = new Set(); // No default tools for anonymous
    }

    if (allowedTools) {
      const granted = new Set(filterResourcesByPermissions(tools, allowedTools, 'tools'));
      // The chat's tools menu asks for the tools of the app it runs in. Those
      // are callable in that app whatever the group grants say, so they are
      // listed too — otherwise the menu cannot name them or tell which MCP
      // server they belong to.
      const appToolRefs = appId
        ? await this.getAppToolRefsForUser(user, platformConfig, appId)
        : [];
      tools = tools.filter(tool => granted.has(tool) || isToolSelected(tool, appToolRefs));
    }

    // Generate user-specific ETag if tools were filtered
    if (tools.length < originalToolsCount) {
      const toolIds = tools.map(tool => tool.id).sort();
      const contentHash = createHash('md5')
        .update(JSON.stringify(toolIds))
        .digest('hex')
        .substring(0, 8);
      userSpecificEtag = `${toolsEtag}-${contentHash}`;
    }

    return { data: tools, etag: userSpecificEtag };
  }

  /**
   * The tool references (`app.tools`) of an app the user may access, or an
   * empty list when the app is unknown or not available to them.
   * @param {object} user
   * @param {object} platformConfig
   * @param {string} appId
   * @returns {Promise<string[]>}
   */
  async getAppToolRefsForUser(user, platformConfig, appId) {
    const { data: apps = [] } = await this.getAppsForUser(user, platformConfig);
    const app = findByIdCaseInsensitive(apps || [], appId);
    return Array.isArray(app?.tools) ? app.tools : [];
  }

  /**
   * Get all discovered skills from the filesystem.
   * Skills are determined purely by directory presence — no external enable/disable registry.
   * @returns {{ data: Array, etag: string }}
   */
  getSkills() {
    const cached = this.get('skills');
    if (cached === null || !cached.data) {
      return { data: [], etag: null };
    }
    return { data: cached.data, etag: cached.etag };
  }

  /**
   * Get skills filtered by user permissions
   * @param {object} user - User object with permissions
   * @param {object} platformConfig - Platform configuration
   * @returns {{ data: Array, etag: string }}
   */
  async getSkillsForUser(user, platformConfig) {
    const { data: skills, etag: skillsEtag } = this.getSkills();

    if (!skills || skills.length === 0) {
      return { data: [], etag: null };
    }

    let filteredSkills = [...skills];
    const originalCount = filteredSkills.length;
    let userSpecificEtag = skillsEtag || 'no-etag';

    // Apply filtering based on user permissions
    if (user && user.permissions && user.permissions.skills && user.permissions.skills.size > 0) {
      const allowedSkills = user.permissions.skills;
      filteredSkills = filterResourcesByPermissions(filteredSkills, allowedSkills);
    } else if (isAnonymousAccessAllowed(platformConfig)) {
      // For anonymous users, no default skills
      const allowedSkills = new Set();
      filteredSkills = filterResourcesByPermissions(filteredSkills, allowedSkills);
    }

    // Generate user-specific ETag if skills were filtered
    if (filteredSkills.length < originalCount) {
      const skillNames = filteredSkills.map(s => s.name).sort();
      const contentHash = createHash('md5')
        .update(JSON.stringify(skillNames))
        .digest('hex')
        .substring(0, 8);
      userSpecificEtag = `${skillsEtag}-${contentHash}`;
    }

    return { data: filteredSkills, etag: userSpecificEtag };
  }

  /**
   * Get skills for a specific app, filtered by app config and user permissions
   * @param {object} app - App configuration with skills array
   * @param {object} user - User object with permissions
   * @param {object} platformConfig - Platform configuration
   * @returns {Promise<Array>}
   */
  async getSkillsForApp(app, user, platformConfig) {
    if (!app.skills || !Array.isArray(app.skills) || app.skills.length === 0) {
      return [];
    }

    const { data: userSkills } = await this.getSkillsForUser(user, platformConfig);

    // Filter to only skills assigned to this app
    return userSkills.filter(skill => app.skills.includes(skill.name));
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const stats = {
      isInitialized: this.isInitialized,
      totalEntries: this.cache.size,
      cacheTTL: this.cacheTTL,
      entries: {}
    };

    for (const [key, entry] of this.cache.entries()) {
      stats.entries[key] = {
        age: Date.now() - entry.timestamp,
        sizeApprox: JSON.stringify(entry.data).length
      };
    }

    return stats;
  }
}

// Create singleton instance
const configCache = new ConfigCache();

// Teach configSync how to apply an invalidation another worker announced. The
// wiring is injected rather than imported the other way round so configSync
// stays a transport concern with no knowledge of what a config entry is.
setConfigReloader({
  entry: key => configCache._reloadEntry(key),
  all: () => configCache._reloadAll()
});

export default configCache;
