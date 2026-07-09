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
import { loadSkillsMetadata } from './services/skillLoader.js';
import { validateSourceConfig } from './validators/sourceConfigSchema.js';
import { createHash } from 'crypto';
import ApiKeyVerifier from './utils/ApiKeyVerifier.js';
import tokenStorageService from './services/TokenStorageService.js';
import { SECRET_FIELDS_BY_TYPE } from './validators/credentialSchema.js';
import logger from './utils/logger.js';

/**
 * Resolve environment variables in a string
 * Replaces ${VAR_NAME} with the value of process.env.VAR_NAME
 */
function resolveEnvVars(value) {
  if (typeof value !== 'string') return value;

  // Support both ${VAR} and the shell-style ${VAR:-default}. The default form
  // is what migrations like V031 write (`${OTEL_EXPORTER_OTLP_ENDPOINT:-http://localhost:4318}`)
  // so without :-default support those placeholders pass through verbatim.
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (match, varName, fallback) => {
      const envValue = process.env[varName];
      if (envValue !== undefined && envValue !== '') {
        return envValue;
      }
      if (fallback !== undefined) {
        return fallback;
      }
      logger.warn('Environment variable not defined, keeping placeholder', {
        component: 'ConfigCache',
        varName,
        placeholder: match
      });
      return match;
    }
  );
}

/**
 * Recursively resolve environment variables in an object. Exported so other
 * subsystems (e.g. server/telemetry.js) that read raw JSON before configCache
 * is up can perform the same `${VAR}` / `${VAR:-default}` substitution the
 * rest of the platform expects.
 *
 * Callers can pass `skipPaths` to opt out specific dot-paths from env var
 * substitution. This matters for fields that contain *user-data* templates
 * (e.g. `${user.username}` is a placeholder for the authenticated user's
 * username, NOT for `process.env.username`) — Windows automatically sets
 * `process.env.username` to the OS user running the process, so without an
 * opt-out the resolver would silently leak the service account into every
 * such template. The skip decision belongs to whoever owns the config
 * schema (e.g. `setCacheEntry` for platform.json); this function is just
 * the mechanism.
 *
 * @param {*} obj - Object/array/primitive to recursively resolve
 * @param {Object} [options]
 * @param {string[]|Set<string>} [options.skipPaths] - Dot-paths to leave verbatim
 * @param {string} [options.path] - Internal: current dot-path used for skip-list checks
 */
