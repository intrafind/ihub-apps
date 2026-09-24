/**
 * ContentInstaller
 *
 * Handles installation, update, uninstallation, and detachment of marketplace
 * content items (apps, models, prompts, skills, workflows) on behalf of an admin.
 *
 * All installation actions are tracked in config/installations.json so the
 * marketplace UI can display which items are managed and enable update/uninstall
 * flows. JSON content is read and written through the ConfigStore, which keeps
 * the files byte-identical to what an admin edit produces. Skills are the
 * exception: they are a directory of arbitrary files rather than one JSON
 * document, so they stay on the filesystem.
 *
 * Content type dispatch table (CONTENT_CONFIG) maps each type to:
 * - dir: subdirectory under contents/ where files live
 * - ext: file extension for JSON-based types (null for skills)
 * - cacheRefresh: ConfigCache method name to call after write
 * - validate: validation function returning { success, errors }
 *
 * Skills are directory-based (contents/skills/{name}/), not single-file.
 * Model configs have their apiKey stripped on install for security; a model
 * written over an existing one keeps that one's apiKey and `default` flag.
 *
 * An item that already exists on this instance without having been installed
 * from the marketplace (a shipped default, or something an admin made) is
 * only replaced when the caller passes `replaceLocal`.
 *
 * @module services/marketplace/ContentInstaller
 */

import { promises as fs } from 'fs';
import path from 'path';
import configStore from '../../services/config/ConfigStore.js';
import { isValidId, resolveAndValidatePath } from '../../utils/pathSecurity.js';
import { getRootDir } from '../../pathUtils.js';
import config from '../../config.js';
import registryService from './RegistryService.js';
import { getLocalContentIds } from './localContent.js';
import logger from '../../utils/logger.js';
import { appConfigSchema } from '../../validators/appConfigSchema.js';
import { modelConfigSchema } from '../../validators/modelConfigSchema.js';
import { promptConfigSchema } from '../../validators/promptConfigSchema.js';
import { workflowConfigSchema } from '../../validators/workflowConfigSchema.js';

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
 * The path of one installed item, relative to `contents/`.
 *
 * The marketplace owns the file it installs, so the name it was installed
 * under is the file name — this deliberately does not search the directory
 * for a document whose `id` matches, the way the admin routes do for
 * hand-edited files.
 *
 * @param {string} name - Item name (already validated as a safe id)
 * @param {{ dir: string, ext: string|null }} typeConfig - Entry from CONTENT_CONFIG
 * @returns {string} Path relative to `contents/`, e.g. `apps/my-app.json`
 */
function contentRelPath(name, typeConfig) {
  return `${typeConfig.dir}/${name}${typeConfig.ext}`;
}

/**
 * A `validate` function for CONTENT_CONFIG backed by one of the config
 * schemas the loaders use, so the installer accepts exactly what the running
 * server would load without a validation warning.
 *
 * @param {import('zod').ZodTypeAny} schema
 * @returns {(data: unknown) => { success: boolean, errors?: string[] }}
 */
