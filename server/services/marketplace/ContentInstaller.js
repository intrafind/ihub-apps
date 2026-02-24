/**
 * ContentInstaller
 *
 * Handles installation, update, uninstallation, and detachment of marketplace
 * content items (apps, models, prompts, skills, workflows) on behalf of an admin.
 *
 * All installation actions are tracked in config/installations.json so the
 * marketplace UI can display which items are managed and enable update/uninstall
 * flows. File writes use atomicWriteJSON to prevent partial-write corruption.
 *
 * Content type dispatch table (CONTENT_CONFIG) maps each type to:
 * - dir: subdirectory under contents/ where files live
 * - ext: file extension for JSON-based types (null for skills)
 * - cacheRefresh: ConfigCache method name to call after write
 * - validate: async validation function returning { success, errors }
 *
 * Skills are directory-based (contents/skills/{name}/), not single-file.
 * Model configs have their apiKey stripped on install for security.
 *
 * @module services/marketplace/ContentInstaller
 */

import { promises as fs } from 'fs';
import path from 'path';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import { isValidId } from '../../utils/pathSecurity.js';
import { getRootDir } from '../../pathUtils.js';
import config from '../../config.js';
import registryService from './RegistryService.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'ContentInstaller';

/**
 * Return the absolute path to the contents directory.
 *
 * @returns {string}
 */
function getContentsDir() {
  return path.join(getRootDir(), config.CONTENTS_DIR);
}

/**
 * Content type dispatch table.
 * Each entry describes how to store, validate, and cache-refresh a given type.
 *
 * @type {Record<string, { dir: string, ext: string|null, cacheRefresh: string, validate: function }>}
 */
const CONTENT_CONFIG = {
  app: {
    dir: 'apps',
    ext: '.json',
    cacheRefresh: 'refreshAppsCache',
    validate: async data => {
      try {
        const { validateAppConfig } = await import('../../validators/appConfigSchema.js');
        return validateAppConfig ? validateAppConfig(data) : { success: true };
      } catch {
        return { success: true };
      }
    }
  },
  model: {
    dir: 'models',
    ext: '.json',
    cacheRefresh: 'refreshModelsCache',
    validate: async data => {
      try {
        const { validateModelConfig } = await import('../../validators/modelConfigSchema.js');
        return validateModelConfig ? validateModelConfig(data) : { success: true };
      } catch {
        return { success: true };
      }
    }
  },
  prompt: {
    dir: 'prompts',
    ext: '.json',
    cacheRefresh: 'refreshPromptsCache',
    validate: async () => ({ success: true })
  },
  skill: {
    dir: 'skills',
    ext: null, // Directory-based, not a single file
    cacheRefresh: 'refreshSkillsCache',
    validate: async () => ({ success: true })
  },
  workflow: {
    dir: 'workflows',
    ext: '.json',
    cacheRefresh: 'refreshWorkflowsCache',
    validate: async () => ({ success: true })
  }
};

// ---------------------------------------------------------------------------
// Installations manifest helpers
// ---------------------------------------------------------------------------

/**
 * Get a reference to the singleton ConfigCache via dynamic import.
 * Avoids the circular dependency that would arise from a static import.
 *
 * @returns {Promise<import('../../configCache.js').default>}
 */
async function getConfigCache() {
  const mod = await import('../../configCache.js');
  return mod.default;
}

/**
 * Return the absolute file path for installations.json.
 *
 * @returns {string}
 */
function getInstallationsPath() {
  return path.join(getContentsDir(), 'config', 'installations.json');
}

/**
 * Read the current installations manifest from ConfigCache.
 *
 * @returns {Promise<{ installations: Record<string, object> }>}
 */
async function readInstallations() {
  const cc = await getConfigCache();
  const { data } = cc.getInstallations();
  return data || { installations: {} };
}

