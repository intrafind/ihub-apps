// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

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

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import configStore from '../../services/config/ConfigStore.js';
import { isValidId, resolveAndValidatePath } from '../../utils/pathSecurity.js';
import registryService from './RegistryService.js';
import { getLocalContentIds } from './localContent.js';
import { isSystemSkill } from '../skillLoader.js';
import logger from '../../utils/logger.js';
import { appConfigSchema } from '../../validators/appConfigSchema.js';
import { modelConfigSchema } from '../../validators/modelConfigSchema.js';
import { promptConfigSchema } from '../../validators/promptConfigSchema.js';
import { workflowConfigSchema } from '../../validators/workflowConfigSchema.js';
import { getContentsPath } from '../../utils/contentsPath.js';
import integrationRegistry from '../integrations/definitions/IntegrationRegistry.js';
import {
  CODE_FILE_PATTERN,
  checkScriptCodeFiles
} from '../integrations/definitions/scriptModule.js';
import {
  validateIntegrationDefinition,
  definitionIdToDirName,
  dirNameToDefinitionId
} from '../../validators/integrationDefinitionSchema.js';

const COMPONENT = 'ContentInstaller';

/**
 * Return the absolute path to the contents directory.
 *
 * @returns {string}
 */
function getContentsDir() {
  return getContentsPath();
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
  },
  integration: {
    // A definition folder (integration.json plus companions such as the
    // OpenAPI document); the IntegrationRegistry owns the files and the id
    // check, so the installer only validates the shape here.
    dir: 'integration-definitions',
    ext: null,
    cacheRefresh: null,
    validate: content => {
      const raw = content?.files?.['integration.json'];
      if (!raw) return { success: false, errors: ['integration.json is missing'] };
      const parsed = validateIntegrationDefinition(typeof raw === 'string' ? JSON.parse(raw) : raw);
      return parsed.success
        ? { success: true }
        : { success: false, errors: parsed.errors.map(e => `${e.path.join('.')}: ${e.message}`) };
    }
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
 * Exported for `services/skills/marketplaceSkills.js`, which copies a skill
 * into a user's own skills instead of installing it.
 *
 * @param {string} registryId - Registry that hosts the item
 * @param {string} type - Content type ('app'|'model'|'prompt'|'skill'|'workflow')
 * @param {string} name - Item name / identifier
 * @returns {Promise<{ item: object, content: object }>}
 *   The matching catalog item descriptor and its fetched content
 * @throws {Error} When the catalog is not cached, item is not found, or the fetch fails
 */
export async function fetchItemContent(registryId, type, name) {
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
    const decoded = Buffer.from(responseData.content.replaceAll('\n', ''), 'base64').toString(
      'utf8'
    );
    try {
      responseData = JSON.parse(decoded);
    } catch {
      return { item, content: await buildSkillContent(item, decoded, authHeaders) };
    }
  }

  if (type === 'integration') {
    const content = await buildIntegrationContent(
      item,
      responseData,
      itemUrl,
      authHeaders,
      registry
    );
    verifyIntegrationCode(item, content, registry);
    return { item, content };
  }

  return { item, content: responseData };
}

/** Whether `text` has the hash `expected` (`sha256-<base64>` or a hex digest). */
export function matchesIntegrity(text, expected) {
  if (typeof expected !== 'string' || !expected) return false;
  const digest = crypto.createHash('sha256').update(text, 'utf8');
  const value = expected.startsWith('sha256-') ? expected.slice('sha256-'.length) : expected;
  if (/^[0-9a-f]{64}$/i.test(value)) return digest.digest('hex') === value.toLowerCase();
  return digest.digest('base64') === value;
}

/**
 * Code travels only from a registry the admin trusts for it, and only with a
 * hash per code file in the catalog, which the fetched file must match. Every
 * hash the catalog lists is checked, whatever the file. A `script` definition
 * brings exactly one code file, its bundled module (`checkScriptCodeFiles`).
 *
 * @param {object} item - Catalog item
 * @param {{ files: Record<string, string|object> }} content
 * @param {object} registry - Registry config (`trustCode`)
 */
