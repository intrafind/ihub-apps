/**
 * ConfigStore — the one seam between the server's configuration files and the
 * storage provider that holds them.
 *
 * Every read and write of an installation's `contents/` configuration goes
 * through here: `configLoader` and `resourceLoader` on the read side, the admin
 * routes on the write side. Callers address a file the way they always have —
 * by its path relative to `contents/`, `config/platform.json`,
 * `apps/chat.json`, `locales/de.json` — and this module turns that into the
 * `(namespace, key)` pair the provider understands, using the single mapping in
 * `server/storage/namespaces.js`.
 *
 * Three properties are load-bearing, and each one is a decision rather than an
 * implementation detail:
 *
 * - **The bytes on disk do not change.** The namespaces this store uses are
 *   declared *raw*: the JSON file at `<contents>/<dir>/<key>.json` is the
 *   document body, written with the serializer `atomicWriteJSON` has always
 *   used. An installation's `contents/` is byte-identical before and after a
 *   release that routes config through the provider — which is what makes the
 *   tree safe to keep hand-editing, git-tracking and docker-mounting.
 * - **A read never throws and never invents a value.** Missing, unreadable and
 *   malformed all resolve to `null`, because `configCache` branches on
 *   `data !== null` in eleven places; `{}` or an exception would change boot
 *   behaviour that has held for years. A missing locale override is silent, as
 *   it has always been: an installation without translation overrides is the
 *   normal case, not a fault.
 * - **Configuration never depends on optional runtime storage.** The provider
 *   is itself configured from `platform.json`, so config has to be readable
 *   before a provider exists and after one has failed to come up (a supported
 *   state — see `storage/bootstrap.js`). When no provider serves the namespace,
 *   this store reads and writes the same contained path directly. That path is
 *   the only filesystem access left outside `server/storage/`, and it is
 *   deliberate: without it a malformed `storage` block in `platform.json` would
 *   stop the server from reading the very file that block lives in.
 *
 * Text bodies — `pages/<lang>/<id>.md`, renderers, sources — are not raw
 * documents: they are nested and not JSON, so `namespaces.js` does not declare
 * them and {@link ConfigStore#readText}/{@link ConfigStore#writeText} always
 * use the contained path.
 *
 * There is no caching here. `configCache` is the cache, and a second one below
 * it (the 60-second TTL `configLoader` used to keep) is invisible to
 * `refreshCacheEntry`, which gave every admin save a stale window nobody
 * intended.
 *
 * @module services/config/ConfigStore
 */
import { promises as fs } from 'fs';
import path from 'path';
import { getRootDir } from '../../pathUtils.js';
import serverConfig from '../../config.js';
import logger from '../../utils/logger.js';
import { isValidId, resolveAndValidatePath } from '../../utils/pathSecurity.js';
import { atomicCreateJSON, atomicWriteFile, atomicWriteJSON } from '../../utils/atomicWrite.js';
import { getStorage } from '../../storage/bootstrap.js';
import {
  CONFIG_NAMESPACES,
  RAW_DOC_EXT,
  getRawNamespace,
  parseRawRelPath
} from '../../storage/namespaces.js';

const COMPONENT = 'ConfigStore';

/**
 * Page size used when walking a namespace. The store clamps to 1000, and a
 * config directory never holds more than a few hundred files, so this is one
 * round trip in practice while the paging loop still handles more.
 */
const LIST_PAGE_SIZE = 1000;

/** The provider whose capabilities have been read, so they are read once. */
let describedProvider = null;

/** Raw namespace names the described provider serves, or null when it serves none. */
let describedNamespaces = null;

/**
 * The absolute `contents/` directory.
 *
 * Resolved per call rather than at import time: `getRootDir()` is configured
 * during startup and this module is imported before that happens.
 *
 * @returns {string} Absolute path of the contents directory
 */
function contentsDir() {
  return path.join(getRootDir(), serverConfig.CONTENTS_DIR);
}

/**
 * The raw namespaces a provider serves, read from its capabilities.
 *
 * @param {Object} provider - An initialized storage provider
 * @returns {Set<string>|null} Namespace names, or null when the provider does
 *   not serve raw configuration at all
 */
function readRawNamespaces(provider) {
  let capabilities;
  try {
    capabilities = provider.getCapabilities?.() || {};
  } catch (error) {
    logger.warn('Storage provider capabilities could not be read', {
      component: COMPONENT,
      error: error.message
    });
    return null;
  }
  const declared = capabilities.rawNamespaces;
  return Array.isArray(declared) && declared.length > 0 ? new Set(declared) : null;
}

