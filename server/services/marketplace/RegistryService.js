// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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

import { ServiceError } from '../../utils/ServiceError.js';
import { limitFrom, pageOfList } from '../../utils/pagination.js';
import configStore from '../../services/config/ConfigStore.js';
import { catalogItemVersionSchema, validateCatalog } from '../../validators/catalogSchema.js';
import {
  validateRegistryConfig,
  validateRegistryVersionPolicy
} from '../../validators/registryConfigSchema.js';
import tokenStorageService from '../TokenStorageService.js';
import logger from '../../utils/logger.js';
import { parseFrontMatter } from '../../utils/frontMatter.js';
import { buildPluginSkillItems } from './claudePluginCatalog.js';
import { getLocalContentIds, installationStatusFor } from './localContent.js';
import { marketplaceFetch, sharesCredentialScope } from './marketplaceFetch.js';
import { offeredVersion, versionPolicyFields } from './versionPolicy.js';
import {
  checkCompatibility,
  describeIncompatibility
} from '../integrations/definitions/compatibility.js';
import {
  definitionFacts,
  registryProtocolRefusal
} from '../integrations/definitions/registryItems.js';

const COMPONENT = 'RegistryService';

/** How many integration definitions a catalog load fetches at the same time. */
const DEFINITION_FETCH_CONCURRENCY = 4;

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

/** The registry list, relative to `contents/`. */
const REGISTRIES_FILE = 'config/registries.json';

/**
 * Return the path of a registry's cached catalog, relative to `contents/`.
 *
 * The cache is a fetched artefact rather than configuration, so it keeps its
 * own dotted directory: nothing that scans a configuration directory can pick
 * a catalog up as an app, a model or a prompt. The directory is created by the
 * first write.
 *
 * @param {string} registryId
 * @returns {string}
 */