function schemaValidator(schema) {
  return data => {
    const result = schema.safeParse(data);
    if (result.success) return { success: true };
    return {
      success: false,
      errors: result.error.issues.map(
        issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`
      )
    };
  };
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
    validate: schemaValidator(appConfigSchema)
  },
  model: {
    dir: 'models',
    ext: '.json',
    cacheRefresh: 'refreshModelsCache',
    validate: schemaValidator(modelConfigSchema)
  },
  prompt: {
    dir: 'prompts',
    ext: '.json',
    cacheRefresh: 'refreshPromptsCache',
    validate: schemaValidator(promptConfigSchema)
  },
  skill: {
    dir: 'skills',
    ext: null, // Directory-based, not a single file
    cacheRefresh: 'refreshSkillsCache',
    validate: () => ({ success: true })
  },
  workflow: {
    dir: 'workflows',
    ext: '.json',
    cacheRefresh: 'refreshWorkflowsCache',
    validate: schemaValidator(workflowConfigSchema)
  }
};

/**
 * Validate fetched content before it is written.
 *
 * Beyond the schema, a JSON item's `id` must equal its catalog name: the file
 * is written as `<name>.json`, and a different `id` inside it would leave the
 * item unreachable by the name the marketplace tracks it under.
 *
 * @param {string} type - Content type
 * @param {string} name - Catalog item name
 * @param {object|string} content - Fetched content
 * @param {{ ext: string|null, validate: function }} typeConfig - Entry from CONTENT_CONFIG
 * @throws {Error} Listing every problem found
 */
function assertValidContent(type, name, content, typeConfig) {
  const validation = typeConfig.validate(content);
  const errors = validation.success ? [] : [...(validation.errors || [])];
  if (typeConfig.ext && content?.id !== undefined && content.id !== name) {
    errors.push(`id: '${content.id}' does not match the catalog name '${name}'`);
  }
  if (errors.length > 0) {
    throw new Error(`Content validation failed: ${errors.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Installations manifest helpers
// ---------------------------------------------------------------------------

/** The installation manifest, relative to `contents/`. */
const INSTALLATIONS_FILE = 'config/installations.json';

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
  await configStore.writeJson(INSTALLATIONS_FILE, data);
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
      Accept: 'application/json, text/plain, application/vnd.github.raw+json',
      ...authHeaders
    }
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

  const text = await response.text();

  let responseData;
  try {
    responseData = JSON.parse(text);
  } catch {
    // Non-JSON content (e.g., SKILL.md markdown) — check for companion files
    return { item, content: await buildSkillContent(item, text, authHeaders) };
  }

  // GitHub Contents API wraps file content in base64
  if (responseData && responseData.content && responseData.encoding === 'base64') {
    const decoded = Buffer.from(responseData.content.replace(/\n/g, ''), 'base64').toString('utf8');
    try {
      return { item, content: JSON.parse(decoded) };
    } catch {
      return { item, content: await buildSkillContent(item, decoded, authHeaders) };
    }
  }

  return { item, content: responseData };
}

/**
 * Build the skill content object, fetching companion files if the item source
 * lists them. Returns a `{ files: {...} }` map when companions are present,
 * or the bare markdown string when there are none.
 *
 * @param {object} item - Catalog item descriptor (may have source.companions)
 * @param {string} skillMd - Raw SKILL.md content
 * @param {Record<string, string>} authHeaders - Auth headers for companion fetches
 * @returns {Promise<string|{ files: Record<string, string> }>}
 */
async function buildSkillContent(item, skillMd, authHeaders) {
  let companions = item.source?.companions;

  // Fallback: discover companions at install time if cache is stale (no companions field)
  if (
    (!companions || companions.length === 0) &&
    item.source?.type === 'url' &&
    item.source.url?.endsWith('/SKILL.md')
  ) {
    try {
      companions = await registryService.discoverCompanions(item.source.url, authHeaders);
    } catch (error) {
      logger.warn('Companion discovery fallback failed', { component: COMPONENT, error });
    }
  }

  if (!companions || companions.length === 0) return skillMd;

  // Derive skill directory URL from the SKILL.md URL (strip the filename)
  const skillDirUrl = item.source.url.replace(/\/SKILL\.md$/, '');

  const files = { 'SKILL.md': skillMd };

  const { throttledFetch } = await import('../../requestThrottler.js');

  await Promise.all(
    companions.map(async relativePath => {
      const companionUrl = `${skillDirUrl}/${relativePath}`;
      try {
        const res = await throttledFetch('marketplace-installer', companionUrl, {
          headers: {
            Accept: 'text/plain, application/vnd.github.raw+json, */*',
            ...authHeaders
          }
        });
        if (res.ok) {
          files[relativePath] = await res.text();
        } else {
          logger.warn('Companion file not found', {
            component: COMPONENT,
            httpStatus: res.status,
            companionUrl
          });
        }
      } catch (error) {
        logger.warn('Failed to fetch companion file', {
          component: COMPONENT,
          relativePath,
          error
        });
      }
    })
  );

  return { files };
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
   * 3. Refuse to replace a local item of the same type and name, unless asked to
   * 4. Fetch the item content from the registry
   * 5. Validate the fetched content
   * 6. Write the content to disk
   * 7. Record the installation in installations.json
   * 8. Refresh the relevant ConfigCache entry
   *
   * @param {string} registryId - Registry ID to install from
   * @param {string} type - Content type ('app'|'model'|'prompt'|'skill'|'workflow')
   * @param {string} name - Item name / identifier
   * @param {string} [installedBy='admin'] - Username of the installing admin for audit trail
   * @param {{ replaceLocal?: boolean }} [options] - `replaceLocal: true` confirms
   *   replacing an item that already exists on this instance
   * @returns {Promise<object>} The installation manifest entry
   * @throws {Error} On validation failure, duplicate installation, fetch error,
   *   or — with `code: 'LOCAL_CONTENT_EXISTS'` — an unconfirmed local item
   */
  async install(registryId, type, name, installedBy = 'admin', { replaceLocal = false } = {}) {
    logger.info('Installing content item from registry', {
      component: COMPONENT,
      type,
      name,
      registryId
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

    // The same id may already exist here without the marketplace knowing it,
    // e.g. a shipped default. Installing writes over it, so that takes an
    // explicit confirmation.
    const localIds = getLocalContentIds(await getConfigCache());
    if (localIds[type]?.has(name) && !replaceLocal) {
      const error = new Error(
        `${type} '${name}' already exists on this instance and was not installed from the ` +
          'marketplace. Installing replaces it; confirm the replacement to continue.'
      );
      error.code = 'LOCAL_CONTENT_EXISTS';
      throw error;
    }

    const { item, content } = await fetchItemContent(registryId, type, name);

    // Validate the fetched content against the schema for this type
    assertValidContent(type, name, content, config);

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
      updateAvailable: null,
      sourceUrl: item.source?.url || null
    };

    installations.installations[key] = manifest;
    await saveInstallations(installations);

    // Refresh the cache for the affected content type
    const cc = await getConfigCache();
    if (typeof cc[config.cacheRefresh] === 'function') {
      await cc[config.cacheRefresh]();
    }

    logger.info('Content item installed from registry', {
      component: COMPONENT,
      type,
      name,
      registryId
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
    logger.info('Uninstalling content item', { component: COMPONENT, type, name });

    const config = CONTENT_CONFIG[type];
    if (!config) throw new Error(`Unknown content type: ${type}`);

    if (!isValidId(name)) {
      throw new Error(
        `Invalid content name: only alphanumeric characters, dots, underscores, and hyphens are allowed`
      );
    }

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

    logger.info('Content item uninstalled', { component: COMPONENT, type, name });
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
    logger.info('Updating content item', { component: COMPONENT, type, name });

    const installations = await readInstallations();
    const key = `${type}:${name}`;
    const existing = installations.installations[key];

    if (!existing) throw new Error(`${type} '${name}' is not installed`);

    const config = CONTENT_CONFIG[type];
    if (!config) throw new Error(`Unknown content type: ${type}`);

    if (!isValidId(name)) {
      throw new Error(
        `Invalid content name: only alphanumeric characters, dots, underscores, and hyphens are allowed`
      );
    }

    const { item, content } = await fetchItemContent(existing.registryId, type, name);

    assertValidContent(type, name, content, config);

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

    logger.info('Content item updated', { component: COMPONENT, type, name });
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

    logger.info('Content item detached from marketplace tracking', {
      component: COMPONENT,
      type,
      name
    });
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
   * All other types are written as a single JSON file, `<dir>/<name>.json`.
   * When a document with the same id already exists — the marketplace's own
   * copy on update, or a local one being replaced — it is written over; one
   * stored under a different file name is removed afterwards so the id is not
   * left in two files.
   *
   * Model configs have their `apiKey` field stripped before writing for
   * security. The instance-level settings of the model being replaced carry
   * over: its encrypted `apiKey` and its `default` flag, so installing or
   * updating never drops a configured key and never changes which model is
   * the system default. A model with no predecessor is written as non-default.
   *
   * @param {string} type - Content type
   * @param {string} name - Item name (safe path component, already validated)
   * @param {object|string} content - Content to write
   * @param {{ dir: string, ext: string|null }} typeConfig - Entry from CONTENT_CONFIG
   * @returns {Promise<void>}
   */
  async _writeContent(type, name, content, typeConfig) {
    if (type === 'skill') {
      const skillDir = path.join(getContentsDir(), typeConfig.dir, name);
      await fs.mkdir(skillDir, { recursive: true });

      if (typeof content === 'object' && content !== null && content.files) {
        // Multi-file skill package
        for (const [filename, fileContent] of Object.entries(content.files)) {
          // Guard against path traversal within the skill's own file list
          const filePath = await resolveAndValidatePath(filename, skillDir);
          if (!filePath) {
            throw new Error(`Path traversal detected in skill file: ${filename}`);
          }
          // Ensure parent directory exists (companion files may live in subdirs)
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          const fileData =
            typeof fileContent === 'string' ? fileContent : JSON.stringify(fileContent, null, 2);
          await fs.writeFile(filePath, fileData, 'utf8');
        }
      } else if (typeof content === 'string') {
        // Bare SKILL.md
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), content, 'utf8');
      }
    } else {
      const targetPath = contentRelPath(name, typeConfig);
      const previousPath = await configStore.resolveIdToPath(typeConfig.dir, name, {
        createIfMissing: false
      });

      // Strip API keys from model configs before writing to disk for security
      let safeContent = content;
      if (type === 'model' && safeContent && typeof safeContent === 'object') {
        const { apiKey: _ignored, ...rest } = safeContent;
        const previous = previousPath ? await configStore.readJson(previousPath) : null;
        safeContent = { ...rest, default: previous?.default === true };
        if (previous?.apiKey) safeContent.apiKey = previous.apiKey;
      }

      await configStore.writeJson(targetPath, safeContent);
      if (previousPath && previousPath !== targetPath) {
        await configStore.remove(previousPath);
      }
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
    if (type === 'skill') {
      const skillDir = path.join(getContentsDir(), typeConfig.dir, name);
      await fs.rm(skillDir, { recursive: true, force: true });
    } else {
      // A missing file reports false rather than throwing, which is the
      // "already gone — treat as success" this has always wanted.
      await configStore.remove(contentRelPath(name, typeConfig));
    }
  }
}

export default new ContentInstaller();
