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
import matter from 'gray-matter';
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
 * Convert a github.com/blob/ URL to a raw.githubusercontent.com URL so that
 * fetch calls receive the raw file content instead of an HTML page.
 * Other URLs are returned unchanged.
 *
 * @param {string} url
 * @returns {string}
 */
function toRawGitHubUrl(url) {
  const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
  if (!match) return url;
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}/${match[4]}`;
}

/**
 * Derive the full URL of a catalog.json from a registry source URL.
 * Normalises github.com/blob/ URLs to raw.githubusercontent.com first.
 * If the source URL already ends with "catalog.json" or "marketplace.json"
 * it is used as-is; otherwise "/catalog.json" is appended to the base URL.
 *
 * @param {string} registrySource - Registry source URL from config
 * @returns {string} Full catalog.json URL
 */
function getCatalogUrl(registrySource) {
  const normalized = toRawGitHubUrl(registrySource);
  if (normalized.endsWith('catalog.json') || normalized.endsWith('marketplace.json')) {
    return normalized;
  }
  return normalized.replace(/\/$/, '') + '/catalog.json';
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
    const baseUrl = registrySource.replace(/\/(catalog|marketplace)\.json$/, '').replace(/\/$/, '');
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
    Accept: 'application/json, text/plain, application/vnd.github.raw+json',
    ...authHeaders
  };

  const response = await throttledFetch('marketplace-registry', url, { headers });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const text = await response.text();

  // Try JSON first, fall back to raw text (e.g. SKILL.md files)
  try {
    const data = JSON.parse(text);

    // GitHub Contents API wraps file content in base64
    if (data && data.content && data.encoding === 'base64') {
      const decoded = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
      try {
        return JSON.parse(decoded);
      } catch {
        return decoded;
      }
    }

    return data;
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Helpers — GitHub API utilities
// ---------------------------------------------------------------------------

/**
 * Parse a GitHub URL to extract owner, repo, and ref.
 *
 * Supports:
 * - https://raw.githubusercontent.com/{owner}/{repo}/refs/heads/{ref}/{path}
 * - https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
 * - https://github.com/{owner}/{repo}/blob/{ref}/{path}
 *
 * @param {string} url
 * @returns {{ owner: string, repo: string, ref: string }|null}
 */
function parseGitHubUrl(url) {
  // raw.githubusercontent.com format
  let match = url.match(
    /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/(?:refs\/heads\/)?([^/]+)\//
  );
  if (match) return { owner: match[1], repo: match[2], ref: match[3] };
  // github.com/blob/ format
  match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\//);
  if (match) return { owner: match[1], repo: match[2], ref: match[3] };
  return null;
}

/**
 * Fetch the recursive file tree for a GitHub repository via the Trees API.
 *
 * @param {string} owner - GitHub repository owner
 * @param {string} repo - GitHub repository name
 * @param {string} ref - Branch, tag, or commit SHA
 * @param {Record<string, string>} [authHeaders={}] - Optional auth headers
 * @returns {Promise<Array<{ path: string, type: string }>>} Tree entries
 * @throws {Error} When the API call fails
 */
async function fetchGitHubTree(owner, repo, ref, authHeaders = {}) {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`;
  const response = await throttledFetch('marketplace-registry', url, {
    headers: { Accept: 'application/json', ...authHeaders }
  });
  if (!response.ok) throw new Error(`GitHub tree API: HTTP ${response.status}`);
  const data = await response.json();
  return data.tree || [];
}

/**
 * Collect companion files (non-SKILL.md blobs) within a skill directory prefix.
 *
 * @param {Array<{ path: string, type: string }>} tree - GitHub tree entries
 * @param {string} dirPrefix - Directory prefix to scan (e.g. "skills/ab-test-setup/")
 * @returns {string[]} Relative paths of companion files (e.g. ["references/phase-1.md"])
 */
function findCompanionFiles(tree, dirPrefix) {
  const companions = [];
  for (const entry of tree) {
    if (entry.type !== 'blob') continue;
    if (!entry.path.startsWith(dirPrefix)) continue;
    const relative = entry.path.slice(dirPrefix.length);
    if (relative === 'SKILL.md') continue;
    companions.push(relative);
  }
  return companions;
}