export function verifyIntegrationCode(item, content, registry) {
  const definition = content.files['integration.json'];
  const isScript = definition?.protocol?.type === 'script';
  const codeFiles = Object.keys(content.files).filter(file => CODE_FILE_PATTERN.test(file));
  const integrity = item.source?.integrity || {};
  if (isScript || codeFiles.length) {
    if (registry?.trustCode !== true) {
      const error = new Error(
        `Integration '${item.name}' brings code that runs on this server; the registry ` +
          `'${registry?.id || ''}' is not trusted for code. Mark the registry as trusted ` +
          'for code to install it.'
      );
      error.code = 'CODE_NOT_TRUSTED';
      throw error;
    }
    const unhashed = codeFiles.filter(file => !integrity[file]);
    if (unhashed.length) {
      const error = new Error(
        `Integration '${item.name}': the catalog lists no hash for the code file(s) ${unhashed.join(', ')}`
      );
      error.code = 'CODE_INTEGRITY_REQUIRED';
      throw error;
    }
    if (isScript) checkScriptCodeFiles(definition, content.files);
  }
  for (const [file, expected] of Object.entries(integrity)) {
    const text = content.files[file];
    if (typeof text !== 'string') continue;
    if (!matchesIntegrity(text, expected)) {
      const error = new Error(
        `Integration '${item.name}': the file ${file} does not match the hash the catalog lists`
      );
      error.code = 'INTEGRITY_MISMATCH';
      throw error;
    }
  }
}

/**
 * Build the folder of an integration definition: `integration.json` plus the
 * companions the catalog lists and the files the definition itself names
 * (its OpenAPI document and icon, when they are relative paths).
 *
 * @param {object} item - Catalog item
 * @param {object} definition - Parsed integration.json
 * @param {string} itemUrl - URL integration.json was fetched from
 * @param {Record<string, string>} authHeaders
 * @param {object} [registry] - Registry config (`source` names its own host)
 * @returns {Promise<{ files: Record<string, string|object> }>}
 */
async function buildIntegrationContent(item, definition, itemUrl, authHeaders, registry) {
  const listed = Array.isArray(item.source?.companions) ? item.source.companions : [];
  const referenced = [definition?.protocol?.document, definition?.icon].filter(
    value => typeof value === 'string' && value && !/^https?:\/\//i.test(value)
  );
  const companions = [...new Set([...listed, ...referenced])];
  // Siblings of integration.json; a `?ref=<branch>` of a GitHub Contents URL
  // belongs to every sibling too.
  const [itemPath, query = ''] = itemUrl.split('?');
  // The catalog may name the raw base of the folder (`source.rawBase`, as the
  // GitHub registries do); otherwise the folder is where integration.json is.
  const rawBase = typeof item.source?.rawBase === 'string' ? item.source.rawBase : '';
  const baseUrl = rawBase ? rawBase.replace(/\/$/, '') : itemPath.replace(/\/[^/]*$/, '');
  const { throttledFetch } = await import('../../requestThrottler.js');
  const files = { 'integration.json': definition };
  for (const relativePath of companions) {
    if (relativePath === 'integration.json') continue;
    const companionUrl = `${baseUrl}/${relativePath}${query ? `?${query}` : ''}`;
    // The catalog chose `rawBase`; the registry's credentials go only where
    // the registry itself lives.
    const trusted = sharesCredentialScope(companionUrl, [itemUrl, registry?.source]);
    if (!trusted) {
      logger.warn('Companion file is fetched without the registry credentials', {
        component: COMPONENT,
        companionUrl,
        itemUrl
      });
    }
    const res = await throttledFetch('marketplace-installer', companionUrl, {
      headers: {
        Accept: 'text/plain, application/json, application/vnd.github.raw+json',
        ...(trusted ? authHeaders : {})
      }
    });
    if (!res.ok) {
      throw new Error(`Companion file '${relativePath}' could not be fetched (HTTP ${res.status})`);
    }
    files[relativePath] = unwrapGitHubContent(await res.text());
  }
  return { files };
}

/** Hosts that share one GitHub token: the Contents API and the raw host. */
const GITHUB_HOSTS = new Set(['api.github.com', 'raw.githubusercontent.com', 'github.com']);