/**
 * The document facet to use for a namespace, or null when configuration has to
 * stay on the contained filesystem path.
 *
 * The capability lookup is memoized per provider instance and logged once, so
 * which backend is serving configuration is visible in the boot log instead of
 * being something an operator has to infer.
 *
 * @param {string} ns - Raw namespace name
 * @returns {Object|null} The provider's document store, or null
 */
function documentsFor(ns) {
  const provider = getStorage();
  if (!provider) return null;
  if (provider !== describedProvider) {
    describedProvider = provider;
    describedNamespaces = readRawNamespaces(provider);
    if (describedNamespaces) {
      logger.info('Configuration is served by the storage provider', {
        component: COMPONENT,
        provider: provider.name,
        namespaces: [...describedNamespaces].sort().join(', ')
      });
    } else {
      logger.warn('Storage provider serves no raw configuration namespaces', {
        component: COMPONENT,
        provider: provider.name,
        hint: 'Configuration is read and written on the filesystem path instead'
      });
    }
  }
  if (!describedNamespaces?.has(ns)) return null;
  return provider.documents || null;
}

/**
 * Resolve a namespace name or a contents-relative directory to both.
 *
 * `list()` and `resolveIdToPath()` are called with a namespace by the admin
 * routes and with a directory by `resourceLoader`, which is configured with
 * paths (`agents/profiles`) rather than namespace names.
 *
 * @param {string} nsOrDir - Namespace name, or a directory under `contents/`
 * @returns {{ns: string|null, dir: string}|null} The namespace (null when the
 *   directory is not a declared one) and its directory, or null when the
 *   argument names neither
 */
function resolveTarget(nsOrDir) {
  const declared = getRawNamespace(nsOrDir);
  if (declared) return { ns: nsOrDir, dir: declared.dir };
  if (typeof nsOrDir !== 'string' || nsOrDir.length === 0) return null;
  // Trailing slashes are trimmed by scanning rather than with `/\/+$/`, which
  // backtracks quadratically on a run of slashes that does not reach the end
  // of the string. The two remaining patterns are safe: a global replace of a
  // single character, and an anchored two-character prefix.
  let dir = nsOrDir.replace(/\\/g, '/').replace(/^\.\//, '');
  let end = dir.length;
  while (end > 0 && dir[end - 1] === '/') end -= 1;
  dir = dir.slice(0, end);
  if (!dir) return null;
  for (const [ns, descriptor] of Object.entries(CONFIG_NAMESPACES)) {
    if (descriptor.dir === dir) return { ns, dir };
  }
  return { ns: null, dir };
}

/**
 * Report a configuration file that is not there.
 *
 * A missing locale override stays silent — `configLoader` has always treated it
 * as the ordinary case — and everything else is a debug line, because the
 * layers above (`configCache`, `resourceLoader`) already report a missing
 * configuration in terms their caller understands.
 *
 * @param {string} relPath - Path relative to `contents/`
 * @returns {void}
 */
function logMissing(relPath) {
  if (typeof relPath === 'string' && relPath.includes('locales/')) return;
  logger.debug('Configuration file not available', { component: COMPONENT, path: relPath });
}

/**
 * Report a configuration file that exists but could not be used.
 *
 * @param {string} relPath - Path relative to `contents/`
 * @param {string} kind - 'JSON' or 'text', for the message
 * @param {Error} error - The underlying failure
 * @returns {void}
 */
function logFailure(relPath, kind, error) {
  logger.error(`Error loading ${kind} ${relPath}:`, { component: COMPONENT, error });
}

/**
 * Resolve a contents-relative path to an absolute one inside `contents/`.
 *
 * A traversal attempt is logged and folded onto the file's base name rather
 * than rejected: the admin routes hand user-derived path fragments in here and
 * have always received a contained path back instead of an exception.
 *
 * @param {string} relPath - Path relative to `contents/`
 * @returns {Promise<string>} Absolute path inside the contents directory
 */
async function resolveConfigPath(relPath) {
  const baseDir = contentsDir();
  const resolved = await resolveAndValidatePath(relPath, baseDir);
  if (resolved) return resolved;
  logger.warn(`Path traversal blocked in ConfigStore: ${relPath}`, { component: COMPONENT });
  return path.join(baseDir, path.basename(String(relPath)));
}

/**
 * Read a file under `contents/` as text, folding every failure into null.
 *
 * @param {string} relPath - Path relative to `contents/`
 * @param {string} kind - 'JSON' or 'text', for the failure message
 * @returns {Promise<string|null>} File contents, or null
 */
async function readFromDisk(relPath, kind) {
  try {
    const filePath = await resolveConfigPath(relPath);
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') {
      logMissing(relPath);
      return null;
    }
    logFailure(relPath, kind, error);
    return null;
  }
}