/**
 * Resolve a plugins-format catalog to individual skill items.
 *
 * Two-phase approach:
 * - Phase 1: Plugins with an explicit `skills` array get SKILL.md URLs constructed
 *   directly from the listed paths.
 * - Phase 2: Plugins without a `skills` array fall back to the GitHub Trees API
 *   scan for SKILL.md files matching {pluginDir}/skills/{name}/SKILL.md.
 *
 * The GitHub tree is always fetched for GitHub registries so that companion files
 * (references/, scripts/, templates/, etc.) can be discovered and annotated on
 * each skill's source descriptor. ContentInstaller uses this to copy companion
 * files alongside SKILL.md during installation.
 *
 * Falls back to one-item-per-plugin for non-GitHub registries.
 *
 * @param {string} registrySource - Registry source URL (marketplace.json URL)
 * @param {Array} plugins - Plugin entries from marketplace.json
 * @param {object|undefined} owner - Top-level owner object from marketplace.json (for author fallback)
 * @param {Record<string, string>} [authHeaders={}] - Optional auth headers
 * @returns {Promise<Array>} Catalog items — one per individual skill
 */
async function resolvePluginSkills(registrySource, plugins, owner, authHeaders = {}) {
  const ghInfo = parseGitHubUrl(registrySource);

  if (!ghInfo) {
    // Non-GitHub registry: fall back to one item per plugin (current behavior)
    return plugins.map(plugin => ({
      type: 'skill',
      name: plugin.name,
      displayName: { en: plugin.name },
      description:
        typeof plugin.description === 'string' ? { en: plugin.description } : plugin.description,
      author: plugin.author?.name,
      tags: plugin.tags || [],
      source: plugin.source
        ? { type: 'relative', path: plugin.source.replace(/^\.\//, '') }
        : { type: 'relative', path: plugin.name }
    }));
  }

  // Base URL for constructing raw SKILL.md URLs (strip the marketplace.json filename)
  const rawBase = toRawGitHubUrl(registrySource)
    .replace(/\/.claude-plugin\/marketplace\.json$/, '')
    .replace(/\/marketplace\.json$/, '')
    .replace(/\/$/, '');

  // Fetch the full tree once for companion file discovery and Phase 2 scanning
  const tree = await fetchGitHubTree(ghInfo.owner, ghInfo.repo, ghInfo.ref, authHeaders);

  const items = [];
  let needsTreeScan = false;

  // Phase 1: plugins with explicit skills arrays → direct URL construction
  for (const plugin of plugins) {
    if (Array.isArray(plugin.skills) && plugin.skills.length > 0) {
      for (const skillPath of plugin.skills) {
        const cleanPath = skillPath.replace(/^\.\//, '');
        const skillDir = cleanPath.split('/').pop();
        const skillUrl = `${rawBase}/${cleanPath}/SKILL.md`;
        const companions = findCompanionFiles(tree, `${cleanPath}/`);

        // Humanize directory names: "ab-test-setup" → "Ab Test Setup"
        const displaySkillName = skillDir.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const displayPluginName = (plugin.name || '')
          .replace(/-/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase());

        items.push({
          type: 'skill',
          name: `${plugin.name}-${skillDir}`,
          displayName: { en: displaySkillName },
          description:
            typeof plugin.description === 'string'
              ? { en: plugin.description }
              : plugin.description,
          author: plugin.author?.name || owner?.name,
          category: displayPluginName,
          tags: [plugin.name],
          source: { type: 'url', url: skillUrl, companions, rawBase }
        });
      }
    } else {
      needsTreeScan = true;
    }
  }

  // Phase 2: tree scan for plugins without explicit skills (Anthropic-style)
  if (needsTreeScan) {
    const treePaths = new Set(tree.filter(e => e.type === 'blob').map(e => e.path));

    // Build maps — separate direct-skill plugins from Anthropic-style nested plugins
    const pluginDirs = new Map();
    for (const plugin of plugins) {
      if (Array.isArray(plugin.skills) && plugin.skills.length > 0) continue;
      const dir = (plugin.source || `./${plugin.name}`).replace(/^\.\//, '');
      if (!dir) continue;

      // Phase 2a: plugin source directly contains SKILL.md → single skill
      if (treePaths.has(`${dir}/SKILL.md`)) {
        const skillDir = dir.split('/').pop();
        const skillUrl = `${rawBase}/${dir}/SKILL.md`;
        const companions = findCompanionFiles(tree, `${dir}/`);
        const displaySkillName = skillDir.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const displayPluginName = (plugin.category || plugin.name || '')
          .replace(/-/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase());

        items.push({
          type: 'skill',
          name: plugin.name,
          displayName: { en: displaySkillName },
          description:
            typeof plugin.description === 'string'
              ? { en: plugin.description }
              : plugin.description,
          author: plugin.author?.name || owner?.name,
          category: displayPluginName,
          tags: [plugin.category || plugin.name],
          source: { type: 'url', url: skillUrl, companions, rawBase }
        });
      } else {
        // Phase 2b: Anthropic-style — scan for nested skills below
        pluginDirs.set(dir, plugin);
      }
    }

    // Find all SKILL.md files matching {pluginDir}/skills/{skillName}/SKILL.md
    const skillRegex = /^([^/]+)\/skills\/([^/]+)\/SKILL\.md$/;

    for (const entry of tree) {
      if (entry.type !== 'blob') continue;
      const match = entry.path.match(skillRegex);
      if (!match) continue;

      const [, pluginDir, skillDir] = match;
      const plugin = pluginDirs.get(pluginDir);
      if (!plugin) continue;

      const dirPrefix = `${pluginDir}/skills/${skillDir}/`;
      const skillUrl = `${rawBase}/${pluginDir}/skills/${skillDir}/SKILL.md`;
      const companions = findCompanionFiles(tree, dirPrefix);

      // Humanize directory names: "canned-responses" → "Canned Responses"
      const displaySkillName = skillDir.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const displayPluginName = pluginDir.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

      items.push({
        type: 'skill',
        name: `${pluginDir}-${skillDir}`,
        displayName: { en: displaySkillName },
        description:
          typeof plugin.description === 'string' ? { en: plugin.description } : plugin.description,
        author: plugin.author?.name,
        category: displayPluginName,
        tags: [pluginDir],
        source: { type: 'url', url: skillUrl, companions, rawBase }
      });
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Helpers — markdown link rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrite relative markdown links in a document to point to the GitHub source.
 * Leaves absolute URLs, anchor links, and mailto: links untouched.
 *
 * @param {string} markdown - Markdown content to process
 * @param {string|undefined} sourceUrl - Raw GitHub SKILL.md URL used to derive the GitHub blob base
 * @returns {string} Markdown with relative links rewritten to GitHub blob URLs
 */
function rewriteRelativeLinks(markdown, sourceUrl) {
  if (!sourceUrl || !markdown) return markdown;
  const match = sourceUrl.match(
    /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/(?:refs\/heads\/)?([^/]+)\/(.+)\/SKILL\.md$/
  );
  if (!match) return markdown;
  const [, owner, repo, ref, dirPath] = match;
  const githubBase = `https://github.com/${owner}/${repo}/blob/${ref}/${dirPath}`;

  // Replace [text](relative/path) but not absolute URLs, anchors, or mailto:
  return markdown.replace(
    /\[([^\]]*)\]\((?!https?:\/\/|#|mailto:)([^)]+)\)/g,
    (_, text, href) => `[${text}](${githubBase}/${href})`
  );
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

    // Plugins format: resolve each plugin to its individual skills via GitHub tree API
    if (rawData && Array.isArray(rawData.plugins)) {
      const items = await resolvePluginSkills(
        registry.source,
        rawData.plugins,
        rawData.owner,
        authHeaders
      );
      const catalog = {
        name: rawData.name,
        description: rawData.description,
        items
      };
      const validation = validateCatalog(catalog);
      return validation.success ? validation.data : catalog;
    }

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
      const catalog = await this.fetchCatalog(registryConfig);
      const itemCount = (catalog?.items || []).length;
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

    // Build a set of skill names already present on disk (from defaults or manual copy)
    const { data: diskSkills } = cc.getSkills();
    const diskSkillNames = new Set((diskSkills || []).map(s => s.name));

    const allItems = [];

    for (const registry of registries) {
      if (!registry.enabled) continue;

      const cached = await this.getCachedCatalogAsync(registry.id);
      if (!cached) continue;

      const items = cached.catalog?.items || [];
      for (const item of items) {
        const key = `${item.type}:${item.name}`;
        const installation = installations[key];
        const onDisk = item.type === 'skill' && diskSkillNames.has(item.name);

        allItems.push({
          ...item,
          registryId: registry.id,
          registryName: registry.name,
          installationStatus: installation || onDisk ? 'installed' : 'available',
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

    // Check if skill is present on disk even if not tracked in installations.json
    const { data: diskSkills } = cc.getSkills();
    const diskSkillNames = new Set((diskSkills || []).map(s => s.name));

    const cached = await this.getCachedCatalogAsync(registryId);
    if (!cached) throw new Error(`No cached catalog for registry '${registryId}'`);

    const item = (cached.catalog?.items || []).find(i => i.type === type && i.name === name);
    if (!item) throw new Error(`Item '${type}:${name}' not found in registry '${registryId}'`);

    const key = `${type}:${name}`;
    const installation = installations[key];
    const onDisk = type === 'skill' && diskSkillNames.has(name);

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

    // Parse YAML frontmatter from SKILL.md content previews so the client
    // can render it as a metadata table rather than raw --- delimiters
    if (typeof contentPreview === 'string') {
      try {
        const parsed = matter(contentPreview);
        if (parsed.data && Object.keys(parsed.data).length > 0) {
          contentPreview = { body: parsed.content.trim(), frontmatter: parsed.data };
        }
      } catch {
        // Keep as plain string if parsing fails
      }
    }

    // Rewrite relative markdown links to point to the GitHub source
    if (typeof contentPreview === 'object' && contentPreview?.body !== undefined) {
      contentPreview = {
        ...contentPreview,
        body: rewriteRelativeLinks(contentPreview.body, item.source?.url)
      };
    } else if (typeof contentPreview === 'string') {
      contentPreview = rewriteRelativeLinks(contentPreview, item.source?.url);
    }

    return {
      ...item,
      registryId,
      registryName: registry?.name,
      installationStatus: installation || onDisk ? 'installed' : 'available',
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
   * Rewrite relative markdown links to GitHub blob view URLs.
   * Public wrapper around the module-level rewriteRelativeLinks helper,
   * for use by routes that serve installed-skill content.
   *
   * @param {string} markdown - Markdown content to process
   * @param {string|undefined} sourceUrl - Raw GitHub SKILL.md URL
   * @returns {string} Markdown with relative links rewritten
   */
  rewriteSkillLinks(markdown, sourceUrl) {
    return rewriteRelativeLinks(markdown, sourceUrl);
  }

  /**
   * Discover companion files for a skill at install time by fetching the GitHub tree.
   * Used as a fallback when the cached catalog item has no companions array (stale cache).
   *
   * @param {string} skillMdUrl - Raw GitHub URL of the SKILL.md file
   * @param {Record<string, string>} [authHeaders={}] - Optional auth headers
   * @returns {Promise<string[]>} Relative paths of companion files, or [] on failure
   */
  async discoverCompanions(skillMdUrl, authHeaders = {}) {
    const ghInfo = parseGitHubUrl(skillMdUrl);
    if (!ghInfo) return [];

    // Strip the raw.githubusercontent.com base URL prefix and the ref segment to get the dir path
    const urlPrefix = `https://raw.githubusercontent.com/${ghInfo.owner}/${ghInfo.repo}/`;
    let dirPath = skillMdUrl.replace(urlPrefix, '');
    // Remove the ref segment (refs/heads/main/... or main/...)
    dirPath = dirPath.replace(/^(?:refs\/heads\/)?[^/]+\//, '');
    // Remove the trailing /SKILL.md
    dirPath = dirPath.replace(/\/SKILL\.md$/, '');
    if (!dirPath) return [];

    const tree = await fetchGitHubTree(ghInfo.owner, ghInfo.repo, ghInfo.ref, authHeaders);
    return findCompanionFiles(tree, `${dirPath}/`);
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