export function resolveEnvVarsInObject(obj, options = {}) {
  if (!obj || typeof obj !== 'object') return obj;

  const path = options.path || '';
  const skipPaths =
    options.skipPaths instanceof Set ? options.skipPaths : new Set(options.skipPaths || []);

  if (Array.isArray(obj)) {
    return obj.map((item, idx) =>
      resolveEnvVarsInObject(item, { skipPaths, path: `${path}[${idx}]` })
    );
  }

  const resolved = {};
  for (const [key, value] of Object.entries(obj)) {
    const childPath = path ? `${path}.${key}` : key;
    if (skipPaths.has(childPath)) {
      resolved[key] = value;
      continue;
    }
    if (typeof value === 'string') {
      resolved[key] = resolveEnvVars(value);
    } else if (typeof value === 'object') {
      resolved[key] = resolveEnvVarsInObject(value, { skipPaths, path: childPath });
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

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
          // Extract from multilingual object
          toolName = toolName.en || toolName.de || Object.values(toolName)[0] || tool.id;
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
 * Declarative registry for the config types that need more than a plain
 * `loadJson()` — special-cased loading, defaults, or post-processing.
 * Consumed by `initialize()`, `refreshCacheEntry()`, and the `refreshXCache()`
 * wrappers so each type's load/transform logic lives in exactly one place.
 *
 * `load({ verbose, useCache })` returns the resolved data, or `null` if the
 * underlying file is missing/unreadable (matching `loadJson`'s contract).
 * `count(data)` overrides the logged item count for non-array data; when
 * omitted, `data.length` is used for arrays and no count is logged otherwise.
 * `onLoadErrorEmptyValue` marks loaders whose failures should be swallowed
 * (logged as a warning, cache set to this fallback value) instead of
 * propagating — matching agent profiles' existing "best effort" loading.
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
    onLoadErrorEmptyValue: []
  },
  'config/tools.json': {
    label: 'tools',
    load: async ({ verbose }) => expandToolFunctions(await loadAllTools(true, verbose))
  },
  'config/groups.json': {
    label: 'groups with resolved inheritance',
    load: async ({ useCache }) => {
      const groupsConfig = await loadJson('config/groups.json', { useCache });
      return groupsConfig !== null ? resolveGroupInheritance(groupsConfig) : null;
    },
    count: data => Object.keys(data.groups || {}).length
  },
  'config/platform.json': {
    label: 'platform config',
    load: async ({ useCache }) => {
      const platformData = await loadJson('config/platform.json', { useCache });
      if (platformData === null) return null;
      // Decrypt the realtime speech API key so the WS proxy receives
      // plaintext. Env-var placeholders are resolved later in setCacheEntry.
      if (platformData.speech?.realtime?.apiKey) {
        platformData.speech.realtime.apiKey = decryptIfEncrypted(
          platformData.speech.realtime.apiKey
        );
      }
      // Decrypt the Azure Speech subscription key so the token broker
      // (/api/voice/azure/token) can exchange it for a short-lived token.
      if (platformData.speech?.azure?.subscriptionKey) {
        platformData.speech.azure.subscriptionKey = decryptIfEncrypted(
          platformData.speech.azure.subscriptionKey
        );
      }
      return platformData;
    }
  },
  'config/credentials.json': {
    label: 'credential store',
    load: async ({ useCache }) => {
      const credentialsData = await loadJson('config/credentials.json', { useCache });
      // Missing/empty store is valid — treat as no credentials.
      const resolved = credentialsData !== null ? credentialsData : { credentials: {} };
      decryptCredentials(resolved);
      return resolved;
    },
    count: data => Object.keys(data.credentials || {}).length
  }
};

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
 * - Fallback to file loading if cache miss occurs
 */

class ConfigCache {
  constructor() {
    this.cache = new Map();
    this.refreshTimers = new Map();
    this.isInitialized = false;
    this.localeLoadingLocks = new Map();
    this.apiKeyVerifier = new ApiKeyVerifier();

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
      'config/agents.json'
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

    // Discover supported languages from built-in locale files
    this.defaultLocales = await listBuiltinLocales();
    logger.info('Discovered built-in locales', {
      component: 'ConfigCache',
      locales: this.defaultLocales
    });

    const loadPromises = this.criticalConfigs.map(async configPath => {
      try {
        const loader = CONFIG_LOADERS[configPath];
        if (loader) {
          let data;
          try {
            data = await loader.load({ verbose: true, useCache: true });
          } catch (err) {
            if (loader.onLoadErrorEmptyValue === undefined) throw err;
            logger.warn(`Failed to load ${loader.label} (cache will be empty)`, {
              component: 'ConfigCache',
              error: err.message
            });
            this.setCacheEntry(configPath, loader.onLoadErrorEmptyValue);
            return;
          }

          if (data !== null) {
            this.setCacheEntry(configPath, data);
            const count = loadedItemCount(loader, data);
            logger.info(`Cached ${loader.label}`, {
              component: 'ConfigCache',
              configPath,
              ...(count !== undefined ? { count } : {})
            });
          } else {
            logger.warn(`Failed to load ${loader.label}`, { component: 'ConfigCache', configPath });
          }
          return;
        }

        const data = await loadJson(configPath);
        if (data !== null) {
          this.setCacheEntry(configPath, data);
          logger.info('Cached config', { component: 'ConfigCache', configPath });
        } else {
          logger.warn('Failed to load config', { component: 'ConfigCache', configPath });
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
    // Clear existing timer if any
    if (this.refreshTimers.has(key)) {
      clearTimeout(this.refreshTimers.get(key));
    }

    // Resolve environment variables in the data, opting specific fields out
    // when they contain user-data templates instead of env var references.
    const resolvedData = resolveEnvVarsInObject(data, {
      skipPaths: ENV_VAR_SKIP_PATHS_BY_KEY[key]
    });

    // Apply IHUB_* environment variable overrides
    applyIhubEnvOverrides(key, resolvedData);

    // Generate ETag for the data
    const etag = this.generateETag(resolvedData);

    // Set cache entry
    this.cache.set(key, {
      data: resolvedData,
      etag,
      timestamp: Date.now()
    });

    // Set refresh timer
    const refreshTimer = setTimeout(() => {
      this.refreshCacheEntry(key);
    }, this.cacheTTL);

    this.refreshTimers.set(key, refreshTimer);
  }

  /**
   * Refresh a single cache entry
   */
  async refreshCacheEntry(key) {
    const reloadStart = Date.now();
    let reloadError = null;
    try {
      const loader = CONFIG_LOADERS[key];
      if (loader) {
        let data;
        try {
          data = await loader.load({ verbose: false, useCache: false });
        } catch (err) {
          if (loader.onLoadErrorEmptyValue === undefined) throw err;
          logger.warn(`${loader.label} refresh failed`, {
            component: 'ConfigCache',
            key,
            error: err.message
          });
          return;
        }

        if (data !== null) {
          const newEtag = this.generateETag(data);
          const existing = this.cache.get(key);
          if (!existing || existing.etag !== newEtag) {
            this.setCacheEntry(key, data);
            const count = loadedItemCount(loader, data);
            logger.info(`Cached ${loader.label} on refresh`, {
              component: 'ConfigCache',
              configPath: key,
              ...(count !== undefined ? { count } : {})
            });
          }
        }
        return;
      }

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

      const data = await loadJson(key, { useCache: false });
      if (data !== null) {
        this.setCacheEntry(key, data);
      }
    } catch (error) {
      reloadError = error;
      logger.error('Error refreshing cache entry', {
        component: 'ConfigCache',
        key,
        error
      });
      // Keep the old data in cache on refresh failure
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
    return data.find(workflow => workflow.id === id) || null;
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
   * Invalidate and refresh all cached entries
   */
  async refreshAll() {
    logger.info('Refreshing all cached configurations', { component: 'ConfigCache' });

    const refreshPromises = Array.from(this.cache.keys()).map(async configPath => {
      await this.refreshCacheEntry(configPath);
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
  async getToolsForUser(user, platformConfig, language = 'en') {
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
    if (user && user.permissions && user.permissions.tools) {
      const allowedTools = user.permissions.tools;
      tools = filterResourcesByPermissions(tools, allowedTools, 'tools');
    } else if (isAnonymousAccessAllowed(platformConfig)) {
      // For anonymous users, filter to only anonymous-allowed tools
      const allowedTools = new Set(); // No default tools for anonymous
      tools = filterResourcesByPermissions(tools, allowedTools, 'tools');
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

export default configCache;
