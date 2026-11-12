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

import { ServiceError } from '../../utils/ServiceError.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import configStore from '../../services/config/ConfigStore.js';
import { isValidId, resolveAndValidatePath } from '../../utils/pathSecurity.js';
import registryService from './RegistryService.js';
import { getLocalContentIds } from './localContent.js';
import {
  MARKETPLACE_TARGET_BLOCKED,
  marketplaceFetch,
  sharesCredentialScope
} from './marketplaceFetch.js';
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
  checkMigrationModuleFiles,
  checkScriptCodeFiles,
  matchesIntegrity
} from '../integrations/definitions/scriptModule.js';
import { listedVersions, offeredVersion, passesPolicy, versionPolicyFor } from './versionPolicy.js';
import semver from 'semver';
import {
  validateIntegrationDefinition,
  definitionSchemaRevision,
  unsupportedSchemaMessage,
  definitionIdToDirName,
  dirNameToDefinitionId
} from '../../validators/integrationDefinitionSchema.js';
import {
  checkCompatibility,
  describeIncompatibility
} from '../integrations/definitions/compatibility.js';

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
      assertKnownDefinitionSchema(typeof raw === 'string' ? JSON.parse(raw) : raw);
      const parsed = validateIntegrationDefinition(typeof raw === 'string' ? JSON.parse(raw) : raw);
      if (!parsed.success) {
        return {
          success: false,
          errors: parsed.errors.map(e => `${e.path.join('.')}: ${e.message}`)
        };
      }
      // A fixed tool id (`toolId`) addresses a tool on this server: only the
      // definitions iHub ships and the custom integrations built here may
      // keep one. A registry's definition gets `<installation>__<action>`.
      const fixed = (parsed.data.actions || []).filter(a => a.toolId).map(a => a.name);
      if (fixed.length && !parsed.data.builtIn) {
        return {
          success: false,
          errors: [
            `actions: a definition from a registry cannot fix tool ids (${fixed.join(', ')})`
          ]
        };
      }
      return { success: true };
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
    throw new ServiceError(
      'CONTENT_VALIDATION_FAILED',
      `Content validation failed: ${errors.join(', ')}`
    );
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
 * Change the installations manifest: read it fresh, apply `mutate`, write it,
 * in one step that no other install, update or uninstall (on this worker or
 * another) interleaves with, then refresh the cache.
 *
 * Installing, updating and uninstalling fetch from the network and write content
 * files between reading the manifest and recording the result. Writing back the
 * snapshot taken before that erased the entries other operations recorded in the
 * meantime, which left their files on disk with nothing tracking them. Do the
 * slow work first, then call this with a pure change.
 *
 * `mutate` may run more than once and edits the body it is given; it may throw
 * (nothing is written then).
 *
 * @param {(data: { installations: Record<string, object> }) => void} mutate
 * @returns {Promise<{ installations: Record<string, object> }>} The stored manifest
 */
