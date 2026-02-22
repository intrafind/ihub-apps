import { loadJson, loadBuiltinLocaleJson } from './configLoader.js';
import { loadAllApps } from './appsLoader.js';
import { loadAllModels } from './modelsLoader.js';
import { loadAllPrompts } from './promptsLoader.js';
import { loadAllWorkflows } from './workflowsLoader.js';
import {
  resolveGroupInheritance,
  filterResourcesByPermissions,
  isAnonymousAccessAllowed
} from './utils/authorization.js';
import { loadTools, localizeTools } from './toolLoader.js';
import { loadSkillsMetadata } from './services/skillLoader.js';
import { validateSourceConfig } from './validators/sourceConfigSchema.js';
import { createHash } from 'crypto';
import ApiKeyVerifier from './utils/ApiKeyVerifier.js';
import tokenStorageService from './services/TokenStorageService.js';
import logger from './utils/logger.js';

/**
 * Resolve environment variables in a string
 * Replaces ${VAR_NAME} with the value of process.env.VAR_NAME
 */
function resolveEnvVars(value) {
  if (typeof value !== 'string') return value;

  return value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      logger.warn(`Environment variable ${varName} is not defined, keeping placeholder: ${match}`, {
        component: 'ConfigCache'
      });
      return match;
    }
    return envValue;
  });
}

/**
 * Recursively resolve environment variables in an object
 */
function resolveEnvVarsInObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => resolveEnvVarsInObject(item));
  }

  const resolved = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      resolved[key] = resolveEnvVars(value);
    } else if (typeof value === 'object') {
      resolved[key] = resolveEnvVarsInObject(value);
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
      logger.error(`Failed to decrypt config secret: ${error.message}`, {
        component: 'ConfigCache'
      });
      return value; // Return encrypted value as-is on failure
    }
  }
  return value;
}

/**
 * Decrypt known secret fields in platform configuration so runtime consumers
 * (OIDC middleware, LDAP auth, JiraService, etc.) receive plaintext secrets
 */