/**
 * List the JSON file names of a directory under `contents/`.
 *
 * Only names the raw store would accept are returned, so a directory lists the
 * same keys whichever side of the seam answers.
 *
 * @param {string} dir - Directory relative to `contents/`
 * @param {string} [prefix] - Keep only keys starting with this
 * @returns {Promise<string[]>} Keys (file names without `.json`), ascending
 */
async function listFromDisk(dir, prefix) {
  let entries;
  try {
    const dirPath = await resolveConfigPath(dir);
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
      logger.error('Unable to list configuration directory', {
        component: COMPONENT,
        dir,
        error: error.message
      });
    }
    return [];
  }
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith(RAW_DOC_EXT))
    .map(entry => entry.name.slice(0, -RAW_DOC_EXT.length))
    .filter(key => isValidId(key) && (!prefix || key.startsWith(prefix)))
    .sort();
}

/**
 * The configuration store.
 *
 * Instantiated once below; the class is exported so a test can hold an
 * independent instance.
 */
export class ConfigStore {
  /**
   * Read a JSON configuration file.
   *
   * @param {string} relPath - Path relative to `contents/`, e.g. `config/ui.json`
   * @param {Object} [_options] - Accepted for call-site compatibility. The
   *   former `useCache` flag is ignored: `configCache` is the cache, and the
   *   TTL cache that used to sit here was invisible to `refreshCacheEntry`.
   * @returns {Promise<any|null>} The parsed body, or null when the file is
   *   missing, unreadable or malformed
   */
  async readJson(relPath, _options = {}) {
    const location = parseRawRelPath(relPath);
    const documents = location ? documentsFor(location.ns) : null;
    if (documents) {
      try {
        const document = await documents.get(location.ns, location.key);
        if (document) return document.data ?? null;
        logMissing(relPath);
        return null;
      } catch (error) {
        logFailure(relPath, 'JSON', error);
        return null;
      }
    }
    const text = await readFromDisk(relPath, 'JSON');
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch (error) {
      logFailure(relPath, 'JSON', error);
      return null;
    }
  }

  /**
   * Read a text file under `contents/` — a page body, a renderer, a markdown
   * source.
   *
   * These are not raw documents: they are nested (`pages/<lang>/<id>.md`) and
   * not JSON, so `namespaces.js` does not declare them and the read stays on
   * the contained path.
   *
   * @param {string} relPath - Path relative to `contents/`
   * @returns {Promise<string|null>} File contents, or null when it cannot be read
   */
  async readText(relPath) {
    return readFromDisk(relPath, 'text');
  }