/**
 * Persist the installations manifest to disk and refresh the cache.
 *
 * @param {{ installations: Record<string, object> }} data
 * @returns {Promise<void>}
 */
async function saveInstallations(data) {
  const filePath = getInstallationsPath();
  await atomicWriteJSON(filePath, data);
  const cc = await getConfigCache();
  await cc.refreshInstallationsCache();
}

// ---------------------------------------------------------------------------
// Item content fetching
// ---------------------------------------------------------------------------

/**
 * Fetch the content of a catalog item from its registry.
 * Resolves the item URL, applies auth headers, and decodes GitHub API responses.
 *
 * @param {string} registryId - Registry that hosts the item
 * @param {string} type - Content type ('app'|'model'|'prompt'|'skill'|'workflow')
 * @param {string} name - Item name / identifier
 * @returns {Promise<{ item: object, content: object }>}
 *   The matching catalog item descriptor and its fetched content
 * @throws {Error} When the catalog is not cached, item is not found, or the fetch fails
 */
async function fetchItemContent(registryId, type, name) {
  const registry = await registryService.getRegistryWithAuth(registryId);
  const cached = await registryService.getCachedCatalogAsync(registryId);

  if (!cached) {
    throw new Error(
      `No cached catalog for registry '${registryId}'. Please refresh the registry first.`
    );
  }

  const item = (cached.catalog?.items || []).find(i => i.type === type && i.name === name);
  if (!item) throw new Error(`Item '${type}:${name}' not found in registry '${registryId}'`);

  const itemUrl = registryService.resolveItemUrl(item, registry);
  if (!itemUrl) throw new Error(`Cannot resolve URL for item '${type}:${name}'`);

  // Build auth headers from the (already decrypted) registry config
  const auth = registry.auth;
  const authHeaders = {};
  if (auth && auth.type !== 'none') {
    if (auth.type === 'bearer') {
      authHeaders['Authorization'] = `Bearer ${auth.token}`;
    } else if (auth.type === 'basic') {
      const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
      authHeaders['Authorization'] = `Basic ${encoded}`;
    } else if (auth.type === 'header') {
      authHeaders[auth.headerName] = auth.headerValue;
    }
  }

  const { throttledFetch } = await import('../../requestThrottler.js');

  const response = await throttledFetch('marketplace-installer', itemUrl, {
    headers: {
      Accept: 'application/json, application/vnd.github.raw+json',
      ...authHeaders
    }
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

  const responseData = await response.json();

  // GitHub Contents API wraps file content in base64
  if (responseData && responseData.content && responseData.encoding === 'base64') {
    const decoded = Buffer.from(responseData.content.replace(/\n/g, ''), 'base64').toString('utf8');
    return { item, content: JSON.parse(decoded) };
  }

  return { item, content: responseData };
}

// ---------------------------------------------------------------------------
// ContentInstaller class
// ---------------------------------------------------------------------------

class ContentInstaller {
  /**
   * Install a content item from a registry.
   *
   * Steps:
   * 1. Validate the item name is path-safe
   * 2. Check the item is not already installed
   * 3. Fetch the item content from the registry
   * 4. Validate the fetched content
   * 5. Write the content to disk
   * 6. Record the installation in installations.json
   * 7. Refresh the relevant ConfigCache entry
   *
   * @param {string} registryId - Registry ID to install from
   * @param {string} type - Content type ('app'|'model'|'prompt'|'skill'|'workflow')
   * @param {string} name - Item name / identifier
   * @param {string} [installedBy='admin'] - Username of the installing admin for audit trail
   * @returns {Promise<object>} The installation manifest entry
   * @throws {Error} On validation failure, duplicate installation, or fetch error
   */
  async install(registryId, type, name, installedBy = 'admin') {
    logger.info(`Installing ${type}:${name} from registry '${registryId}'`, {
      component: COMPONENT
    });

    const config = CONTENT_CONFIG[type];
    if (!config) throw new Error(`Unknown content type: ${type}`);

    // Guard against path traversal via item name
    if (!isValidId(name)) {
      throw new Error(
        `Invalid item name '${name}': only alphanumeric characters, dots, underscores, and hyphens are allowed`
      );
    }

    // Prevent re-installing an already-installed item
    const installations = await readInstallations();
    const key = `${type}:${name}`;
    if (installations.installations[key]) {
      throw new Error(`${type} '${name}' is already installed. Use update to upgrade.`);
    }

    const { item, content } = await fetchItemContent(registryId, type, name);

    // Validate the fetched content against the schema for this type
    const validation = await config.validate(content);
    if (!validation.success) {
      throw new Error(`Content validation failed: ${(validation.errors || []).join(', ')}`);
    }

    await this._writeContent(type, name, content, config);

    // Record installation in manifest
    const manifest = {
      type,
      itemId: name,
      registryId,
      version: item.version || null,
      installedAt: new Date().toISOString(),
      installedBy,
      updatedAt: null,
      updateAvailable: null
    };

    installations.installations[key] = manifest;
    await saveInstallations(installations);

    // Refresh the cache for the affected content type
    const cc = await getConfigCache();
    if (typeof cc[config.cacheRefresh] === 'function') {
      await cc[config.cacheRefresh]();
    }

    logger.info(`Installed ${type}:${name} from registry '${registryId}'`, {
      component: COMPONENT
    });
    return manifest;
  }

  /**
   * Uninstall a marketplace-managed content item.
   * Deletes the content files from disk and removes the installation record.
   *
   * @param {string} type - Content type
   * @param {string} name - Item name / identifier
   * @returns {Promise<void>}
   * @throws {Error} When the item is not found in the installations manifest
   */
  async uninstall(type, name) {
    logger.info(`Uninstalling ${type}:${name}`, { component: COMPONENT });

    const config = CONTENT_CONFIG[type];
    if (!config) throw new Error(`Unknown content type: ${type}`);

    const installations = await readInstallations();
    const key = `${type}:${name}`;

    if (!installations.installations[key]) {
      throw new Error(`${type} '${name}' is not installed`);
    }

    await this._deleteContent(type, name, config);

    delete installations.installations[key];
    await saveInstallations(installations);

    const cc = await getConfigCache();
    if (typeof cc[config.cacheRefresh] === 'function') {
      await cc[config.cacheRefresh]();
    }

    logger.info(`Uninstalled ${type}:${name}`, { component: COMPONENT });
  }

  /**
   * Update an installed content item to the latest version from its registry.
   * Fetches the current content, validates it, overwrites the existing files,
   * and updates the installation manifest entry.
   *
   * @param {string} type - Content type
   * @param {string} name - Item name / identifier
   * @param {string} [updatedBy='admin'] - Username of the updating admin
   * @returns {Promise<object>} The updated installation manifest entry
   * @throws {Error} When the item is not tracked in the installations manifest
   */
  async update(type, name, updatedBy = 'admin') {
    logger.info(`Updating ${type}:${name}`, { component: COMPONENT });

    const installations = await readInstallations();
    const key = `${type}:${name}`;
    const existing = installations.installations[key];

    if (!existing) throw new Error(`${type} '${name}' is not installed`);

    const config = CONTENT_CONFIG[type];
    if (!config) throw new Error(`Unknown content type: ${type}`);

    const { item, content } = await fetchItemContent(existing.registryId, type, name);

    const validation = await config.validate(content);
    if (!validation.success) {
      throw new Error(`Content validation failed: ${(validation.errors || []).join(', ')}`);
    }

    await this._writeContent(type, name, content, config);

    existing.updatedAt = new Date().toISOString();
    existing.updatedBy = updatedBy;
    existing.version = item.version || existing.version;
    existing.updateAvailable = null;

    await saveInstallations(installations);

    const cc = await getConfigCache();
    if (typeof cc[config.cacheRefresh] === 'function') {
      await cc[config.cacheRefresh]();
    }

    logger.info(`Updated ${type}:${name}`, { component: COMPONENT });
    return existing;
  }

  /**
   * Detach an item from marketplace tracking without deleting its files.
   * Useful when an admin wants to keep using the content but manage it manually.
   *
   * @param {string} type - Content type
   * @param {string} name - Item name / identifier
   * @returns {Promise<void>}
   * @throws {Error} When the item is not found in the installations manifest
   */
  async detach(type, name) {
    const installations = await readInstallations();
    const key = `${type}:${name}`;

    if (!installations.installations[key]) {
      throw new Error(`${type} '${name}' is not tracked in marketplace installations`);
    }

    delete installations.installations[key];
    await saveInstallations(installations);

    logger.info(`Detached ${type}:${name} from marketplace tracking`, { component: COMPONENT });
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * Write content to disk in the appropriate location for the given type.
   *
   * Skills are directory-based:
   * - If content has a `files` map, each key/value is written as a separate file
   * - If content is a plain string, it is written as SKILL.md
   *
   * All other types are written as a single JSON file.
   * Model configs have their `apiKey` field stripped before writing for security.
   *
   * @param {string} type - Content type
   * @param {string} name - Item name (safe path component, already validated)
   * @param {object|string} content - Content to write
   * @param {{ dir: string, ext: string|null }} typeConfig - Entry from CONTENT_CONFIG
   * @returns {Promise<void>}
   */
  async _writeContent(type, name, content, typeConfig) {
    const contentsDir = getContentsDir();

    if (type === 'skill') {
      const skillDir = path.join(contentsDir, typeConfig.dir, name);
      await fs.mkdir(skillDir, { recursive: true });

      if (typeof content === 'object' && content !== null && content.files) {
        // Multi-file skill package
        for (const [filename, fileContent] of Object.entries(content.files)) {
          const filePath = path.join(skillDir, filename);
          const resolvedPath = path.resolve(filePath);
          // Guard against path traversal within the skill's own file list
          if (!resolvedPath.startsWith(path.resolve(skillDir))) {
            throw new Error(`Path traversal detected in skill file: ${filename}`);
          }
          const fileData =
            typeof fileContent === 'string' ? fileContent : JSON.stringify(fileContent, null, 2);
          await fs.writeFile(filePath, fileData, 'utf8');
        }
      } else if (typeof content === 'string') {
        // Bare SKILL.md
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), content, 'utf8');
      }
    } else {
      // Strip API keys from model configs before writing to disk for security
      let safeContent = content;
      if (
        type === 'model' &&
        safeContent &&
        typeof safeContent === 'object' &&
        safeContent.apiKey
      ) {
        const { apiKey, ...rest } = safeContent;
        safeContent = rest;
      }

      const filePath = path.join(contentsDir, typeConfig.dir, `${name}${typeConfig.ext}`);
      await atomicWriteJSON(filePath, safeContent);
    }
  }

  /**
   * Delete the content files for a given item from disk.
   * Skills remove the entire directory; other types remove the single JSON file.
   * Missing files are ignored (no error thrown).
   *
   * @param {string} type - Content type
   * @param {string} name - Item name
   * @param {{ dir: string }} typeConfig - Entry from CONTENT_CONFIG
   * @returns {Promise<void>}
   */
  async _deleteContent(type, name, typeConfig) {
    const contentsDir = getContentsDir();

    if (type === 'skill') {
      const skillDir = path.join(contentsDir, typeConfig.dir, name);
      await fs.rm(skillDir, { recursive: true, force: true });
    } else {
      const filePath = path.join(contentsDir, typeConfig.dir, `${name}${typeConfig.ext}`);
      try {
        await fs.unlink(filePath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // File already gone — treat as success
      }
    }
  }
}

export default new ContentInstaller();
