// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../../../utils/logger.js';
import { announceConfigChange } from '../../../configSync.js';
import { getContentsPath } from '../../../utils/contentsPath.js';
import { resolveAndValidatePath } from '../../../utils/pathSecurity.js';
import {
  INTEGRATION_ID_PATTERN,
  validateIntegrationDefinition,
  dirNameToDefinitionId,
  definitionIdToDirName
} from '../../../validators/integrationDefinitionSchema.js';
import { parseOpenApiText } from '../../tools/openApiText.js';

/**
 * Loads integration definitions (the catalog) from two trees:
 *
 * - shipped: `server/defaults/integration-definitions/<dir>/integration.json`
 * - installed: `contents/integration-definitions/<dir>/integration.json`
 *   (written by the marketplace or by hand)
 *
 * An installed definition with the same id wins over the shipped one. Each
 * definition folder may carry companion files; for the `openapi` protocol the
 * OpenAPI document named in `protocol.document` is read and parsed here so the
 * adapters never touch the filesystem.
 *
 * The two trees are never seeded into each other: `integration-definitions/`
 * is on the import-only list of `utils/setupUtils.js`.
 */

const COMPONENT = 'IntegrationRegistry';
/** Cache key the cluster announcement travels under (see `_announce`). */
export const INTEGRATIONS_CONFIG_KEY = 'config/integrations.json';
const DEFINITION_FILE = 'integration.json';
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

const defaultShippedDir = fileURLToPath(
  new URL('../../../defaults/integration-definitions/', import.meta.url)
);

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

export class IntegrationRegistry {
  /**
   * @param {{ shippedDir?: string, contentsDir?: string }} [options]
   */
  constructor(options = {}) {
    this.shippedDir = options.shippedDir || defaultShippedDir;
    this.contentsDirOverride = options.contentsDir;
    /** @type {Map<string, object>} id → entry */
    this.entries = new Map();
    this.loaded = false;
    this.loading = null;
  }

  get contentsDir() {
    return this.contentsDirOverride || getContentsPath('integration-definitions');
  }