async function updateInstallations(mutate) {
  const { data } = await configStore.updateJson(INSTALLATIONS_FILE, current => {
    const body = current && typeof current === 'object' ? current : {};
    if (!body.installations || typeof body.installations !== 'object') body.installations = {};
    mutate(body);
    return body;
  });
  const cc = await getConfigCache();
  await cc.refreshInstallationsCache();
  return data;
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
 * @param {{ version?: string }} [options] - `version`: a version the item
 *   lists other than its current one; its descriptor (`versions[].ref`) is
 *   fetched and the content comes from there (`RegistryService.fetchItemVersion`)
 * @returns {Promise<{ item: object, content: object }>}
 *   The matching catalog item descriptor (of the version fetched) and its content
 * @throws {Error} When the catalog is not cached, item is not found, or the fetch fails
 */
export async function fetchItemContent(registryId, type, name, { version } = {}) {
  const registry = await registryService.getRegistryWithAuth(registryId);
  const cached = await registryService.getCachedCatalogAsync(registryId);

  if (!cached) {
    throw new Error(
      `No cached catalog for registry '${registryId}'. Please refresh the registry first.`
    );
  }

  const current = (cached.catalog?.items || []).find(i => i.type === type && i.name === name);
  if (!current)
    throw new ServiceError(
      'NOT_FOUND',
      `Item '${type}:${name}' not found in registry '${registryId}'`
    );
  const item =
    version && version !== current.version
      ? await registryService.fetchItemVersion(registry, current, version)
      : current;

  const itemUrl = registryService.resolveItemUrl(item, registry);
  if (!itemUrl) throw new Error(`Cannot resolve URL for item '${type}:${name}'`);

  // Build auth headers from the (already decrypted) registry config. They go only to the host the
  // registry itself is on (or the GitHub pair for a GitHub registry): an item URL elsewhere, such
  // as a plugin skill on raw.githubusercontent.com listed by a registry on another host, gets none.
  const authHeaders = sharesCredentialScope(itemUrl, [registry.source])
    ? authHeadersFor(registry)
    : {};

  // The item's manifest is fetched like any other marketplace file: the
  // registry's own host as it is, any other host only on a public address.
  const response = await marketplaceFetch('marketplace-installer', itemUrl, {
    registry,
    headers: { Accept: 'application/json, text/plain, application/vnd.github.raw+json' },
    authHeaders
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

  const text = await response.text();

  let responseData;
  try {
    responseData = JSON.parse(text);
  } catch {
    // Non-JSON content (e.g., SKILL.md markdown) — check for companion files
    return { item, content: await buildSkillContent(item, itemUrl, text, authHeaders, registry) };
  }

  // GitHub Contents API wraps file content in base64
  if (responseData && responseData.content && responseData.encoding === 'base64') {
    const decoded = Buffer.from(responseData.content.replaceAll('\n', ''), 'base64').toString(
      'utf8'
    );
    try {
      responseData = JSON.parse(decoded);
    } catch {
      return {
        item,
        content: await buildSkillContent(item, itemUrl, decoded, authHeaders, registry)
      };
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

/**
 * Code travels only from a registry the admin trusts for it, and only with a
 * hash per code file in the catalog, which the fetched file must match. Every
 * hash the catalog lists is checked, whatever the file. A `script` definition
 * brings exactly one connector file, its bundled module (`checkScriptCodeFiles`),
 * and any definition the migration modules its `module` steps name
 * (`checkMigrationModuleFiles`), each one bundled file as well.
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
      throw new ServiceError(
        'CODE_NOT_TRUSTED',
        `Integration '${item.name}' brings code that runs on this server; the registry ` +
          `'${registry?.id || ''}' is not trusted for code. Mark the registry as trusted ` +
          'for code to install it.'
      );
    }
    const unhashed = codeFiles.filter(file => !integrity[file]);
    if (unhashed.length) {
      throw new ServiceError(
        'CODE_INTEGRITY_REQUIRED',
        `Integration '${item.name}': the catalog lists no hash for the code file(s) ${unhashed.join(', ')}`
      );
    }
    if (isScript) checkScriptCodeFiles(definition, content.files);
  }
  if (definition && typeof definition === 'object') {
    checkMigrationModuleFiles(definition, content.files);
  }
  for (const [file, expected] of Object.entries(integrity)) {
    const text = content.files[file];
    if (typeof text !== 'string') continue;
    if (!matchesIntegrity(text, expected)) {
      throw new ServiceError(
        'INTEGRITY_MISMATCH',
        `Integration '${item.name}': the file ${file} does not match the hash the catalog lists`
      );
    }
  }
}

/**
 * Build the folder of an integration definition: `integration.json` plus the
 * companions the catalog lists and the files the definition itself names
 * (its OpenAPI document, icon, release notes and example apps, when relative).
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
  const referenced = [
    definition?.protocol?.document,
    definition?.icon,
    ...releaseNotePaths(definition),
    ...exampleAppPaths(definition)
  ].filter(value => typeof value === 'string' && value && !/^https?:\/\//i.test(value));
  const companions = [...new Set([...listed, ...referenced])];
  const files = { 'integration.json': definition };
  for (const relativePath of companions) {
    if (relativePath === 'integration.json') continue;
    files[relativePath] = await fetchIntegrationCompanionText(
      relativePath,
      item,
      itemUrl,
      authHeaders,
      registry
    );
  }
  return { files };
}

/** The example app files a definition names (`exampleApps[].file`). */
export function exampleAppPaths(definition) {
  return (Array.isArray(definition?.exampleApps) ? definition.exampleApps : [])
    .map(entry => entry?.file)
    .filter(file => typeof file === 'string' && file);
}

/** The release-note files a definition names (`releases[].notes.*`). */
export function releaseNotePaths(definition) {
  const paths = [];
  for (const release of Array.isArray(definition?.releases) ? definition.releases : []) {
    for (const value of Object.values(release?.notes || {})) {
      if (typeof value === 'string' && value) paths.push(value);
    }
  }
  return paths;
}

/**
 * The URL of a companion file of an integration item: a sibling of
 * integration.json, or under the raw base the catalog names (`source.rawBase`,
 * as the GitHub registries do). A `?ref=<branch>` of a GitHub Contents URL
 * belongs to every sibling too.
 *
 * @param {string} relativePath
 * @param {object} item - Catalog item
 * @param {string} itemUrl - URL integration.json is fetched from
 * @returns {string}
 */
export function integrationCompanionUrl(relativePath, item, itemUrl) {
  const [itemPath, query = ''] = itemUrl.split('?');
  const rawBase = typeof item.source?.rawBase === 'string' ? item.source.rawBase : '';
  const baseUrl = rawBase ? rawBase.replace(/\/$/, '') : itemPath.replace(/\/[^/]*$/, '');
  return `${baseUrl}/${relativePath}${query ? `?${query}` : ''}`;
}

/**
 * Fetch one companion file of an integration item as text. The registry's
 * credentials travel only where the registry itself lives
 * (`sharesCredentialScope`); a `rawBase` elsewhere is fetched without them,
 * and only when it is the registry's own host or a public address
 * (`marketplaceFetch`).
 *
 * @param {string} relativePath
 * @param {object} item - Catalog item
 * @param {string} itemUrl - URL integration.json is fetched from
 * @param {Record<string, string>} authHeaders
 * @param {object} [registry] - Registry config (`source` names its own host)
 * @returns {Promise<string>}
 */
async function fetchIntegrationCompanionText(relativePath, item, itemUrl, authHeaders, registry) {
  const companionUrl = integrationCompanionUrl(relativePath, item, itemUrl);
  const trusted = sharesCredentialScope(companionUrl, [itemUrl, registry?.source]);
  if (!trusted) {
    logger.warn('Companion file is fetched without the registry credentials', {
      component: COMPONENT,
      companionUrl,
      itemUrl
    });
  }
  const res = await marketplaceFetch('marketplace-installer', companionUrl, {
    registry,
    headers: { Accept: 'text/plain, application/json, application/vnd.github.raw+json' },
    authHeaders: trusted ? authHeaders : {}
  });
  if (!res.ok) {
    throw new Error(`Companion file '${relativePath}' could not be fetched (HTTP ${res.status})`);
  }
  return unwrapGitHubContent(await res.text());
}

/** Companion files the admin UI may read from a catalog item: Markdown only. */
const SERVED_COMPANION_PATTERN =
  /^(?!\.)(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*\.md$/i;
const MAX_SERVED_COMPANION_BYTES = 512 * 1024;

/**
 * A Markdown companion file of an integration catalog item (release notes,
 * README), fetched from the registry with the same credential scoping as an
 * install, without installing anything. Only a path the catalog itself lists
 * (`source.companions` or a release's `notes`) is served, so the endpoint is
 * no proxy for arbitrary URLs. Returns null for a path the item does not
 * list, a non-Markdown file or a missing file.
 *
 * @param {string} registryId
 * @param {string} name - Catalog item name (the definition folder name)
 * @param {string} relativePath
 * @returns {Promise<string|null>}
 */
export async function fetchIntegrationCompanion(registryId, name, relativePath) {
  if (typeof relativePath !== 'string' || !SERVED_COMPANION_PATTERN.test(relativePath)) {
    return null;
  }
  const registry = await registryService.getRegistryWithAuth(registryId);
  const cached = await registryService.getCachedCatalogAsync(registryId);
  if (!cached) {
    throw new Error(
      `No cached catalog for registry '${registryId}'. Please refresh the registry first.`
    );
  }
  const item = (cached.catalog?.items || []).find(i => i.type === 'integration' && i.name === name);
  if (!item)
    throw new ServiceError(
      'NOT_FOUND',
      `Item 'integration:${name}' not found in registry '${registryId}'`
    );
  const listed = new Set([
    ...(Array.isArray(item.source?.companions) ? item.source.companions : []),
    ...releaseNotePaths(item)
  ]);
  if (!listed.has(relativePath)) return null;
  const itemUrl = registryService.resolveItemUrl(item, registry);
  if (!itemUrl) throw new Error(`Cannot resolve URL for item 'integration:${name}'`);
  let text;
  try {
    text = await fetchIntegrationCompanionText(
      relativePath,
      item,
      itemUrl,
      authHeadersFor(registry),
      registry
    );
  } catch (error) {
    if (/HTTP 404/.test(error.message)) return null;
    throw error;
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_SERVED_COMPANION_BYTES) {
    throw new Error(`Companion file '${relativePath}' exceeds the 512KB size limit`);
  }
  return text;
}

/**
 * Authorization headers from a registry's (decrypted) auth config.
 * @param {object} registry
 * @returns {Record<string, string>}
 */
function authHeadersFor(registry) {
  const auth = registry?.auth;
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
  return authHeaders;
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
 * A missing or unreachable companion is left out with a warning, as before;
 * a companion on a host the registry may not send the server to
 * (`MARKETPLACE_TARGET_BLOCKED`) fails the whole fetch, so the admin sees
 * which host the catalog pointed at.
 *
 * @param {object} item - Catalog item descriptor (may have source.companions)
 * @param {string} itemUrl - Where the SKILL.md was fetched from; the companions
 *   sit next to it, whether the item's source is a `url` or a path relative to
 *   the registry
 * @param {string} skillMd - Raw SKILL.md content
 * @param {Record<string, string>} authHeaders - Auth headers for companion fetches
 * @param {object} registry - Registry config (`source` names its own host)
 * @returns {Promise<string|{ files: Record<string, string> }>}
 * @throws {import('./marketplaceFetch.js').MarketplaceTargetError} When a companion's host is refused
 */
async function buildSkillContent(item, itemUrl, skillMd, authHeaders, registry) {
  let companions = item.source?.companions;

  // Fallback: discover companions at install time if cache is stale (no companions field). An
  // empty list is an answer, not a stale cache: the catalog found no (text) companion files.
  if (
    !Array.isArray(companions) &&
    item.source?.type === 'url' &&
    item.source.url?.endsWith('/SKILL.md')
  ) {
    try {
      companions = await registryService.discoverCompanions(item.source.url, authHeaders, registry);
    } catch (error) {
      if (error.code === MARKETPLACE_TARGET_BLOCKED) throw error;
      logger.warn('Companion discovery fallback failed', { component: COMPONENT, error });
    }
  }

  if (!companions || companions.length === 0) return skillMd;

  // Derive skill directory URL from the SKILL.md URL (strip the filename).
  // A `relative` source has no `source.url`, so this is the resolved item URL.
  const skillDirUrl = itemUrl.replace(/[?#].*$/, '').replace(/\/SKILL\.md$/, '');

  const files = { 'SKILL.md': skillMd };

  await Promise.all(
    companions.map(async relativePath => {
      const companionUrl = `${skillDirUrl}/${relativePath}`;
      try {
        const res = await marketplaceFetch('marketplace-installer', companionUrl, {
          registry,
          headers: { Accept: 'text/plain, application/vnd.github.raw+json, */*' },
          authHeaders
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
        if (error.code === MARKETPLACE_TARGET_BLOCKED) throw error;
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

/**
 * Refuse a definition written for a format revision this server does not
 * know, read from the raw document before any other field is looked at.
 *
 * @param {object} raw - parsed integration.json
 * @throws {Error} with `code: 'UNSUPPORTED_DEFINITION_SCHEMA'`
 */
export function assertKnownDefinitionSchema(raw) {
  const revision = definitionSchemaRevision(raw);
  if (revision.supported) return;
  throw new ServiceError(
    'UNSUPPORTED_DEFINITION_SCHEMA',
    `Content validation failed: ${unsupportedSchemaMessage(revision.revision)}`,
    { details: { revision: revision.revision } }
  );
}

/**
 * Refuse an item this server version cannot run. The catalog item's
 * `compatibility.ihub` (or `minVersion`) is checked first, so nothing is
 * fetched for an item the catalog already marks; for an integration the
 * fetched definition's own `compatibility` is checked too, since the
 * definition is what the registry will load.
 *
 * @param {string} type
 * @param {string} name
 * @param {object} subject - Catalog item or integration definition
 * @throws {Error} with `code: 'INCOMPATIBLE_IHUB_VERSION'`
 */
export function assertCompatible(type, name, subject) {
  const { compatible, requires, serverVersion } = checkCompatibility(subject);
  if (compatible) return;
  throw new ServiceError(
    'INCOMPATIBLE_IHUB_VERSION',
    `${type} '${name}' ${describeIncompatibility(requires, serverVersion)}`,
    { details: { requires, serverVersion } }
  );
}

/**
 * The hashes of the code files an integration package brings, from the
 * catalog item it was fetched with: what the installation manifest records as
 * `codeIntegrity`, so a migration module run later (a re-run, a manual
 * migration) is checked against the hash the catalog listed at install time.
 *
 * @param {object} item - catalog item (of the version installed)
 * @param {{ files: Record<string, string|object> }} content
 * @returns {Record<string, string>|null} path → hash, null without code files
 */
export function codeIntegrityOf(item, content) {
  const integrity = item?.source?.integrity || {};
  const entries = Object.keys(content?.files || {})
    .filter(file => CODE_FILE_PATTERN.test(file) && typeof integrity[file] === 'string')
    .sort((a, b) => a.localeCompare(b))
    .map(file => [file, integrity[file]]);
  return entries.length ? Object.fromEntries(entries) : null;
}

/**
 * The version an install or update takes (versioning phase 3): the one the
 * admin named, which must be listed and pass the registry's channel and the
 * item's pin, or else the version the registry offers
 * (`versionPolicy.offeredVersion`). An item that lists no version at all is
 * installed as it is (undefined).
 *
 * @param {object|null} registry - registry config
 * @param {object} item - the cached catalog item
 * @param {string} [requested]
 * @returns {string|undefined}
 * @throws {Error} `VERSION_NOT_LISTED`, `VERSION_NOT_OFFERED` or `NO_VERSION_OFFERED`
 */
export function resolveRequestedVersion(registry, item, requested) {
  const listed = listedVersions(item);
  const policy = versionPolicyFor(registry, item.type, item.name);
  const label = `${item.type} '${item.name}'`;
  if (requested) {
    if (!listed.includes(requested)) {
      throw new ServiceError(
        'VERSION_NOT_LISTED',
        `${label}: version ${requested} is not listed by the registry`
      );
    }
    if (!passesPolicy(requested, policy)) {
      throw new ServiceError(
        'VERSION_NOT_OFFERED',
        `${label}: version ${requested} is outside what the registry offers (channel ${policy.channel}${policy.pin ? `, pin ${policy.pin}` : ''})`
      );
    }
    return requested;
  }
  if (listed.length === 0) return undefined;
  const offered = offeredVersion(item, registry);
  if (!offered) {
    throw new ServiceError(
      'NO_VERSION_OFFERED',
      `${label}: no listed version passes the registry's channel ${policy.channel}${policy.pin ? ` and the pin ${policy.pin}` : ''}`
    );
  }
  return offered;
}

/**
 * The package of one version of an installed integration definition, fetched
 * from the registry it was installed from (versioning phase 3: the runner keeps
 * the definition folder of every migration boundary it passes, so an admin
 * can revert to that version later). Checked like an install
 * (`verifyIntegrationCode`). Null when the definition was not installed from
 * a registry or the registry does not list the version.
 *
 * @param {string} definitionId
 * @param {string} version
 * @returns {Promise<{ files: Record<string, string|object>, manifestEntry: object }|null>}
 */
export async function fetchIntegrationVersionPackage(definitionId, version) {
  const key = `integration:${definitionIdToDirName(definitionId)}`;
  const installations = await configStore.readJson(INSTALLATIONS_FILE);
  const manifest = installations?.installations?.[key];
  if (!manifest?.registryId) return null;
  const catalogItem = await cachedCatalogItem(manifest.registryId, 'integration', manifest.itemId);
  if (!catalogItem || !listedVersions(catalogItem).includes(version)) return null;
  const { item, content } = await fetchItemContent(
    manifest.registryId,
    'integration',
    manifest.itemId,
    { version }
  );
  if (content.files['integration.json']?.version !== version) return null;
  return {
    files: content.files,
    manifestEntry: {
      ...manifest,
      version,
      codeIntegrity: codeIntegrityOf(item, content)
    }
  };
}

/**
 * The catalog item of an installed or installable item, from the cached
 * catalog; null when the catalog is not cached or the item is gone.
 */
async function cachedCatalogItem(registryId, type, name) {
  const cached = await registryService.getCachedCatalogAsync(registryId);
  return (cached?.catalog?.items || []).find(i => i.type === type && i.name === name) || null;
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
   * @param {{ replaceLocal?: boolean, version?: string }} [options] - `replaceLocal: true` confirms
   *   replacing an item that already exists on this instance; `version` names a
   *   listed version (default: the version the registry offers, its channel and
   *   the item's pin applied)
   * @returns {Promise<object>} The installation manifest entry
   * @throws {Error} On validation failure, duplicate installation, fetch error,
   *   or — with `code: 'LOCAL_CONTENT_EXISTS'` — an unconfirmed local item;
   *   `VERSION_NOT_LISTED`, `VERSION_NOT_OFFERED`, `NO_VERSION_OFFERED` for a
   *   version the registry does not offer
   */
  async install(
    registryId,
    type,
    name,
    installedBy = 'admin',
    { replaceLocal = false, version: requestedVersion } = {}
  ) {
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
      throw new ServiceError(
        'CONFLICT',
        `${type} '${name}' is already installed. Use update to upgrade.`
      );
    }

    // The same id may already exist here without the marketplace knowing it,
    // e.g. a shipped default. Installing writes over it, so that takes an
    // explicit confirmation.
    const localIds = getLocalContentIds(await getConfigCache());
    if (localIds[type]?.has(name) && !replaceLocal) {
      throw new ServiceError(
        'LOCAL_CONTENT_EXISTS',
        `${type} '${name}' already exists on this instance and was not installed from the ` +
          'marketplace. Installing replaces it; confirm the replacement to continue.'
      );
    }

    // An item this server version cannot run is refused before anything is
    // fetched (the UI greys it out; this holds for a direct API call too).
    const catalogItem = await cachedCatalogItem(registryId, type, name);
    const version = catalogItem
      ? resolveRequestedVersion(
          await registryService.getRegistryWithAuth(registryId),
          catalogItem,
          requestedVersion
        )
      : undefined;
    // The catalog describes its current version; another version is checked
    // against its own descriptor once it is fetched.
    if (catalogItem && (!version || version === catalogItem.version)) {
      assertCompatible(type, name, catalogItem);
    }

    const { item, content } = await fetchItemContent(registryId, type, name, { version });
    if (item !== catalogItem) assertCompatible(type, name, item);

    // Validate the fetched content against the schema for this type
    assertValidContent(type, name, content, config);

    if (type === 'integration') {
      // The catalog name is the definition's folder name; the definition
      // inside must agree, or two registries could fight over one folder.
      const definitionId = content.files['integration.json']?.id;
      if (definitionIdToDirName(definitionId || '') !== name) {
        throw new ServiceError(
          'CONTENT_VALIDATION_FAILED',
          `Content validation failed: definition id '${definitionId}' does not match the catalog name '${name}'`
        );
      }
      assertCompatible(type, name, content.files['integration.json']);
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
    if (type === 'integration') {
      const codeIntegrity = codeIntegrityOf(item, content);
      if (codeIntegrity) manifest.codeIntegrity = codeIntegrity;
    }

    // Re-checked on the fresh manifest: of two installs of the same item only one
    // records it, and neither erases the entry of a different item.
    await updateInstallations(data => {
      if (data.installations[key]) {
        throw new ServiceError(
          'CONFLICT',
          `${type} '${name}' is already installed. Use update to upgrade.`
        );
      }
      data.installations[key] = manifest;
    });

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
      throw new ServiceError('NOT_FOUND', `${type} '${name}' is not installed`);
    }

    if (type === 'integration') {
      const { default: installedIntegrationService } =
        await import('../integrations/InstalledIntegrationService.js');
      const instances = installedIntegrationService.instancesOf(dirNameToDefinitionId(name));
      if (instances.length > 0) {
        throw new ServiceError(
          'INTEGRATION_IN_USE',
          `integration '${name}' is still installed as ${instances.map(i => `'${i.id}'`).join(', ')}; remove those first`
        );
      }
    }

    await this._deleteContent(type, name, config);

    await updateInstallations(data => {
      delete data.installations[key];
    });

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
   * @param {{ version?: string }} [options] - `version` names a listed version
   *   (default: the version the registry offers, its channel and the item's pin
   *   applied); it must not be older than the installed one (going back is a
   *   Revert of the installation, not an update)
   * @returns {Promise<object>} The updated installation manifest entry
   * @throws {Error} When the item is not tracked in the installations manifest;
   *   `VERSION_NOT_LISTED`, `VERSION_NOT_OFFERED`, `NO_VERSION_OFFERED`,
   *   `VERSION_NOT_NEWER` for a version the update does not take
   */
  async update(type, name, updatedBy = 'admin', { version: requestedVersion } = {}) {
    logger.info('Updating content item', { component: COMPONENT, type, name });

    const installations = await readInstallations();
    const key = `${type}:${name}`;
    const existing = installations.installations[key];

    if (!existing) throw new ServiceError('NOT_FOUND', `${type} '${name}' is not installed`);

    const config = CONTENT_CONFIG[type];
    if (!config) throw new Error(`Unknown content type: ${type}`);

    if (!isValidId(name)) {
      throw new Error(
        `Invalid content name: only alphanumeric characters, dots, underscores, and hyphens are allowed`
      );
    }

    const catalogItem = await cachedCatalogItem(existing.registryId, type, name);
    const registry = catalogItem
      ? await registryService.getRegistryWithAuth(existing.registryId)
      : null;
    const version = catalogItem
      ? resolveRequestedVersion(registry, catalogItem, requestedVersion)
      : undefined;
    if (
      version &&
      semver.valid(version) &&
      semver.valid(existing.version) &&
      semver.lt(version, existing.version)
    ) {
      throw new ServiceError(
        'VERSION_NOT_NEWER',
        `${type} '${name}' is installed at ${existing.version}; ${version} is older. An update only moves forward: revert the installation to a backup of ${version} instead`
      );
    }
    if (catalogItem && (!version || version === catalogItem.version)) {
      assertCompatible(type, name, catalogItem);
    }

    const { item, content } = await fetchItemContent(existing.registryId, type, name, {
      version
    });
    if (item !== catalogItem) assertCompatible(type, name, item);

    assertValidContent(type, name, content, config);
    if (type === 'integration') {
      assertCompatible(type, name, content.files['integration.json']);
      return this._updateIntegration(name, key, existing, item, content, updatedBy, registry);
    }

    await this._writeContent(type, name, content, config);

    const patch = {
      updatedAt: new Date().toISOString(),
      updatedBy,
      version: item.version || existing.version,
      updateAvailable: null
    };
    const stored = await updateInstallations(data => {
      if (!data.installations[key]) {
        throw new ServiceError('NOT_FOUND', `${type} '${name}' is not installed`);
      }
      Object.assign(data.installations[key], patch);
    });
    Object.assign(existing, stored.installations[key]);

    const cc = await getConfigCache();
    if (typeof cc[config.cacheRefresh] === 'function') {
      await cc[config.cacheRefresh]();
    }

    logger.info('Content item updated', { component: COMPONENT, type, name });
    return existing;
  }

  /**
   * Update an installed integration definition together with its
   * installations (versioning concept §3, trigger 1): the new folder is
   * staged, every installation of the definition is migrated against it
   * under its lock, and the folder, the migrated installations, their apps
   * and this manifest entry are committed together by the definition
   * migration runner — no worker ever sees the new definition with old
   * values. An installation whose migration fails is marked
   * `migrationFailed` in the same commit; a failing commit leaves the
   * previous folder and every value as it was, and the update throws.
   *
   * @param {string} name - catalog item name (the definition folder name)
   * @param {string} key - manifest key (`integration:<name>`)
   * @param {object} existing - the manifest entry
   * @param {object} item - the catalog item
   * @param {{ files: Record<string, string|object> }} content - the fetched package
   * @param {string} updatedBy
   * @param {object|null} [registry] - the registry config (`trustCode` decides
   *   whether migration modules of the package may run)
   * @returns {Promise<object>} the updated manifest entry with `integrationMigrations`,
   *   one result per installation (`migrated`, `stamped`, `failed` or `skipped`)
   */
  async _updateIntegration(name, key, existing, item, content, updatedBy, registry = null) {
    const manifestPatch = {
      updatedAt: new Date().toISOString(),
      updatedBy,
      version: item.version || existing.version,
      updateAvailable: null,
      codeIntegrity: codeIntegrityOf(item, content)
    };
    const definitionId = dirNameToDefinitionId(name);
    const { default: definitionMigrationRunner } =
      await import('../integrations/definitions/DefinitionMigrationRunner.js');
    // The intermediate versions an update passes are fetched (once each) for
    // the backups the runner keeps at every migration boundary.
    const fetched = new Map();
    const fetchDefinitionVersion = version => {
      if (!fetched.has(version)) {
        fetched.set(version, fetchIntegrationVersionPackage(definitionId, version));
      }
      return fetched.get(version);
    };
    const outcome = await definitionMigrationRunner.applyDefinitionUpdate({
      definitionId,
      files: content.files,
      manifestKey: key,
      manifestPatch,
      by: updatedBy,
      moduleTrust: {
        trustCode: registry?.trustCode === true,
        integrity: item.source?.integrity || {}
      },
      fetchDefinitionVersion
    });
    Object.assign(existing, manifestPatch);
    const cc = await getConfigCache();
    await cc.refreshInstallationsCache?.();
    logger.info('Content item updated', {
      component: COMPONENT,
      type: 'integration',
      name,
      migrations: outcome.installations.map(result => `${result.id}:${result.result}`)
    });
    return { ...existing, integrationMigrations: outcome.installations };
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

    await updateInstallations(data => {
      delete data.installations[key];
    });

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