function getCacheRelPath(registryId) {
  return `.registry-cache/${registryId}.json`;
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
 * Validate and normalize a registry source URL before it is used for outbound HTTP calls.
 * Requires HTTPS. Which hosts the server then fetches from is decided per request
 * (and per redirect hop) by `marketplaceFetch.js`.
 *
 * @param {string} source
 * @returns {string} sanitized URL string
 * @throws {Error} if the URL is invalid or uses a disallowed host
 */
function sanitizeRegistrySourceUrl(source) {
  if (typeof source !== 'string' || !source.trim()) {
    throw new Error('Registry source URL must be a non-empty string');
  }

  let urlObj;
  try {
    urlObj = new URL(source);
  } catch {
    throw new Error('Registry source URL is not a valid URL');
  }

  // Only allow HTTPS to avoid downgrades; extend if HTTP is required in your environment.
  if (urlObj.protocol !== 'https:') {
    throw new Error('Registry source URL must use HTTPS');
  }

  return urlObj.toString();
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

/**
 * Where the descriptor of one listed version of an item lives: its `ref`
 * (an absolute URL, or a path relative to the catalog), or the catalog URL
 * with `type`, `name` and `version` as query parameters.
 *
 * @param {{ type: string, name: string }} item
 * @param {{ version: string, ref?: string }} listed - the `versions[]` entry
 * @param {{ source: string }} registry
 * @returns {string}
 */
export function versionDescriptorUrl(item, listed, registry) {
  if (typeof listed.ref === 'string' && /^https:\/\//i.test(listed.ref)) return listed.ref;
  if (typeof listed.ref === 'string' && listed.ref) {
    return resolveItemUrl(
      { type: 'relative', path: listed.ref.replace(/^\.?\//, '') },
      registry.source
    );
  }
  const url = new URL(getCatalogUrl(registry.source));
  url.searchParams.set('type', item.type);
  url.searchParams.set('name', item.name);
  url.searchParams.set('version', listed.version);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Helpers — HTTP fetching
// ---------------------------------------------------------------------------

/**
 * Fetch JSON content from a URL with optional auth headers.
 * Handles GitHub Contents API responses (base64-encoded content).
 * The URL must be one the registry may send the server to
 * (see `marketplaceFetch.js`).
 *
 * @param {string} url - URL to fetch
 * @param {Record<string, string>} [authHeaders] - The registry's credentials
 * @param {object} registry - Registry config (`source` names its own host)
 * @returns {Promise<object>} Parsed JSON response body
 * @throws {Error} When the target is refused or the HTTP response is not OK
 */
async function fetchContent(url, authHeaders, registry) {
  const response = await marketplaceFetch('marketplace-registry', url, {
    registry,
    headers: { Accept: 'application/json, text/plain, application/vnd.github.raw+json' },
    authHeaders
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const text = await response.text();

  // Try JSON first, fall back to raw text (e.g. SKILL.md files)
  try {
    const data = JSON.parse(text);

    // GitHub Contents API wraps file content in base64
    if (data && data.content && data.encoding === 'base64') {
      const decoded = Buffer.from(data.content.replaceAll('\n', ''), 'base64').toString('utf8');
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
// Helpers — integration items of a catalog
// ---------------------------------------------------------------------------

/**
 * Run `fn` over `items` with at most `limit` calls in flight, keeping the order.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Screen one catalog item when the catalog is loaded. An integration item's
 * definition (`integration.json`) is fetched from the registry:
 *
 * - a definition the registry may not deliver (an MCP server without a
 *   fixed remote transport, i.e. a local `stdio` process) is rejected — the
 *   item is left out of the catalog and the reason is logged with the
 *   registry and the item;
 * - any other gets `facts` (`definitionFacts`): sign-in modes, effect,
 *   where it runs, action count and the actions, which the browse grid and
 *   the detail show without installing anything;
 * - a definition that cannot be fetched or is not JSON keeps the item with
 *   `facts: null` (the install validates the files again and refuses a
 *   stdio definition there).
 *
 * `facts` is derived here only; a `facts` field a registry writes into its
 * catalog is dropped.
 *
 * @param {object} item - Catalog item
 * @param {object} registry - Registry config (`id`, `name`, `source`)
 * @param {Record<string, string>} authHeaders - The registry's credentials
 * @returns {Promise<object|null>} The item to keep, or null when it is rejected
 */
async function screenCatalogItem(item, registry, authHeaders) {
  if (!item || typeof item !== 'object') return item;
  const kept = { ...item };
  delete kept.facts;
  if (item.type !== 'integration') return kept;

  const registryId = registry.id || registry.name || 'unsaved registry';
  let definition = null;
  try {
    const itemUrl = item.source ? resolveItemUrl(item.source, registry.source) : null;
    if (itemUrl) definition = await fetchContent(itemUrl, authHeaders, registry);
  } catch (error) {
    logger.warn(
      'Could not fetch the definition of a catalog integration; its facts are not shown',
      { component: COMPONENT, registryId, itemName: item.name, error }
    );
  }
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    return { ...kept, facts: null };
  }

  const refusal = registryProtocolRefusal(definition);
  if (refusal) {
    logger.warn(
      `Catalog item 'integration:${item.name}' of registry '${registryId}' rejected: ${refusal}`,
      {
        component: COMPONENT,
        registryId,
        itemType: 'integration',
        itemName: item.name,
        reason: refusal
      }
    );
    return null;
  }
  return { ...kept, facts: definitionFacts(definition) };
}

/**
 * Screen every item of a freshly fetched catalog (`screenCatalogItem`):
 * rejected integration items are left out, the others carry their `facts`.
 *
 * @param {object} catalog - Catalog data (validated, or as mapped when validation failed)
 * @param {object} registry - Registry config
 * @param {Record<string, string>} authHeaders - The registry's credentials
 * @returns {Promise<object>} The catalog with the screened items
 */
async function screenCatalogItems(catalog, registry, authHeaders) {
  if (!catalog || !Array.isArray(catalog.items)) return catalog;
  const screened = await mapWithConcurrency(
    catalog.items,
    DEFINITION_FETCH_CONCURRENCY,
    async item => {
      try {
        return await screenCatalogItem(item, registry, authHeaders);
      } catch (error) {
        // One unexpected failure must not abort the whole refresh; install
        // still refuses what the screen would have dropped.
        logger.warn('Could not screen a catalog item; it is kept without facts', {
          component: COMPONENT,
          registryId: registry?.id,
          itemName: item?.name,
          error: error?.message
        });
        return item && typeof item === 'object' ? { ...item, facts: null } : item;
      }
    }
  );
  return { ...catalog, items: screened.filter(item => item !== null) };
}

/**
 * The facts of an item for the browse grid: everything but the action list,
 * which only the detail shows.
 *
 * @param {object|null|undefined} facts
 * @returns {object|null|undefined}
 */
function listFacts(facts) {
  if (!facts || typeof facts !== 'object') return facts;
  const summary = { ...facts };
  delete summary.actions;
  return summary;
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
 * @param {Record<string, string>} [authHeaders] - Optional auth headers (none when omitted)
 * @param {object} registry - Registry config the tree is read for
 * @returns {Promise<Array<{ path: string, type: string }>>} Tree entries
 * @throws {Error} When the target is refused or the API call fails
 */
async function fetchGitHubTree(owner, repo, ref, authHeaders, registry) {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`;
  const response = await marketplaceFetch('marketplace-registry', url, {
    registry,
    headers: { Accept: 'application/json' },
    authHeaders
  });
  if (!response.ok) throw new Error(`GitHub tree API: HTTP ${response.status}`);
  const data = await response.json();
  if (data.truncated) {
    logger.warn('GitHub truncated a recursive file tree; some files are not listed', {
      component: COMPONENT,
      repository: `${owner}/${repo}`,
      ref
    });
  }
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
  return markdown.replaceAll(
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
/**
 * Whether this server can run a catalog item (`compatibility.ihub`, or the
 * short form `minVersion`), for the browse list and the item detail: an
 * incompatible item is shown greyed with the reason and cannot be installed.
 *
 * @param {object} item - Catalog item
 * @returns {{ compatible: boolean, requires: string|null, serverVersion: string|null, incompatibleReason: string|null }}
 */
export function compatibilityFields(item) {
  const { compatible, requires, serverVersion } = checkCompatibility(item);
  return {
    compatible,
    requires,
    serverVersion,
    incompatibleReason: compatible ? null : describeIncompatibility(requires, serverVersion)
  };
}

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
    await configStore.writeJson(REGISTRIES_FILE, registriesData);
    const cc = await this._getConfigCache();
    await cc.refreshRegistriesCache();
  }

  /**
   * Change the registries config: read it fresh, apply `mutate`, write it, in
   * one step no other change interleaves with, then refresh the cache. A change
   * made from a snapshot taken earlier (before a catalog fetch, or before another
   * admin's edit landed) erased what was written in between.
   *
   * `mutate` may run more than once and may throw (nothing is written then);
   * it returns the value this method resolves to.
   *
   * @param {(data: { registries: Array }) => any} mutate
   * @returns {Promise<any>}
   */
  async _updateRegistries(mutate) {
    let result;
    await configStore.updateJson(REGISTRIES_FILE, current => {
      const body = current && typeof current === 'object' ? current : {};
      if (!Array.isArray(body.registries)) body.registries = [];
      result = mutate(body);
      return body;
    });
    const cc = await this._getConfigCache();
    await cc.refreshRegistriesCache();
    return result;
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

    logger.info('Fetching catalog', { component: COMPONENT, catalogUrl });

    const rawData = await fetchContent(catalogUrl, authHeaders, registry);

    // Claude Code plugin marketplace: one skill item per SKILL.md a plugin ships
    if (rawData && Array.isArray(rawData.plugins)) {
      const items = await buildPluginSkillItems({
        plugins: rawData.plugins,
        owner: rawData.owner,
        ownRepo: parseGitHubUrl(toRawGitHubUrl(catalogUrl)),
        // The registry's credentials go to GitHub only when the registry itself is on GitHub
        fetchTree: (owner, repo, ref) =>
          fetchGitHubTree(
            owner,
            repo,
            ref,
            sharesCredentialScope('https://api.github.com/', [catalogUrl]) ? authHeaders : {},
            registry
          ),
        logger,
        logContext: { component: COMPONENT, registryId: registry.id }
      });
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
      logger.warn('Catalog validation warnings', {
        component: COMPONENT,
        errors: validation.errors
      });
      // Return the mapped data even if validation finds issues — be lenient with remote content
      return screenCatalogItems(mapped, registry, authHeaders);
    }

    // Integration items: stdio definitions are rejected here, the others get their facts
    return screenCatalogItems(validation.data, registry, authHeaders);
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

    if (!registry) throw new ServiceError('NOT_FOUND', `Registry '${registryId}' not found`);
    if (!registry.enabled) throw new Error(`Registry '${registryId}' is disabled`);

    const catalog = await this.fetchCatalog(registry);

    await configStore.writeJson(getCacheRelPath(registryId), {
      registryId,
      fetchedAt: new Date().toISOString(),
      catalog
    });

    // Update lastSynced and itemCount in registries.json
    await this._updateRegistries(data => {
      const idx = data.registries.findIndex(r => r.id === registryId);
      if (idx !== -1) {
        data.registries[idx].lastSynced = new Date().toISOString();
        data.registries[idx].itemCount = (catalog.items || []).length;
      }
    });

    logger.info('Registry refreshed', {
      component: COMPONENT,
      registryId,
      itemCount: (catalog.items || []).length
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
      const safeConfig = { ...registryConfig };
      if (safeConfig && safeConfig.source) {
        // Validate and normalize the source URL before using it for outbound HTTP.
        safeConfig.source = sanitizeRegistrySourceUrl(String(safeConfig.source));
      }

      const catalog = await this.fetchCatalog(safeConfig);
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
    // Missing and unreadable both resolve to null here, which is what "not
    // cached yet" has always meant to the callers.
    return await configStore.readJson(getCacheRelPath(registryId));
  }

  /**
   * Get all catalog items across all enabled registries, merged with installation status.
   * Supports filtering by type, search text, category, registry, and status.
   * Supports pagination via limit/cursor query parameters.
   *
   * @param {object} [filters={}] - Optional filter/pagination parameters
   * @param {string} [filters.type] - Filter by content type ('app'|'model'|'prompt'|'skill'|'workflow'|'all')
   * @param {string} [filters.search] - Case-insensitive substring search against name and description
   * @param {string} [filters.category] - Filter by category string
   * @param {string} [filters.registry] - Filter by registry ID
   * @param {string} [filters.status] - Filter by installation status ('installed'|'local'|'available'|'all')
   * @param {string} [filters.cursor] - The `nextCursor` of the previous page
   * @param {number|string} [filters.limit=24] - Items per page, at most 1000
   * @returns {Promise<{ items: Array, nextCursor: string|null, total: number }>}
   */
  async getAllItems(filters = {}) {
    const cc = await this._getConfigCache();
    const { data: registriesData } = cc.getRegistries();
    const { data: installationsData } = cc.getInstallations();
    const registries = registriesData?.registries || [];
    const installations = installationsData?.installations || {};

    // Items already on this instance (shipped defaults, hand-made or copied
    // files) that the marketplace did not install
    const localIds = getLocalContentIds(cc);

    const allItems = [];

    for (const registry of registries) {
      if (!registry.enabled) continue;

      const cached = await this.getCachedCatalogAsync(registry.id);
      if (!cached) continue;

      const items = cached.catalog?.items || [];
      for (const item of items) {
        const key = `${item.type}:${item.name}`;
        const installation = installations[key];
        const existsLocally = !!localIds[item.type]?.has(item.name);

        allItems.push({
          ...item,
          ...(item.facts !== undefined ? { facts: listFacts(item.facts) } : {}),
          registryId: registry.id,
          registryName: registry.name,
          installationStatus: installationStatusFor(
            installation,
            existsLocally,
            offeredVersion(item, registry)
          ),
          installation: installation || null,
          ...compatibilityFields(item),
          ...versionPolicyFields(item, registry)
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
      // "Installed" covers items with an update waiting: they are installed too.
      filtered = filtered.filter(
        i =>
          i.installationStatus === filters.status ||
          (filters.status === 'installed' && i.installationStatus === 'update-available')
      );
    }

    // Pagination: `limit` (default 24, at most 1000) and the opaque `cursor`
    const limit = limitFrom(filters.limit, { fallback: 24, max: 1000 });
    const { items, nextCursor } = pageOfList(filtered, { limit, cursor: filters.cursor });

    return { items, nextCursor, total: filtered.length };
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

    // An item can be present without the marketplace having installed it
    const localIds = getLocalContentIds(cc);

    const cached = await this.getCachedCatalogAsync(registryId);
    if (!cached) throw new Error(`No cached catalog for registry '${registryId}'`);

    const item = (cached.catalog?.items || []).find(i => i.type === type && i.name === name);
    if (!item)
      throw new ServiceError(
        'NOT_FOUND',
        `Item '${type}:${name}' not found in registry '${registryId}'`
      );

    const key = `${type}:${name}`;
    const installation = installations[key];
    const existsLocally = !!localIds[type]?.has(name);

    // Look up the registry config so we can fetch a content preview
    const { data: registriesData } = cc.getRegistries();
    const registry = (registriesData?.registries || []).find(r => r.id === registryId);

    let contentPreview = null;
    if (registry) {
      try {
        const itemUrl = resolveItemUrl(item.source, registry.source);
        if (itemUrl) {
          const authHeaders = buildAuthHeaders(registry.auth);
          contentPreview = await fetchContent(itemUrl, authHeaders, registry);
        }
      } catch (error) {
        logger.warn('Could not fetch content preview', {
          component: COMPONENT,
          error
        });
      }
    }

    // Parse YAML frontmatter from SKILL.md content previews so the client
    // can render it as a metadata table rather than raw --- delimiters.
    // Only YAML frontmatter is accepted (see utils/frontMatter.js).
    if (typeof contentPreview === 'string') {
      try {
        const parsed = parseFrontMatter(contentPreview);
        if (parsed.data && Object.keys(parsed.data).length > 0) {
          contentPreview = { body: parsed.content.trim(), frontmatter: parsed.data };
        }
      } catch (error) {
        // Invalid YAML or a non-YAML frontmatter language: the preview stays
        // the plain text it was fetched as, and the item detail still loads.
        logger.warn('Could not parse content preview frontmatter, showing it as plain text', {
          component: COMPONENT,
          registryId,
          itemType: type,
          itemName: name,
          error
        });
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

    // A catalog cached before facts were derived: the preview is the definition
    let facts = item.facts;
    if (
      // null: the refresh could not read the definition; the preview may have it now
      (facts === undefined || facts === null) &&
      type === 'integration' &&
      contentPreview &&
      typeof contentPreview === 'object' &&
      !Array.isArray(contentPreview) &&
      contentPreview.protocol
    ) {
      facts = definitionFacts(contentPreview);
    }

    return {
      ...item,
      ...(facts !== undefined ? { facts } : {}),
      registryId,
      registryName: registry?.name,
      installationStatus: installationStatusFor(
        installation,
        existsLocally,
        offeredVersion(item, registry)
      ),
      installation: installation || null,
      ...compatibilityFields(item),
      ...versionPolicyFields(item, registry),
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
      throw new ServiceError(
        'BAD_REQUEST',
        `Invalid registry config: ${validation.errors.join(', ')}`
      );
    }

    const registry = {
      ...validation.data,
      auth: encryptRegistryAuth(validation.data.auth),
      createdAt: new Date().toISOString(),
      lastSynced: null,
      itemCount: 0
    };

    await this._updateRegistries(data => {
      if (data.registries.find(r => r.id === registryData.id)) {
        throw new ServiceError('CONFLICT', `Registry with id '${registryData.id}' already exists`);
      }
      data.registries.push(registry);
    });

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
    const stored = await this._updateRegistries(data => {
      const idx = data.registries.findIndex(r => r.id === id);
      if (idx === -1) throw new ServiceError('NOT_FOUND', `Registry '${id}' not found`);

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
      // The version policy (channel, pins) is checked like on create; a pin
      // that is not a semver range would otherwise hide every version. Only
      // these two fields: an edit has never re-validated the rest.
      const validation = validateRegistryVersionPolicy(updated);
      if (!validation.success) {
        throw new ServiceError(
          'BAD_REQUEST',
          `Invalid registry config: ${validation.errors.join(', ')}`
        );
      }
      for (const field of ['channel', 'pins']) {
        if (validation.data[field] === undefined) delete updated[field];
        else updated[field] = validation.data[field];
      }

      data.registries[idx] = updated;
      return updated;
    });

    return { ...stored, auth: redactAuth(stored.auth) };
  }

  /**
   * Delete a registry and remove its cached catalog.
   *
   * @param {string} id - Registry ID to delete
   * @returns {Promise<void>}
   * @throws {Error} When the registry is not found
   */
  async deleteRegistry(id) {
    await this._updateRegistries(data => {
      const idx = data.registries.findIndex(r => r.id === id);
      if (idx === -1) throw new ServiceError('NOT_FOUND', `Registry '${id}' not found`);
      data.registries.splice(idx, 1);
    });

    // Best-effort cache cleanup — a cache file that was never written
    // reports false rather than throwing
    await configStore.remove(getCacheRelPath(id));
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
   * @param {Record<string, string>} [authHeaders] - Optional auth headers (none when omitted)
   * @param {object} [registry] - Registry the skill comes from; decides which
   *   hosts may be fetched (see `marketplaceFetch.js`)
   * @returns {Promise<string[]>} Relative paths of companion files, or [] when
   *   the URL is not a GitHub one
   * @throws {Error} When the tree fetch is refused or fails
   */
  async discoverCompanions(skillMdUrl, authHeaders, registry) {
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

    const tree = await fetchGitHubTree(
      ghInfo.owner,
      ghInfo.repo,
      ghInfo.ref,
      authHeaders,
      registry
    );
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
   * The catalog item of one version a catalog item lists (`versions[]`, the
   * pinned install and update of versioning phase 3). The current version is
   * the item itself; any other is fetched from its version descriptor:
   * `versions[].ref` (relative to the catalog, or absolute), or, without a
   * ref, `<catalog URL>?type=…&name=…&version=…` from a registry that serves
   * versions itself. The descriptor is a catalog item of that version (its
   * own `source`, companions and integrity) and must name the same type, name
   * and version. The registry's credentials travel only where the registry
   * itself lives (`sharesCredentialScope`).
   *
   * @param {object} registry - registry config (auth decrypted or encrypted)
   * @param {object} item - the catalog item
   * @param {string} version - a version the item lists
   * @returns {Promise<object>} the catalog item of that version
   * @throws {Error} `VERSION_NOT_LISTED`, `VERSION_DESCRIPTOR_INVALID`, or the fetch error
   */
  async fetchItemVersion(registry, item, version) {
    if (version === item.version) return item;
    const listed = (Array.isArray(item.versions) ? item.versions : []).find(
      entry => entry?.version === version
    );
    if (!listed) {
      throw new ServiceError(
        'VERSION_NOT_LISTED',
        `Version ${version} of ${item.type} '${item.name}' is not listed by registry '${registry.id}'`
      );
    }
    const url = versionDescriptorUrl(item, listed, registry);
    const authHeaders = sharesCredentialScope(url, [registry.source])
      ? buildAuthHeaders(registry.auth)
      : {};
    const data = await fetchContent(url, authHeaders, registry);
    const parsed = catalogItemVersionSchema.safeParse(data);
    if (
      !parsed.success ||
      parsed.data.type !== item.type ||
      parsed.data.name !== item.name ||
      parsed.data.version !== version
    ) {
      throw new ServiceError(
        'VERSION_DESCRIPTOR_INVALID',
        `The descriptor of ${item.type} '${item.name}' ${version} from registry '${registry.id}' is not a catalog item of that version`
      );
    }
    return parsed.data;
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
    if (!registry) throw new ServiceError('NOT_FOUND', `Registry '${id}' not found`);
    return { ...registry, auth: decryptRegistryAuth(registry.auth) };
  }
}

export default new RegistryService();
