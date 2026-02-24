/**
 * RegistryService
 *
 * Manages marketplace registries: CRUD for registry configurations, fetching and
 * caching remote catalog.json files, and providing item listings with installation status.
 *
 * Registry configs are persisted to config/registries.json with auth secrets encrypted
 * at rest using TokenStorageService (AES-256-GCM). Cached catalogs are stored as JSON
 * in {contentsDir}/.registry-cache/{registryId}.json.
 *
 * Dependency on configCache is resolved lazily via dynamic import to avoid circular
 * module dependencies at startup.
 *
 * @module services/marketplace/RegistryService
 */

import { promises as fs } from 'fs';
import path from 'path';
import { throttledFetch } from '../../requestThrottler.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import { validateCatalog } from '../../validators/catalogSchema.js';
import { validateRegistryConfig } from '../../validators/registryConfigSchema.js';
import tokenStorageService from '../TokenStorageService.js';
import logger from '../../utils/logger.js';
import { getRootDir } from '../../pathUtils.js';
import config from '../../config.js';

const COMPONENT = 'RegistryService';

// ---------------------------------------------------------------------------
// Helpers — auth encryption / decryption / redaction
// ---------------------------------------------------------------------------

/**
 * Encrypt a secret string value if it is not already encrypted.
 * Skips environment-variable placeholders like ${MY_SECRET}.
 *
 * @param {string|undefined} value
 * @returns {string|undefined}
 */
function encryptIfNeeded(value) {
  if (!value || typeof value !== 'string') return value;
  if (/^\$\{[^}]+\}$/.test(value)) return value;
  if (tokenStorageService.isEncrypted(value)) return value;
  return tokenStorageService.encryptString(value);
}

/**
 * Decrypt a value that may carry an ENC[...] envelope.
 * Returns the original value unchanged when decryption fails.
 *
 * @param {string|undefined} value
 * @returns {string|undefined}
 */
function decryptIfNeeded(value) {
  if (!value || typeof value !== 'string') return value;
  if (tokenStorageService.isEncrypted(value)) {
    try {
      return tokenStorageService.decryptString(value);
    } catch {
      return value;
    }
  }
  return value;
}

/**
 * Encrypt any secret fields present in a registry auth object.
 *
 * @param {object|undefined} auth
 * @returns {object|undefined}
 */
function encryptRegistryAuth(auth) {
  if (!auth || auth.type === 'none') return auth;
  const encrypted = { ...auth };
  if (encrypted.token) encrypted.token = encryptIfNeeded(encrypted.token);
  if (encrypted.password) encrypted.password = encryptIfNeeded(encrypted.password);
  if (encrypted.headerValue) encrypted.headerValue = encryptIfNeeded(encrypted.headerValue);
  return encrypted;
}

/**
 * Decrypt all secret fields in a registry auth object.
 *
 * @param {object|undefined} auth
 * @returns {object|undefined}
 */
function decryptRegistryAuth(auth) {
  if (!auth || auth.type === 'none') return auth;
  const decrypted = { ...auth };
  if (decrypted.token) decrypted.token = decryptIfNeeded(decrypted.token);
  if (decrypted.password) decrypted.password = decryptIfNeeded(decrypted.password);
  if (decrypted.headerValue) decrypted.headerValue = decryptIfNeeded(decrypted.headerValue);
  return decrypted;
}

/**
 * Replace all secret auth fields with the literal string "***REDACTED***"
 * before returning a registry config to clients.
 *
 * @param {object|undefined} auth
 * @returns {object|undefined}
 */
function redactAuth(auth) {
  if (!auth || auth.type === 'none') return auth;
  const redacted = { ...auth };
  if (redacted.token) redacted.token = '***REDACTED***';
  if (redacted.password) redacted.password = '***REDACTED***';
  if (redacted.headerValue) redacted.headerValue = '***REDACTED***';
  return redacted;
}

/**
 * Build the HTTP request headers required by the given auth configuration.
 * Auth values are decrypted before being placed in the headers.
 *
 * @param {object|undefined} auth - Registry auth object (may be encrypted)
 * @returns {Record<string, string>} HTTP headers
 */