/**
 * Whether a companion URL may carry the registry's credentials: it is an
 * http(s) URL on the host of one of the `trustedUrls` (integration.json, the
 * registry's catalog), or both are GitHub hosts.
 *
 * @param {string} url
 * @param {Array<string|undefined>} trustedUrls
 * @returns {boolean}
 */
export function sharesCredentialScope(url, trustedUrls) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return false;
  for (const trusted of trustedUrls) {
    if (typeof trusted !== 'string') continue;
    let known;
    try {
      known = new URL(trusted);
    } catch {
      continue;
    }
    // Same host *and* scheme: a catalog must not move the credentials from
    // https to plain http, where they would travel in the clear.
    if (known.protocol === target.protocol && known.host === target.host) return true;
    if (
      target.protocol === 'https:' &&
      GITHUB_HOSTS.has(known.hostname) &&
      GITHUB_HOSTS.has(target.hostname)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The GitHub Contents API wraps a file in `{ content: <base64>, encoding }`;
 * a raw host returns the file itself. Returns the file either way.
 * @param {string} text
 * @returns {string}
 */
function unwrapGitHubContent(text) {
  if (!text.startsWith('{')) return text;
  try {
    const wrapper = JSON.parse(text);
    if (wrapper && typeof wrapper.content === 'string' && wrapper.encoding === 'base64') {
      return Buffer.from(wrapper.content.replaceAll('\n', ''), 'base64').toString('utf8');
    }
  } catch {
    // Not JSON: the file itself.
  }
  return text;
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

    // A system skill ships with iHub and its name is reserved; a marketplace
    // skill of the same name would be ignored by the skill loader anyway.
    if (type === 'skill' && isSystemSkill(name)) {
      throw new Error(`skill '${name}' is a system skill of iHub and cannot be installed over`);
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

    if (type === 'integration') {
      // The catalog name is the definition's folder name; the definition
      // inside must agree, or two registries could fight over one folder.
      const definitionId = content.files['integration.json']?.id;
      if (definitionIdToDirName(definitionId || '') !== name) {
        throw new Error(
          `Content validation failed: definition id '${definitionId}' does not match the catalog name '${name}'`
        );
      }
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

    if (type === 'integration') {
      const { default: installedIntegrationService } =
        await import('../integrations/InstalledIntegrationService.js');
      const instances = installedIntegrationService.instancesOf(dirNameToDefinitionId(name));
      if (instances.length > 0) {
        const error = new Error(
          `integration '${name}' is still installed as ${instances.map(i => `'${i.id}'`).join(', ')}; remove those first`
        );
        error.code = 'INTEGRATION_IN_USE';
        throw error;
      }
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
    if (type === 'skill' && isSystemSkill(name)) {
      throw new Error(`skill '${name}' is a system skill of iHub and cannot be replaced`);
    }
    if (type === 'integration') {
      const definitionId = dirNameToDefinitionId(name);
      await integrationRegistry.writeInstalled(definitionId, content.files);
      // Installations of a re-installed definition keep cached parameter
      // schemas of the old document otherwise, their scope providers keep
      // the old definition until they are registered again, and the MCP
      // client manager keeps serving the old endpoint until the adapters are
      // told (`notifyDefinitionsChanged`). The definition is on disk at this
      // point, so a failing refresh is logged and the install still records
      // itself (as `_afterChange` does).
      try {
        const [
          { default: installedIntegrationService },
          { invalidate },
          { notifyDefinitionsChanged },
          { syncIntegrationScopeProviders }
        ] = await Promise.all([
          import('../integrations/InstalledIntegrationService.js'),
          import('../integrations/protocols/openapi/OpenApiAdapter.js'),
          import('../integrations/protocols/index.js'),
          import('../integrations/integrationTools.js')
        ]);
        for (const instance of installedIntegrationService.instancesOf(definitionId)) {
          invalidate(instance.id);
        }
        await notifyDefinitionsChanged({ definitionIds: [definitionId] });
        await syncIntegrationScopeProviders();
      } catch (error) {
        logger.warn(
          'Installed integration definition written, but its installations could not be refreshed',
          {
            component: COMPONENT,
            definitionId,
            error: error.message
          }
        );
      }
      return;
    }
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
    if (type === 'integration') {
      await integrationRegistry.removeInstalled(dirNameToDefinitionId(name));
      return;
    }
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