  /**
   * Write a JSON configuration file, atomically and byte for byte the way it
   * has always been written (`JSON.stringify(data, null, 2)`, no trailing
   * newline).
   *
   * @param {string} relPath - Path relative to `contents/`
   * @param {any} data - JSON-serializable body
   * @returns {Promise<void>}
   * @throws {Error} When the write fails; callers map that onto a response
   */
  async writeJson(relPath, data) {
    const location = parseRawRelPath(relPath);
    const documents = location ? documentsFor(location.ns) : null;
    if (documents) {
      await documents.put(location.ns, location.key, data);
      return;
    }
    const filePath = await resolveConfigPath(relPath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await atomicWriteJSON(filePath, data);
  }

  /**
   * Write a JSON configuration file only when it does not exist yet.
   *
   * The create-or-fail check is atomic, so two concurrent admin creates cannot
   * both win and silently overwrite one another.
   *
   * @param {string} relPath - Path relative to `contents/`
   * @param {any} data - JSON-serializable body
   * @returns {Promise<void>}
   * @throws {Error} With `code === 'EEXIST'` when the file already exists, the
   *   same shape `atomicCreateJSON` throws, so callers can map it onto 409
   */
  async createJson(relPath, data) {
    const location = parseRawRelPath(relPath);
    const documents = location ? documentsFor(location.ns) : null;
    if (documents) {
      try {
        await documents.put(location.ns, location.key, data, { etag: null });
      } catch (error) {
        if (error?.code !== 'ETAG_MISMATCH') throw error;
        const conflict = new Error(`Configuration file already exists: ${relPath}`, {
          cause: error
        });
        conflict.code = 'EEXIST';
        throw conflict;
      }
      return;
    }
    const filePath = await resolveConfigPath(relPath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await atomicCreateJSON(filePath, data);
  }

  /**
   * Write a text file under `contents/` — the counterpart of
   * {@link ConfigStore#readText}, on the contained path for the same reason.
   *
   * @param {string} relPath - Path relative to `contents/`
   * @param {string} text - File contents
   * @returns {Promise<void>}
   */
  async writeText(relPath, text) {
    const filePath = await resolveConfigPath(relPath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await atomicWriteFile(filePath, text, 'utf8');
  }

  /**
   * Delete a configuration file.
   *
   * @param {string} relPath - Path relative to `contents/`
   * @returns {Promise<boolean>} True when a file was removed, false when there
   *   was nothing to remove
   */
  async remove(relPath) {
    const location = parseRawRelPath(relPath);
    const documents = location ? documentsFor(location.ns) : null;
    if (documents) return documents.delete(location.ns, location.key);
    const filePath = await resolveConfigPath(relPath);
    try {
      await fs.unlink(filePath);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  /**
   * The keys a namespace holds.
   *
   * Keys are file names without the `.json` extension. A document's own `id`
   * field may differ from its key — see {@link ConfigStore#resolveIdToPath}.
   *
   * @param {string} nsOrDir - Namespace name, or a directory under `contents/`
   * @param {Object} [options]
   * @param {string} [options.prefix] - Keep only keys starting with this
   * @returns {Promise<string[]>} Keys in ascending order; empty when the
   *   namespace holds nothing or cannot be listed
   */
  async list(nsOrDir, { prefix } = {}) {
    const target = resolveTarget(nsOrDir);
    if (!target) return [];
    const documents = target.ns ? documentsFor(target.ns) : null;
    if (!documents) return listFromDisk(target.dir, prefix);
    try {
      const keys = [];
      let cursor = null;
      do {
        const page = await documents.list(target.ns, {
          prefix,
          includeData: false,
          limit: LIST_PAGE_SIZE,
          cursor: cursor || undefined
        });
        for (const item of page.items) keys.push(item.key);
        cursor = page.nextCursor || null;
      } while (cursor);
      return keys;
    } catch (error) {
      logger.error('Unable to list configuration namespace', {
        component: COMPONENT,
        namespace: target.ns,
        error: error.message
      });
      return [];
    }
  }

  /**
   * Every document a namespace holds, with the path each one came from.
   *
   * One pass instead of a listing followed by a read per key: the store reads
   * each file to page a namespace anyway. Files that do not parse are skipped,
   * exactly as a single read of them would resolve to null.
   *
   * @param {string} nsOrDir - Namespace name, or a directory under `contents/`
   * @param {Object} [options]
   * @param {string} [options.prefix] - Keep only keys starting with this
   * @returns {Promise<Array<{key: string, path: string, data: any}>>} Documents
   *   in ascending key order
   */
  async listDocuments(nsOrDir, { prefix } = {}) {
    const target = resolveTarget(nsOrDir);
    if (!target) return [];
    const documents = target.ns ? documentsFor(target.ns) : null;
    if (documents) {
      try {
        const items = [];
        let cursor = null;
        do {
          const page = await documents.list(target.ns, {
            prefix,
            limit: LIST_PAGE_SIZE,
            cursor: cursor || undefined
          });
          for (const item of page.items) {
            items.push({
              key: item.key,
              path: `${target.dir}/${item.key}${RAW_DOC_EXT}`,
              data: item.data
            });
          }
          cursor = page.nextCursor || null;
        } while (cursor);
        return items;
      } catch (error) {
        logger.error('Unable to read configuration namespace', {
          component: COMPONENT,
          namespace: target.ns,
          error: error.message
        });
        return [];
      }
    }
    const keys = await listFromDisk(target.dir, prefix);
    const items = [];
    for (const key of keys) {
      const relPath = `${target.dir}/${key}${RAW_DOC_EXT}`;
      const data = await this.readJson(relPath);
      if (data === null) continue;
      items.push({ key, path: relPath, data });
    }
    return items;
  }

  /**
   * The path a resource id lives at.
   *
   * A file name is allowed to diverge from the `id` inside it, so writing an
   * app back to `<id>.json` without looking would fork it into two files. This
   * mirrors what the admin routes have always done by hand: the expected file
   * name wins when it exists, otherwise the namespace is searched for the
   * document carrying the id, and only a resource that exists nowhere falls
   * back to `<id>.json` — which is the right answer when creating one.
   *
   * @param {string} nsOrDir - Namespace name, or a directory under `contents/`
   * @param {string} id - Resource id
   * @returns {Promise<string|null>} Path relative to `contents/`, or null when
   *   the namespace or the id is not usable as a file name
   */
  async resolveIdToPath(nsOrDir, id) {
    const target = resolveTarget(nsOrDir);
    if (!target || !isValidId(id)) return null;
    const expected = `${target.dir}/${id}${RAW_DOC_EXT}`;
    if ((await this.readJson(expected)) !== null) return expected;
    const documents = await this.listDocuments(target.ns || target.dir);
    const match = documents.find(item => item.data?.id === id);
    return match ? match.path : expected;
  }
}

/** The process-wide configuration store. */
export const configStore = new ConfigStore();

export default configStore;