function buildAuthHeaders(auth) {
  if (!auth || auth.type === 'none') return {};
  const decrypted = decryptRegistryAuth(auth);
  if (decrypted.type === 'bearer') return { Authorization: `Bearer ${decrypted.token}` };
  if (decrypted.type === 'basic') {
    const encoded = Buffer.from(`${decrypted.username}:${decrypted.password}`).toString('base64');
    return { Authorization: `Basic ${encoded}` };
  }
  if (decrypted.type === 'header') return { [decrypted.headerName]: decrypted.headerValue };
  return {};
}

// ---------------------------------------------------------------------------
// Helpers — paths
// ---------------------------------------------------------------------------

/**
 * Return the absolute path to the contents directory.
 *
 * @returns {string}
 */
function getContentsDir() {
  return path.join(getRootDir(), config.CONTENTS_DIR);
}

/**
 * Return the absolute path to the registry catalog cache directory.
 * Directory is created on demand; see ensureCacheDir().
 *
 * @returns {string}
 */
function getCacheDir() {
  return path.join(getContentsDir(), '.registry-cache');
}

/**
 * Return the absolute path for a specific registry's cached catalog JSON.
 *
 * @param {string} registryId
 * @returns {string}
 */
function getCachePath(registryId) {
  return path.join(getCacheDir(), `${registryId}.json`);
}

/**
 * Ensure the registry cache directory exists, creating it if necessary.
 *
 * @returns {Promise<void>}
 */
async function ensureCacheDir() {
  await fs.mkdir(getCacheDir(), { recursive: true });
}

// ---------------------------------------------------------------------------
// Helpers — URL resolution
// ---------------------------------------------------------------------------

/**
 * Derive the full URL of a catalog.json from a registry source URL.
 * If the source URL already ends with "catalog.json" it is used as-is;
 * otherwise "/catalog.json" is appended to the base URL.
 *
 * @param {string} registrySource - Registry source URL from config
 * @returns {string} Full catalog.json URL
 */
function getCatalogUrl(registrySource) {
  if (registrySource.endsWith('catalog.json') || registrySource.endsWith('marketplace.json')) {
    return registrySource;
  }
  return registrySource.replace(/\/$/, '') + '/catalog.json';
}

/**
 * Resolve a catalog item's source descriptor to a fetchable URL.
 *
 * Source types:
 * - url: returned as-is
 * - github: converts to GitHub Contents API URL for in-browser base64 decoding
 * - relative: resolved against the registry base URL (parent of catalog.json)
 *
 * @param {object} itemSource - Catalog item source descriptor
 * @param {string} registrySource - Registry source URL (used to resolve relative paths)
 * @returns {string|null} Fetchable URL, or null if the source type is unrecognised
 */