function decryptPlatformSecrets(config) {
  if (!config || typeof config !== 'object') return config;

  // Jira
  if (config.jira?.clientSecret) {
    config.jira.clientSecret = decryptIfEncrypted(config.jira.clientSecret);
  }

  // Cloud storage providers
  if (config.cloudStorage?.providers) {
    for (const provider of config.cloudStorage.providers) {
      if (provider.clientSecret) {
        provider.clientSecret = decryptIfEncrypted(provider.clientSecret);
      }
      if (provider.type === 'office365' && provider.tenantId) {
        provider.tenantId = decryptIfEncrypted(provider.tenantId);
      }
    }
  }

  // OIDC providers
  if (config.oidcAuth?.providers) {
    for (const provider of config.oidcAuth.providers) {
      if (provider.clientSecret) {
        provider.clientSecret = decryptIfEncrypted(provider.clientSecret);
      }
    }
  }

  // LDAP providers
  if (config.ldapAuth?.providers) {
    for (const provider of config.ldapAuth.providers) {
      if (provider.adminPassword) {
        provider.adminPassword = decryptIfEncrypted(provider.adminPassword);
      }
    }
  }

  // NTLM
  if (config.ntlmAuth?.domainControllerPassword) {
    config.ntlmAuth.domainControllerPassword = decryptIfEncrypted(
      config.ntlmAuth.domainControllerPassword
    );
  }

  return config;
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
      'config/skills.json'
    ];

    // Built-in locales that should always be preloaded
    this.defaultLocales = ['en', 'de'];
  }

  /**
   * Initialize the cache by preloading all critical configuration files
   * Should be called at server startup
   */
  async initialize() {
    logger.info('🚀 Initializing configuration cache...', { component: 'ConfigCache' });

    const loadPromises = this.criticalConfigs.map(async configPath => {
      try {
        // Special handling for apps.json - load from both sources
        if (configPath === 'config/apps.json') {
          // Load all apps (including disabled) for admin access
          const allApps = await loadAllApps(true);
          this.setCacheEntry(configPath, allApps);
          logger.info(`✓ Cached: ${configPath} (${allApps.length} total apps)`, {
            component: 'ConfigCache'
          });
          return;
        }

        // Special handling for models.json - load from both sources
        if (configPath === 'config/models.json') {
          // Also load and cache all models (including disabled)
          const allModels = await loadAllModels(true);
          this.setCacheEntry('config/models.json', allModels);
          logger.info(`✓ Cached: config/models.json (${allModels.length} total models)`, {
            component: 'ConfigCache'
          });
          return;
        }

        // Special handling for prompts.json - load from both sources
        if (configPath === 'config/prompts.json') {
          // Load all prompts (including disabled) for admin access
          const allPrompts = await loadAllPrompts(true);
          this.setCacheEntry(configPath, allPrompts);
          logger.info(`✓ Cached: ${configPath} (${allPrompts.length} total prompts)`, {
            component: 'ConfigCache'
          });
          return;
        }

        // Special handling for workflows.json - load from both sources
        if (configPath === 'config/workflows.json') {
          // Load all workflows (including disabled) for admin access
          const allWorkflows = await loadAllWorkflows(true);
          this.setCacheEntry(configPath, allWorkflows);
          logger.info(`✓ Cached: ${configPath} (${allWorkflows.length} total workflows)`, {
            component: 'ConfigCache'
          });
          return;
        }

        // Special handling for groups.json - load and resolve inheritance
        if (configPath === 'config/groups.json') {
          const groupsConfig = await loadJson(configPath);
          if (groupsConfig !== null) {
            const resolvedConfig = resolveGroupInheritance(groupsConfig);
            this.setCacheEntry(configPath, resolvedConfig);
            logger.info(
              `✓ Cached: ${configPath} (${Object.keys(resolvedConfig.groups || {}).length} groups with resolved inheritance)`,
              { component: 'ConfigCache' }
            );
          } else {
            logger.warn(`⚠️  Failed to load: ${configPath}`, { component: 'ConfigCache' });
          }
          return;
        }

        // Special handling for platform.json - decrypt secrets after loading
        if (configPath === 'config/platform.json') {
          const platformData = await loadJson(configPath);
          if (platformData !== null) {
            decryptPlatformSecrets(platformData);
            this.setCacheEntry(configPath, platformData);
            logger.info(`✓ Cached: ${configPath}`, { component: 'ConfigCache' });
          } else {
            logger.warn(`⚠️  Failed to load: ${configPath}`, { component: 'ConfigCache' });
          }
          return;
        }

        // Special handling for skills.json - load config then scan filesystem for skills
        if (configPath === 'config/skills.json') {
          const skillsConfig = await loadJson(configPath);
          const configData = skillsConfig || { skills: {}, settings: {} };

          // Scan filesystem for actual skill directories
          const customDir = configData.settings?.skillsDirectory || undefined;
          const discoveredSkills = await loadSkillsMetadata(customDir);

          // Merge discovered skills with config overrides
          const mergedSkills = [];
          for (const [name, skillMeta] of discoveredSkills) {
            const configOverride = configData.skills?.[name] || {};
            mergedSkills.push({
              ...skillMeta,
              enabled: configOverride.enabled !== undefined ? configOverride.enabled : true,
              description: configOverride.overrides?.description || skillMeta.description
            });
          }

          this.setCacheEntry(configPath, {
            skills: mergedSkills,
            settings: configData.settings || {}
          });
          logger.info(`✓ Cached: ${configPath} (${mergedSkills.length} skills discovered)`, {
            component: 'ConfigCache'
          });
          return;
        }

        const data = await loadJson(configPath);
        if (data !== null) {
          // Expand tool functions into individual entries
          const finalData = configPath === 'config/tools.json' ? expandToolFunctions(data) : data;
          this.setCacheEntry(configPath, finalData);
          logger.info(`✓ Cached: ${configPath}`, { component: 'ConfigCache' });
        } else {
          logger.warn(`⚠️  Failed to load: ${configPath}`, { component: 'ConfigCache' });
        }
      } catch (error) {
        logger.error(`❌ Error caching ${configPath}:`, {
          component: 'ConfigCache',
          error: error.message
        });
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
        logger.error(`❌ Failed to load default locales: ${failedLocales.join(', ')}`, {
          component: 'ConfigCache'
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

      this.isInitialized = true;
      logger.info(`✅ Configuration cache initialized with ${this.cache.size} files`, {
        component: 'ConfigCache'
      });
    } catch (error) {
      logger.error('❌ Error during cache initialization:', { component: 'ConfigCache', error });
      this.isInitialized = true; // Still mark as initialized to avoid blocking
      logger.info(`⚠️  Configuration cache initialized with errors`, { component: 'ConfigCache' });
    }
  }

  /**
   * Generate ETag for data
   */
  generateETag(data) {
    const hash = createHash('md5');
    hash.update(JSON.stringify(data));
    return `"${hash.digest('hex')}"`;
  }

  mergeLocaleData(base = {}, overrides = {}, path = '') {
    const result = { ...base };
    if (typeof overrides !== 'object' || overrides === null) return result;
    for (const [key, value] of Object.entries(overrides)) {
      if (!(key in base)) {
        logger.warn(`Unknown locale key '${path + key}' in overrides`, {
          component: 'ConfigCache'
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

    // Resolve environment variables in the data
    const resolvedData = resolveEnvVarsInObject(data);

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
    try {
      // Special handling for apps.json - load from both sources
      if (key === 'config/apps.json') {
        const apps = await loadAllApps(true, false);
        const newEtag = this.generateETag(apps);
        const existing = this.cache.get(key);
        if (!existing || existing.etag !== newEtag) {
          this.setCacheEntry(key, apps);
          logger.info(`✓ Cached: config/apps.json (${apps.length} total apps)`, {
            component: 'ConfigCache'
          });
        }
        return;
      }

      // Special handling for models.json - load from both sources
      if (key === 'config/models.json') {
        const models = await loadAllModels(true, false);
        const newEtag = this.generateETag(models);
        const existing = this.cache.get(key);
        if (!existing || existing.etag !== newEtag) {
          this.setCacheEntry(key, models);
          logger.info(`✓ Cached: config/models.json (${models.length} total models)`, {
            component: 'ConfigCache'
          });
        }
        return;
      }

      // Special handling for prompts.json - load from both sources
      if (key === 'config/prompts.json') {
        const prompts = await loadAllPrompts(true, false);
        const newEtag = this.generateETag(prompts);
        const existing = this.cache.get(key);
        if (!existing || existing.etag !== newEtag) {
          this.setCacheEntry(key, prompts);
          logger.info(`✓ Cached: config/prompts.json (${prompts.length} total prompts)`, {
            component: 'ConfigCache'
          });
        }
        return;
      }

      // Special handling for workflows.json - load from both sources
      if (key === 'config/workflows.json') {
        const workflows = await loadAllWorkflows(true, false);
        const newEtag = this.generateETag(workflows);
        const existing = this.cache.get(key);
        if (!existing || existing.etag !== newEtag) {
          this.setCacheEntry(key, workflows);
          logger.info(`✓ Cached: config/workflows.json (${workflows.length} total workflows)`, {
            component: 'ConfigCache'
          });
        }
        return;
      }

      // Special handling for groups.json - load and resolve inheritance
      if (key === 'config/groups.json') {
        const groupsConfig = await loadJson(key, { useCache: false });
        if (groupsConfig !== null) {
          const resolvedConfig = resolveGroupInheritance(groupsConfig);
          const newEtag = this.generateETag(resolvedConfig);
          const existing = this.cache.get(key);
          if (!existing || existing.etag !== newEtag) {
            this.setCacheEntry(key, resolvedConfig);
            logger.info(
              `✓ Cached: config/groups.json (${Object.keys(resolvedConfig.groups || {}).length} groups with resolved inheritance)`,
              { component: 'ConfigCache' }
            );
          }
        }
        return;
      }

      // Special handling for platform.json - decrypt secrets after loading
      if (key === 'config/platform.json') {
        const platformData = await loadJson(key, { useCache: false });
        if (platformData !== null) {
          decryptPlatformSecrets(platformData);
          const newEtag = this.generateETag(platformData);
          const existing = this.cache.get(key);
          if (!existing || existing.etag !== newEtag) {
            this.setCacheEntry(key, platformData);
          }
        }
        return;
      }

      // Special handling for skills.json - rescan filesystem + merge config
      if (key === 'config/skills.json') {
        const skillsConfig = await loadJson(key, { useCache: false });
        const configData = skillsConfig || { skills: {}, settings: {} };
        const customDir = configData.settings?.skillsDirectory || undefined;
        const discoveredSkills = await loadSkillsMetadata(customDir);

        const mergedSkills = [];
        for (const [name, skillMeta] of discoveredSkills) {
          const configOverride = configData.skills?.[name] || {};
          mergedSkills.push({
            ...skillMeta,
            enabled: configOverride.enabled !== undefined ? configOverride.enabled : true,
            description: configOverride.overrides?.description || skillMeta.description
          });
        }

        const cacheData = { skills: mergedSkills, settings: configData.settings || {} };
        const newEtag = this.generateETag(cacheData);
        const existing = this.cache.get(key);
        if (!existing || existing.etag !== newEtag) {
          this.setCacheEntry(key, cacheData);
          logger.info(`✓ Refreshed: ${key} (${mergedSkills.length} skills)`, {
            component: 'ConfigCache'
          });
        }
        return;
      }

      if (key.startsWith('locales/')) {
        const lang = key.split('/')[1].replace('.json', '');
        await this.loadAndCacheLocale(lang);
        return;
      }

      const data = await loadJson(key, { useCache: false });
      if (data !== null) {
        const finalData = key === 'config/tools.json' ? expandToolFunctions(data) : data;
        this.setCacheEntry(key, finalData);
      }
    } catch (error) {
      logger.error(`Error refreshing cache for ${key}:`, {
        component: 'ConfigCache',
        error: error.message
      });
      // Keep the old data in cache on refresh failure
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
      logger.warn(`Cache entry for ${configPath} has invalid data structure`, {
        component: 'ConfigCache'
      });
      return {
        data: null,
        etag: null
      };
    }

    return entry;
  }

  /**
   * Get configuration data with fallback to file loading
   * This maintains backward compatibility while providing performance benefits
   */
  async getWithFallback(configPath) {
    // Try cache first
    const cached = this.get(configPath);
    if (cached !== null) {
      return cached;
    }

    // Fallback to file loading
    logger.warn(`Cache miss for ${configPath}, loading from file`, { component: 'ConfigCache' });
    const data = await loadJson(configPath);

    // Cache the result for future use
    if (data !== null) {
      this.setCacheEntry(configPath, data);
    }

    return data;
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
   * Get apps configuration
   */
  getApps(includeDisabled = false) {
    // After cache simplification, all apps (including disabled) are now stored in config/apps.json
    const apps = this.get('config/apps.json');
    if (apps === null || !apps.data) {
      logger.warn('Apps cache not initialized - returning empty array', {
        component: 'ConfigCache'
      });
      return [];
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
      return [];
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
      return [];
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
      logger.error('Error loading sources:', { component: 'ConfigCache', error });
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
      logger.error('Error loading providers:', { component: 'ConfigCache', error });
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
   * Get localization data for a specific language
   */
  getLocalizations(language = 'en') {
    return this.get(`locales/${language}.json`);
  }

  async loadAndCacheLocale(language) {
    const lockKey = `locale-${language}`;

    // Check if this locale is already being loaded
    if (this.localeLoadingLocks.has(lockKey)) {
      logger.info(`⏳ Locale ${language} already being loaded, waiting...`, {
        component: 'ConfigCache'
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
        logger.warn(`⚠️  Failed to load builtin locale for ${language}`, {
          component: 'ConfigCache'
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
        logger.info(`🔄 Loading locale: ${language}`, { component: 'ConfigCache' });
      }

      this.setCacheEntry(`locales/${language}.json`, merged);

      // Only log success if this is initial load or content has changed
      if (!wasInCache || hasChanged) {
        const overrideInfo =
          Object.keys(overrides).length > 0
            ? ` with ${Object.keys(overrides).length} overrides`
            : '';

        logger.info(
          `✓ Cached locale: ${language} (${Object.keys(merged).length} keys${overrideInfo})`,
          { component: 'ConfigCache' }
        );
      }

      return merged;
    } catch (error) {
      logger.error(`❌ Error caching locale ${language}:`, {
        component: 'ConfigCache',
        error: error.message,
        stack: error.stack
      });
      return null;
    }
  }

  /**
   * Refresh models cache (both enabled and all models)
   * Should be called when models are modified (create, update, delete, toggle)
   */
  async refreshModelsCache() {
    logger.info('🔄 Refreshing models cache...', { component: 'ConfigCache' });

    try {
      // Refresh enabled models cache
      const models = await loadAllModels(true);
      this.setCacheEntry('config/models.json', models);

      logger.info(`✅ Models cache refreshed: ${models.length} enabled, ${models.length} total`, {
        component: 'ConfigCache'
      });
    } catch (error) {
      logger.error('❌ Error refreshing models cache:', {
        component: 'ConfigCache',
        error: error.message
      });
    }
  }

  /**
   * Refresh apps cache (both enabled and all apps)
   * Should be called when apps are modified (create, update, delete, toggle)
   */
  async refreshAppsCache() {
    logger.info('🔄 Refreshing apps cache...', { component: 'ConfigCache' });

    try {
      // Refresh enabled apps cache
      const apps = await loadAllApps(true);
      this.setCacheEntry('config/apps.json', apps);

      logger.info(`✅ Apps cache refreshed: ${apps.length} enabled, ${apps.length} total`, {
        component: 'ConfigCache'
      });
    } catch (error) {
      logger.error('❌ Error refreshing apps cache:', {
        component: 'ConfigCache',
        error: error.message
      });
    }
  }

  /**
   * Refresh prompts cache (both enabled and all prompts)
   * Should be called when prompts are modified (create, update, delete, toggle)
   */
  async refreshPromptsCache() {
    logger.info('🔄 Refreshing prompts cache...', { component: 'ConfigCache' });

    try {
      // Refresh enabled prompts cache
      const prompts = await loadAllPrompts(true);
      this.setCacheEntry('config/prompts.json', prompts);

      logger.info(
        `✅ Prompts cache refreshed: ${prompts.length} enabled, ${prompts.length} total`,
        { component: 'ConfigCache' }
      );
    } catch (error) {
      logger.error('❌ Error refreshing prompts cache:', {
        component: 'ConfigCache',
        error: error.message
      });
    }
  }

  /**
   * Refresh workflows cache (both enabled and all workflows)
   * Should be called when workflows are modified (create, update, delete, toggle)
   */
  async refreshWorkflowsCache() {
    logger.info('🔄 Refreshing workflows cache...', { component: 'ConfigCache' });

    try {
      // Refresh workflows cache
      const workflows = await loadAllWorkflows(true);
      this.setCacheEntry('config/workflows.json', workflows);

      logger.info(
        `✅ Workflows cache refreshed: ${workflows.length} enabled, ${workflows.length} total`,
        { component: 'ConfigCache' }
      );
    } catch (error) {
      logger.error('❌ Error refreshing workflows cache:', {
        component: 'ConfigCache',
        error: error.message
      });
    }
  }

  /**
   * Refresh sources cache
   * Should be called when sources are modified (create, update, delete, toggle)
   */
  async refreshSourcesCache() {
    logger.info('🔄 Refreshing sources cache...', { component: 'ConfigCache' });

    try {
      await this.refreshCacheEntry('config/sources.json');

      // Validate sources after refresh
      const { data: sources } = this.getSources(true);
      for (const source of sources) {
        const validation = validateSourceConfig(source);
        if (!validation.success) {
          logger.warn(`Invalid source configuration for ${source.id}:`, {
            component: 'ConfigCache',
            errors: validation.errors
          });
        }
      }

      logger.info(`✅ Sources cache refreshed: ${sources.length} sources loaded`, {
        component: 'ConfigCache'
      });
      return true;
    } catch (error) {
      logger.error('❌ Failed to refresh sources cache:', { component: 'ConfigCache', error });
      return false;
    }
  }

  /**
   * Refresh providers cache
   * Should be called when providers are modified (create, update, delete, toggle)
   */
  async refreshProvidersCache() {
    logger.info('🔄 Refreshing providers cache...', { component: 'ConfigCache' });

    try {
      await this.refreshCacheEntry('config/providers.json');
      const { data: providers } = this.getProviders(true);
      logger.info(`✅ Providers cache refreshed: ${providers.length} providers loaded`, {
        component: 'ConfigCache'
      });
      return true;
    } catch (error) {
      logger.error('❌ Failed to refresh providers cache:', { component: 'ConfigCache', error });
      return false;
    }
  }

  /**
   * Refresh skills cache
   * Should be called when skills are modified (upload, delete, toggle, config change)
   */
  async refreshSkillsCache() {
    logger.info('Refreshing skills cache...', { component: 'ConfigCache' });

    try {
      await this.refreshCacheEntry('config/skills.json');
      const { data: skills } = this.getSkills(true);
      logger.info(`Skills cache refreshed: ${skills.length} skills loaded`, {
        component: 'ConfigCache'
      });
      return true;
    } catch (error) {
      logger.error('Failed to refresh skills cache:', { component: 'ConfigCache', error });
      return false;
    }
  }

  /**
   * Invalidate and refresh all cached entries
   */
  async refreshAll() {
    logger.info('🔄 Refreshing all cached configurations...', { component: 'ConfigCache' });

    const refreshPromises = Array.from(this.cache.keys()).map(async configPath => {
      await this.refreshCacheEntry(configPath);
    });

    await Promise.all(refreshPromises);
    logger.info('✅ All configurations refreshed', { component: 'ConfigCache' });
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
    logger.info('🧹 Configuration cache cleared', { component: 'ConfigCache' });
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

    // Append workflow tools that have chatIntegration enabled
    const { data: workflows } = this.getWorkflows();
    const workflowTools = workflows
      .filter(wf => wf.chatIntegration?.enabled)
      .map(wf => ({
        id: `workflow:${wf.id}`,
        name: wf.chatIntegration?.toolDescription || wf.name,
        description: wf.chatIntegration?.toolDescription || wf.description,
        isWorkflowTool: true,
        workflowId: wf.id
      }));

    if (workflowTools.length > 0) {
      tools = [...tools, ...localizeTools(workflowTools, language)];
    }

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
   * Get skills configuration
   * @param {boolean} includeDisabled - Whether to include disabled skills
   * @returns {{ data: Array, etag: string, settings: object }}
   */
  getSkills(includeDisabled = false) {
    const cached = this.get('config/skills.json');
    if (cached === null || !cached.data) {
      return { data: [], etag: null, settings: {} };
    }

    const { skills = [], settings = {} } = cached.data;

    if (includeDisabled) {
      return { data: skills, etag: cached.etag, settings };
    }

    return {
      data: skills.filter(skill => skill.enabled !== false),
      etag: cached.etag,
      settings
    };
  }

  /**
   * Get skills filtered by user permissions
   * @param {object} user - User object with permissions
   * @param {object} platformConfig - Platform configuration
   * @returns {{ data: Array, etag: string }}
   */
  async getSkillsForUser(user, platformConfig) {
    const { data: skills, etag: skillsEtag, settings } = this.getSkills();

    if (!skills || skills.length === 0) {
      return { data: [], etag: null, settings };
    }

    let filteredSkills = [...skills];
    const originalCount = filteredSkills.length;
    let userSpecificEtag = skillsEtag || 'no-etag';

    // Apply filtering based on user permissions
    if (user && user.permissions && user.permissions.skills) {
      const allowedSkills = user.permissions.skills;
      filteredSkills = filterResourcesByPermissions(filteredSkills, allowedSkills, 'skills');
    } else if (isAnonymousAccessAllowed(platformConfig)) {
      // For anonymous users, no default skills
      const allowedSkills = new Set();
      filteredSkills = filterResourcesByPermissions(filteredSkills, allowedSkills, 'skills');
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

    return { data: filteredSkills, etag: userSpecificEtag, settings };
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