  /**
   * Load both trees. Concurrent callers share one load; a caller that arrives
   * while a load runs gets one more load after it, so a write made during the
   * running load is seen.
   */
  async reload() {
    if (this.loading) {
      this.pending ??= this.loading.then(() => {
        this.pending = null;
        return this.reload();
      });
      return this.pending;
    }
    this.loading = (async () => {
      const entries = new Map();
      for (const entry of await this._loadTree(this.shippedDir, 'shipped')) {
        entries.set(entry.definition.id, entry);
      }
      for (const entry of await this._loadTree(this.contentsDir, 'installed')) {
        entries.set(entry.definition.id, entry);
      }
      this.entries = entries;
      this.loaded = true;
      logger.info('Integration definitions loaded', {
        component: COMPONENT,
        count: entries.size,
        ids: [...entries.keys()]
      });
      return entries;
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  async ensureLoaded() {
    if (!this.loaded) await this.reload();
  }

  /**
   * @returns {Array<object>} every valid entry: `{ definition, source, dir, document? }`
   */
  list() {
    return [...this.entries.values()];
  }

  /** The definition with this id, or null. */
  get(id) {
    return this.entries.get(id) || null;
  }

  /** Whether a definition is installed from a registry (lives under contents). */
  isInstalled(id) {
    return this.entries.get(id)?.source === 'installed';
  }

  /**
   * Write an installed definition folder from a map of relative paths to
   * contents (text or JSON), replacing what was there. Used by the marketplace.
   *
   * @param {string} id - definition id (validated against the files' integration.json)
   * @param {Record<string, string|object>} files - relative path → content
   */
  async writeInstalled(id, files) {
    const definitionFile = files[DEFINITION_FILE];
    if (!definitionFile) throw new Error(`${DEFINITION_FILE} is missing`);
    const raw = typeof definitionFile === 'string' ? JSON.parse(definitionFile) : definitionFile;
    const validation = validateIntegrationDefinition(raw);
    if (!validation.success) {
      const details = validation.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
      throw new Error(`Invalid integration definition: ${details}`);
    }
    if (validation.data.id !== id) {
      throw new Error(`Definition id "${validation.data.id}" does not match "${id}"`);
    }
    if (validation.data.protocol.type === 'mcp-stdio') {
      throw new Error('Local (stdio) integrations cannot be installed from a registry');
    }
    const dir = await this._installedDir(id);
    // Written to a staging folder first: a bad companion path, a failed write
    // or an unreadable OpenAPI document must not have touched the working
    // folder. The working folder is moved aside, not deleted, until the
    // staging folder is in place, so a failed swap restores it. Both helper
    // folders are dot-prefixed, so a leftover is never loaded.
    const stamp = `${process.pid}-${Date.now()}`;
    const staging = path.join(this.contentsDir, `.staging-${stamp}`);
    const backup = path.join(this.contentsDir, `.backup-${stamp}`);
    await fs.mkdir(staging, { recursive: true });
    try {
      for (const [relPath, content] of Object.entries(files)) {
        const target = await resolveAndValidatePath(relPath, staging);
        if (!target) throw new Error(`Path traversal detected in integration file: ${relPath}`);
        await fs.mkdir(path.dirname(target), { recursive: true });
        const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
        await fs.writeFile(target, text, 'utf8');
      }
      const { type, document } = validation.data.protocol;
      if (type === 'openapi' && !isHttpUrl(document)) {
        await this._readDocument(staging, document);
      }
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
    const hadPrevious = await this._moveAside(dir, backup);
    try {
      await this._swapIn(staging, dir);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      if (hadPrevious) await fs.rename(backup, dir);
      throw error;
    }
    if (hadPrevious) await fs.rm(backup, { recursive: true, force: true });
    await this.reload();
    this._announce();
    return this.get(id);
  }

  /**
   * Tell the other workers. The registry is a per-process singleton, so a
   * folder written here is unknown to them until they reload it; the
   * announcement travels under the installed-integrations key, whose change
   * hook (server.js) reloads the registry and re-syncs what derives from it.
   */
  _announce() {
    announceConfigChange(INTEGRATIONS_CONFIG_KEY);
  }

  /** Remove an installed definition folder. */
  async removeInstalled(id) {
    const dir = await this._installedDir(id);
    await fs.rm(dir, { recursive: true, force: true });
    await this.reload();
    this._announce();
  }

  /** Move the working folder to `backup`; false when there was none. */
  async _moveAside(dir, backup) {
    try {
      await fs.rename(dir, backup);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  /** Put the staged folder in place (a seam for the swap-failure test). */
  async _swapIn(staging, dir) {
    await fs.rename(staging, dir);
  }

  /**
   * The folder of an installed definition, from an id that must match the
   * id grammar and resolve inside the contents tree.
   */
  async _installedDir(id) {
    if (!INTEGRATION_ID_PATTERN.test(id || '')) {
      throw new Error(`Invalid integration definition id: ${id}`);
    }
    // The id grammar leaves no separators or ".." for the folder name; the
    // containment check is the second lock (the contents tree may not exist
    // yet, so no realpath here).
    const root = path.resolve(this.contentsDir);
    const dir = path.resolve(root, definitionIdToDirName(id));
    if (!dir.startsWith(root + path.sep)) {
      throw new Error(`Invalid integration definition id: ${id}`);
    }
    return dir;
  }

  async _loadTree(root, source) {
    let dirents;
    try {
      dirents = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      logger.warn('Cannot read integration definitions directory', {
        component: COMPONENT,
        root,
        error: error.message
      });
      return [];
    }
    const entries = [];
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
      const dir = path.join(root, dirent.name);
      const entry = await this._loadOne(dir, dirent.name, source);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  async _loadOne(dir, dirName, source) {
    const file = path.join(dir, DEFINITION_FILE);
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn('Skipping unreadable integration definition', {
          component: COMPONENT,
          file,
          error: error.message
        });
      }
      return null;
    }
    const validation = validateIntegrationDefinition(raw);
    if (!validation.success) {
      logger.warn('Skipping invalid integration definition', {
        component: COMPONENT,
        file,
        issues: validation.errors.map(e => `${e.path.join('.')}: ${e.message}`)
      });
      return null;
    }
    const definition = validation.data;
    const expectedDir = definitionIdToDirName(definition.id);
    if (expectedDir !== dirName) {
      // Everything else (install, uninstall, the marketplace) addresses the
      // folder by the id; a definition loaded from elsewhere could never be
      // removed again.
      logger.warn('Skipping integration definition: folder does not match its id', {
        component: COMPONENT,
        file,
        id: definition.id,
        expectedDir,
        actualDir: dirName
      });
      return null;
    }
    const entry = { definition, source, dir, id: definition.id };
    if (definition.protocol.type === 'openapi') {
      const documentRef = definition.protocol.document;
      if (!isHttpUrl(documentRef)) {
        try {
          entry.document = await this._readDocument(dir, documentRef);
        } catch (error) {
          logger.warn('Skipping integration definition with unreadable OpenAPI document', {
            component: COMPONENT,
            file,
            document: documentRef,
            error: error.message
          });
          return null;
        }
      }
    }
    return entry;
  }

  async _readDocument(dir, relPath) {
    const target = await resolveAndValidatePath(relPath, dir);
    if (!target) throw new Error(`document path escapes the definition folder: ${relPath}`);
    const text = await fs.readFile(target, 'utf8');
    if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES) {
      throw new Error('OpenAPI document exceeds the 2MB size limit');
    }
    const spec = parseOpenApiText(text);
    if (!spec || typeof spec !== 'object' || !spec.paths) {
      throw new Error('not an OpenAPI document (no paths)');
    }
    return spec;
  }
}

export { dirNameToDefinitionId };

const integrationRegistry = new IntegrationRegistry();
export default integrationRegistry;