function resolveItemUrl(itemSource, registrySource) {
  if (itemSource.type === 'url') return itemSource.url;

  if (itemSource.type === 'github') {
    const { owner, repo, path: filePath, ref = 'main' } = itemSource;
    return `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${ref}`;
  }

  if (itemSource.type === 'relative') {
    const baseUrl = registrySource
      .replace(/\/(catalog|marketplace)\.json$/, '')
      .replace(/\/$/, '');
    return `${baseUrl}/${itemSource.path}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers — HTTP fetching
// ---------------------------------------------------------------------------

/**
 * Fetch JSON content from a URL with optional auth headers.
 * Handles GitHub Contents API responses (base64-encoded content).
 *
 * @param {string} url - URL to fetch
 * @param {Record<string, string>} [authHeaders={}] - Additional request headers
 * @returns {Promise<object>} Parsed JSON response body
 * @throws {Error} When the HTTP response is not OK
 */
async function fetchContent(url, authHeaders = {}) {
  const headers = {
    Accept: 'application/json, application/vnd.github.raw+json',
    ...authHeaders
  };

  const response = await throttledFetch('marketplace-registry', url, { headers });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();

  // GitHub Contents API wraps file content in base64
  if (data && data.content && data.encoding === 'base64') {
    const decoded = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
    return JSON.parse(decoded);
  }

  return data;
}

// ---------------------------------------------------------------------------
// Helpers — catalog format normalisation
// ---------------------------------------------------------------------------

/**
 * Detect whether the fetched data follows the Claude Code marketplace.json
 * format (skills array) and normalise it to the standard catalog format
 * (items array). Data already in standard format is returned unchanged.
 *
 * @param {object} data - Raw fetched data
 * @returns {object} Normalised catalog data
 */
function mapClaudeCodeCatalog(data) {
  // Already in standard format
  if (data && data.items) return data;

  // Claude Code marketplace.json format with a top-level `skills` array
  if (data && Array.isArray(data.skills)) {
    return {
      name: data.name,
      description: data.description,
      items: data.skills.map(skill => ({
        type: 'skill',
        name: skill.id || skill.name,
        displayName: typeof skill.name === 'string' ? { en: skill.name } : skill.name,
        description:
          typeof skill.description === 'string' ? { en: skill.description } : skill.description,
        version: skill.version,
        author: skill.author,
        tags: skill.tags || [],
        source: skill.source || { type: 'relative', path: skill.id }
      }))
    };
  }

  // Claude Code plugins format with a top-level `plugins` array (e.g. Anthropic knowledge-work-plugins)
  if (data && Array.isArray(data.plugins)) {
    return {
      name: data.name,
      description: data.description,
      items: data.plugins.map(plugin => ({
        type: 'skill',
        name: plugin.name,
        displayName: { en: plugin.name },
        description:
          typeof plugin.description === 'string' ? { en: plugin.description } : plugin.description,
        author: plugin.author?.name || data.owner?.name,
        tags: plugin.tags || [],
        source: plugin.source
          ? { type: 'relative', path: plugin.source.replace(/^\.\//, '') }
          : { type: 'relative', path: plugin.name }
      }))
    };
  }

  return data;
}

// ---------------------------------------------------------------------------
// RegistryService class
// ---------------------------------------------------------------------------

class RegistryService {
  constructor() {
    /** @type {import('../../configCache.js').default|null} */
    this._configCache = null;
  }

  /**
   * Lazily import and return the singleton ConfigCache instance.
   * Dynamic import breaks the circular dependency between configCache and this service.
   *
   * @returns {Promise<import('../../configCache.js').default>}
   */
  async _getConfigCache() {
    if (!this._configCache) {
      const mod = await import('../../configCache.js');
      this._configCache = mod.default;
    }
    return this._configCache;
  }

  /**
   * Read the current registries config data from the cache.
   *
   * @returns {Promise<{ registries: Array }>}
   */
  async _getRegistriesData() {
    const cc = await this._getConfigCache();
    const { data } = cc.getRegistries();
    return data || { registries: [] };
  }

  /**
   * Persist registries config to disk and refresh the cache.
   *
   * @param {{ registries: Array }} registriesData - Full registries config object
   * @returns {Promise<void>}
   */
  async _saveRegistries(registriesData) {
    const filePath = path.join(getContentsDir(), 'config', 'registries.json');
    await atomicWriteJSON(filePath, registriesData);
    const cc = await this._getConfigCache();
    await cc.refreshRegistriesCache();
  }

  // --------------------------------------------------------------------------
  // Catalog operations
  // --------------------------------------------------------------------------

  /**
   * Fetch and validate the catalog.json from a registry.
   * Applies format normalisation for known alternative catalog formats.
   *
   * @param {object} registry - Registry config object (auth may be encrypted)
   * @returns {Promise<object>} Parsed and validated catalog data
   */
  async fetchCatalog(registry) {
    const catalogUrl = getCatalogUrl(registry.source);
    const authHeaders = buildAuthHeaders(registry.auth);

    logger.info(`Fetching catalog from ${catalogUrl}`, { component: COMPONENT });

    const rawData = await fetchContent(catalogUrl, authHeaders);
    const mapped = mapClaudeCodeCatalog(rawData);
    const validation = validateCatalog(mapped);

    if (!validation.success) {
      logger.warn(`Catalog validation warnings: ${validation.errors.join(', ')}`, {
        component: COMPONENT
      });
      // Return the mapped data even if validation finds issues — be lenient with remote content
      return mapped;
    }

    return validation.data;
  }

  /**
   * Refresh a registry's catalog cache by re-fetching from the remote source.
   * Updates lastSynced and itemCount on the registry entry in config.
   *
   * @param {string} registryId - Registry ID
   * @returns {Promise<object>} The refreshed catalog data
   * @throws {Error} When the registry is not found or is disabled
   */
  async refreshRegistry(registryId) {
    const { registries } = await this._getRegistriesData();
    const registry = registries.find(r => r.id === registryId);

    if (!registry) throw new Error(`Registry '${registryId}' not found`);
    if (!registry.enabled) throw new Error(`Registry '${registryId}' is disabled`);

    const catalog = await this.fetchCatalog(registry);

    await ensureCacheDir();
    await atomicWriteJSON(getCachePath(registryId), {
      registryId,
      fetchedAt: new Date().toISOString(),
      catalog
    });

    // Update lastSynced and itemCount in registries.json
    const data = await this._getRegistriesData();
    const idx = data.registries.findIndex(r => r.id === registryId);
    if (idx !== -1) {
      data.registries[idx].lastSynced = new Date().toISOString();
      data.registries[idx].itemCount = (catalog.items || []).length;
      await this._saveRegistries(data);
    }

    logger.info(`Registry '${registryId}' refreshed: ${(catalog.items || []).length} items`, {
      component: COMPONENT
    });
    return catalog;
  }

  /**
   * Test connectivity to a registry by fetching and parsing its catalog.
   * Safe to call with an unsaved registry config (e.g. during creation flow).
   *
   * @param {object} registryConfig - Registry config to test (auth may contain plaintext)
   * @returns {Promise<{ success: boolean, itemCount: number, message: string }>}
   */
  async testRegistry(registryConfig) {
    try {
      const catalogUrl = getCatalogUrl(registryConfig.source);
      const authHeaders = buildAuthHeaders(registryConfig.auth);
      const rawData = await fetchContent(catalogUrl, authHeaders);
      const mapped = mapClaudeCodeCatalog(rawData);
      const itemCount = (mapped?.items || []).length;
      return {
        success: true,
        itemCount,
        message: `Connected successfully. Found ${itemCount} items.`
      };
    } catch (error) {
      return { success: false, itemCount: 0, message: error.message };
    }
  }

  /**
   * Read a registry's cached catalog from disk.
   *
   * @param {string} registryId
   * @returns {Promise<{ registryId: string, fetchedAt: string, catalog: object }|null>}
   *   The cached entry, or null if the cache file does not exist or is unreadable
   */
  async getCachedCatalogAsync(registryId) {
    try {
      const cachePath = getCachePath(registryId);
      const content = await fs.readFile(cachePath, 'utf8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Get all catalog items across all enabled registries, merged with installation status.
   * Supports filtering by type, search text, category, registry, and status.
   * Supports pagination via page/limit query parameters.
   *
   * @param {object} [filters={}] - Optional filter/pagination parameters
   * @param {string} [filters.type] - Filter by content type ('app'|'model'|'prompt'|'skill'|'workflow'|'all')
   * @param {string} [filters.search] - Case-insensitive substring search against name and description
   * @param {string} [filters.category] - Filter by category string
   * @param {string} [filters.registry] - Filter by registry ID
   * @param {string} [filters.status] - Filter by installation status ('installed'|'available'|'all')
   * @param {number|string} [filters.page=1] - Page number (1-based)
   * @param {number|string} [filters.limit=24] - Items per page
   * @returns {Promise<{ items: Array, total: number, page: number, limit: number, totalPages: number }>}
   */
  async getAllItems(filters = {}) {
    const cc = await this._getConfigCache();
    const { data: registriesData } = cc.getRegistries();
    const { data: installationsData } = cc.getInstallations();
    const registries = registriesData?.registries || [];
    const installations = installationsData?.installations || {};

    const allItems = [];

    for (const registry of registries) {
      if (!registry.enabled) continue;

      const cached = await this.getCachedCatalogAsync(registry.id);
      if (!cached) continue;

      const items = cached.catalog?.items || [];
      for (const item of items) {
        const key = `${item.type}:${item.name}`;
        const installation = installations[key];

        allItems.push({
          ...item,
          registryId: registry.id,
          registryName: registry.name,
          installationStatus: installation ? 'installed' : 'available',
          installation: installation || null
        });
      }
    }

    // Apply filters
    let filtered = allItems;
    if (filters.type && filters.type !== 'all') {
      filtered = filtered.filter(i => i.type === filters.type);
    }
    if (filters.search) {
      const search = filters.search.toLowerCase();
      filtered = filtered.filter(i => {
        const name = (i.displayName?.en || i.name || '').toLowerCase();
        const desc = (i.description?.en || '').toLowerCase();
        return name.includes(search) || desc.includes(search);
      });
    }
    if (filters.category) {
      filtered = filtered.filter(i => i.category === filters.category);
    }
    if (filters.registry) {
      filtered = filtered.filter(i => i.registryId === filters.registry);
    }
    if (filters.status && filters.status !== 'all') {
      filtered = filtered.filter(i => i.installationStatus === filters.status);
    }

    // Pagination
    const page = parseInt(filters.page) || 1;
    const limit = parseInt(filters.limit) || 24;
    const total = filtered.length;
    const start = (page - 1) * limit;
    const items = filtered.slice(start, start + limit);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    };
  }

  /**
   * Get full details for a single catalog item including a content preview
   * fetched from the item's source URL.
   *
   * @param {string} registryId - Registry the item belongs to
   * @param {string} type - Content type ('app'|'model'|'prompt'|'skill'|'workflow')
   * @param {string} name - Item name (machine-readable identifier)
   * @returns {Promise<object>} Item detail including installationStatus, installation, and contentPreview
   * @throws {Error} When the registry or item is not found in cache
   */
  async getItemDetail(registryId, type, name) {
    const cc = await this._getConfigCache();
    const { data: installationsData } = cc.getInstallations();
    const installations = installationsData?.installations || {};

    const cached = await this.getCachedCatalogAsync(registryId);
    if (!cached) throw new Error(`No cached catalog for registry '${registryId}'`);

    const item = (cached.catalog?.items || []).find(i => i.type === type && i.name === name);
    if (!item) throw new Error(`Item '${type}:${name}' not found in registry '${registryId}'`);

    const key = `${type}:${name}`;
    const installation = installations[key];

    // Look up the registry config so we can fetch a content preview
    const { data: registriesData } = cc.getRegistries();
    const registry = (registriesData?.registries || []).find(r => r.id === registryId);

    let contentPreview = null;
    if (registry) {
      try {
        const itemUrl = resolveItemUrl(item.source, registry.source);
        if (itemUrl) {
          const authHeaders = buildAuthHeaders(registry.auth);
          contentPreview = await fetchContent(itemUrl, authHeaders);
        }
      } catch (error) {
        logger.warn(`Could not fetch content preview: ${error.message}`, {
          component: COMPONENT
        });
      }
    }

    return {
      ...item,
      registryId,
      registryName: registry?.name,
      installationStatus: installation ? 'installed' : 'available',
      installation: installation || null,
      contentPreview
    };
  }

  // --------------------------------------------------------------------------
  // Registry CRUD
  // --------------------------------------------------------------------------

  /**
   * Create and persist a new registry configuration.
   * Validates the config, checks for duplicate IDs, encrypts auth secrets,
   * and attempts an initial catalog refresh.
   *
   * @param {object} registryData - Raw registry config from the API request body
   * @returns {Promise<object>} The saved registry with auth redacted
   * @throws {Error} On validation failure or duplicate ID
   */
  async createRegistry(registryData) {
    const validation = validateRegistryConfig(registryData);
    if (!validation.success) {
      throw new Error(`Invalid registry config: ${validation.errors.join(', ')}`);
    }

    const data = await this._getRegistriesData();

    if (data.registries.find(r => r.id === registryData.id)) {
      throw new Error(`Registry with id '${registryData.id}' already exists`);
    }

    const registry = {
      ...validation.data,
      auth: encryptRegistryAuth(validation.data.auth),
      createdAt: new Date().toISOString(),
      lastSynced: null,
      itemCount: 0
    };

    data.registries.push(registry);
    await this._saveRegistries(data);

    return { ...registry, auth: redactAuth(registry.auth) };
  }

  /**
   * Update an existing registry configuration.
   * Restores REDACTED placeholder values from the existing encrypted config
   * to avoid losing secrets the client did not re-submit.
   *
   * @param {string} id - Registry ID to update
   * @param {object} updates - Fields to update (partial)
   * @returns {Promise<object>} The updated registry with auth redacted
   * @throws {Error} When the registry is not found
   */
  async updateRegistry(id, updates) {
    const data = await this._getRegistriesData();
    const idx = data.registries.findIndex(r => r.id === id);
    if (idx === -1) throw new Error(`Registry '${id}' not found`);

    const existing = data.registries[idx];

    // When the client sends back REDACTED placeholders, restore the existing encrypted values
    const auth = updates.auth || existing.auth;
    if (auth && auth.type !== 'none') {
      if (auth.token === '***REDACTED***') auth.token = existing.auth?.token;
      if (auth.password === '***REDACTED***') auth.password = existing.auth?.password;
      if (auth.headerValue === '***REDACTED***') auth.headerValue = existing.auth?.headerValue;
    }

    const updated = {
      ...existing,
      ...updates,
      id, // ID is immutable
      auth: encryptRegistryAuth(auth),
      updatedAt: new Date().toISOString()
    };

    data.registries[idx] = updated;
    await this._saveRegistries(data);

    return { ...updated, auth: redactAuth(updated.auth) };
  }

  /**
   * Delete a registry and remove its cached catalog.
   *
   * @param {string} id - Registry ID to delete
   * @returns {Promise<void>}
   * @throws {Error} When the registry is not found
   */
  async deleteRegistry(id) {
    const data = await this._getRegistriesData();
    const idx = data.registries.findIndex(r => r.id === id);
    if (idx === -1) throw new Error(`Registry '${id}' not found`);

    data.registries.splice(idx, 1);
    await this._saveRegistries(data);

    // Best-effort cache cleanup — ignore missing file errors
    try {
      await fs.unlink(getCachePath(id));
    } catch {
      // Cache file may not exist yet; nothing to clean up
    }
  }

  /**
   * Return all registries with auth secrets redacted for safe client delivery.
   *
   * @returns {Promise<Array>} List of registry objects with auth redacted
   */
  async listRegistries() {
    const { registries } = await this._getRegistriesData();
    return registries.map(r => ({ ...r, auth: redactAuth(r.auth) }));
  }

  /**
   * Resolve a catalog item's source to a fetchable URL.
   * Delegates to the module-level helper for use by ContentInstaller.
   *
   * @param {object} item - Catalog item object
   * @param {object} registry - Registry config with source URL
   * @returns {string|null} Fetchable URL or null
   */
  resolveItemUrl(item, registry) {
    return resolveItemUrl(item.source, registry.source);
  }

  /**
   * Retrieve a registry config with decrypted auth credentials.
   * For internal use by ContentInstaller when making authenticated fetch calls.
   *
   * @param {string} id - Registry ID
   * @returns {Promise<object>} Registry config with plaintext auth credentials
   * @throws {Error} When the registry is not found
   */
  async getRegistryWithAuth(id) {
    const { registries } = await this._getRegistriesData();
    const registry = registries.find(r => r.id === id);
    if (!registry) throw new Error(`Registry '${id}' not found`);
    return { ...registry, auth: decryptRegistryAuth(registry.auth) };
  }
}

export default new RegistryService();
