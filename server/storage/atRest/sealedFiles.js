// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Encryption at rest of the stores that keep user content in files of their
 * own, outside the storage layer: the facet `files` of the state record
 * (`./state.js`).
 *
 * | Store id | Path under `contents/` | Holds |
 * | --- | --- | --- |
 * | `agent-artifacts` | `data/agent-artifacts/<runId>/<name>` | outputs of agent runs |
 * | `agent-memory` | `agents/memory/<profileId>.md` | notes an agent keeps |
 * | `agent-inboxes` | `data/agent-inboxes/<inboxId>.md` | work items users write for agents |
 * | `tool-jobs` | `data/tool-jobs/<jobId>.result` | results of tool jobs (OCR), one hour |
 * | `short-links` | `data/shortlinks.json` | short links with their parameters |
 *
 * A sealed file is the envelope of `crypto/fileSeal.js`, bound to its store
 * and its name. The services keep their paths, their locks and their atomic
 * writes; they pass what they write through {@link sealForDisk} and what they
 * read through {@link openFromDisk}:
 *
 * | Mode | Switch, state record | Writes | Reading plaintext | Reading sealed |
 * | --- | --- | --- | --- | --- |
 * | `off` | switch off | plaintext | yes | yes, when the key is there |
 * | `converting` | switch on, facet `files` not recorded | sealed | yes | yes |
 * | `enforced` | switch on, facet `files` recorded | sealed | error | yes |
 *
 * Whether a file is sealed is decided by its own format (the envelope
 * header), never by the mode. The mode comes from the storage start
 * ({@link configureSealedFiles}, called by `initializeStorage`); a process in
 * which storage was never started writes plaintext and still opens sealed
 * files.
 *
 * The one-time conversion of files written before (`./convert.js`, facet
 * `files`) uses {@link createSealedFilesTarget}.
 *
 * Depends on the crypto modules and the state record only, so a service can
 * import it without loading the storage layer.
 *
 * @module storage/atRest/sealedFiles
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ENVELOPE_HEADER_BYTES, plainLength } from '../../crypto/blobEnvelope.js';
import { isSealedFile, openFile, sealFile } from '../../crypto/fileSeal.js';
import { atomicWriteFile } from '../../utils/atomicWrite.js';
import { CorruptDocumentError, KeyUnavailableError, StorageError } from '../errors.js';
import { isFacetComplete } from './state.js';

/** Name of the facet in the state record. */
export const FILES_FACET = 'files';

/** Tenant part of every address, until tenants exist. */
const TENANT = 'default';

/** Reasons a key provider gives that mean "the key is not here". */
const KEY_MISSING_REASONS = new Set(['not-initialized', 'unknown-key', 'unknown-provider']);

/**
 * The sealed stores. `path` is relative to the contents directory. `depth` is
 * how many path segments a file has below the store's directory; `depth: 0`
 * is a store that is one file. `suffix` limits the store to the files its
 * service reads.
 */
export const SEALED_FILE_STORES = Object.freeze([
  Object.freeze({ id: 'agent-artifacts', path: path.join('data', 'agent-artifacts'), depth: 2 }),
  Object.freeze({
    id: 'agent-memory',
    path: path.join('agents', 'memory'),
    depth: 1,
    suffix: '.md'
  }),
  Object.freeze({
    id: 'agent-inboxes',
    path: path.join('data', 'agent-inboxes'),
    depth: 1,
    suffix: '.md'
  }),
  Object.freeze({
    id: 'tool-jobs',
    path: path.join('data', 'tool-jobs'),
    depth: 1,
    suffix: '.result'
  }),
  Object.freeze({ id: 'short-links', path: path.join('data', 'shortlinks.json'), depth: 0 })
]);

/**
 * A file of a sealed store is plaintext while encryption at rest is enforced.
 * Never returned: whoever can write the contents directory could otherwise
 * plant content.
 */
export class PlaintextFileError extends CorruptDocumentError {
  /**
   * @param {string} message
   * @param {Object} [options]
   * @param {unknown} [options.cause]
   */
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'PlaintextFileError';
    this.code = 'PLAINTEXT_FILE';
  }
}

const loadKeyModule = () => import('../../crypto/KeyProvider.js');

/** @type {{enabled: boolean, state: Object|null, loadKeys: Function|null, keyProvider: Object|null}|null} */
let context = null;
/** @type {Promise<Object>|null} */
let loadedKeys = null;

/**
 * Tell this process how files are sealed. Called once storage has started,
 * with the switch and the state record that start found.
 *
 * @param {Object} [options]
 * @param {boolean} [options.enabled=false] - `storage.encryption.enabled`.
 * @param {Object|null} [options.state] - The state record.
 * @param {() => Promise<Object>} [options.loadKeys] - Resolves with the key
 *   module (`crypto/KeyProvider.js`); the real one by default.
 * @param {Object} [options.keyProvider] - A key provider to use as it is (tests).
 * @returns {void}
 */
export function configureSealedFiles({
  enabled = false,
  state = null,
  loadKeys = null,
  keyProvider = null
} = {}) {
  context = { enabled: enabled === true, state, loadKeys, keyProvider };
  loadedKeys = null;
}

/**
 * Forget what {@link configureSealedFiles} was told (storage shut down).
 *
 * @returns {void}
 */
export function resetSealedFiles() {
  context = null;
  loadedKeys = null;
}

/**
 * The mode of the sealed stores in this process.
 *
 * @returns {'off'|'converting'|'enforced'}
 */
export function sealedFilesMode() {
  if (!context?.enabled) return 'off';
  return isFacetComplete(context.state, FILES_FACET) ? 'enforced' : 'converting';
}

/**
 * The key provider that wraps and unwraps data keys.
 *
 * @returns {Promise<Object>}
 * @throws {KeyUnavailableError} When the master key cannot be loaded.
 */
async function keyProvider() {
  if (context?.keyProvider) return context.keyProvider;
  try {
    if (!loadedKeys) {
      const pending = (async () => {
        const keys = await (context?.loadKeys || loadKeyModule)();
        await keys.ensureMasterKey();
        return keys;
      })();
      loadedKeys = pending;
      // A failed load is not remembered: the next call tries again.
      pending.catch(() => {
        if (loadedKeys === pending) loadedKeys = null;
      });
    }
    return (await loadedKeys).getKeyProvider();
  } catch (cause) {
    if (cause instanceof StorageError) throw cause;
    throw new KeyUnavailableError(`The master key is not available: ${cause.message}`, { cause });
  }
}

/**
 * Turn a failure of a seal or key call into the error a caller of a sealed
 * store gets.
 *
 * @param {unknown} error
 * @param {string} what - The file, for the message (`agent-memory/research.md`).
 * @returns {Error}
 */
function sealFailure(error, what) {
  if (error instanceof StorageError) return error;
  if (error?.name === 'KeyAccessDenied' || error?.name === 'UnknownKeyProviderError') {
    if (KEY_MISSING_REASONS.has(error.reason)) {
      return new KeyUnavailableError(`The key for ${what} is not available: ${error.message}`, {
        keyId: error.keyId ?? null,
        cause: error
      });
    }
    return new CorruptDocumentError(`${what} does not open with the master key`, { cause: error });
  }
  if (error?.name === 'FileSealError') {
    if (error.code === 'KEY_PROVIDER_MISMATCH') {
      return new KeyUnavailableError(
        `${what} was written with key provider '${error.keyProviderId}', which is not the configured one`,
        { keyId: error.keyId, keyProviderId: error.keyProviderId, cause: error }
      );
    }
    return new CorruptDocumentError(`${what} is sealed but does not open: ${error.message}`, {
      cause: error
    });
  }
  return error;
}

/**
 * The name of a file inside its store, as it is bound into the seal.
 *
 * @param {...string} segments - Path segments below the store's directory.
 * @returns {string} Joined with `/` on every platform.
 */
export function sealedFileName(...segments) {
  return segments.join('/');
}

/**
 * What a service writes to disk for `content`: the content itself with the
 * switch off, its sealed form otherwise.
 *
 * @param {string} store - Store id, one of {@link SEALED_FILE_STORES}.
 * @param {string} name - The file's name inside the store ({@link sealedFileName}).
 * @param {string|Buffer} content
 * @returns {Promise<string|Buffer>} `content` unchanged, or a Buffer.
 * @throws {KeyUnavailableError} When the master key is not available.
 *
 * @example
 * await atomicWriteFile(file, await sealForDisk('agent-memory', 'research.md', text));
 */
export async function sealForDisk(store, name, content) {
  if (sealedFilesMode() === 'off') return content;
  try {
    return await sealFile({
      keyProvider: await keyProvider(),
      tenant: TENANT,
      store,
      name,
      plain: Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')
    });
  } catch (error) {
    throw sealFailure(error, `${store}/${name}`);
  }
}

/**
 * The content of a file a service read from disk: opened when it is sealed,
 * as it is when it is plaintext and plaintext may still be read.
 *
 * @param {string} store - Store id.
 * @param {string} name - The file's name inside the store.
 * @param {Buffer} stored - The whole file as read, without an encoding.
 * @returns {Promise<Buffer>}
 * @throws {PlaintextFileError} A plaintext file while the mode is `enforced`.
 * @throws {CorruptDocumentError} A sealed file that does not open here.
 * @throws {KeyUnavailableError} When the key it names is not available.
 *
 * @example
 * const text = (await openFromDisk('agent-memory', 'research.md', await fs.readFile(file))).toString('utf8');
 */
export async function openFromDisk(store, name, stored) {
  const bytes = Buffer.isBuffer(stored) ? stored : Buffer.from(String(stored ?? ''), 'utf8');
  if (!isSealedFile(bytes)) {
    assertPlaintextReadable(store, name);
    return bytes;
  }
  try {
    return await openFile({
      keyProvider: await keyProvider(),
      tenant: TENANT,
      store,
      name,
      stored: bytes
    });
  } catch (error) {
    throw sealFailure(error, `${store}/${name}`);
  }
}

/**
 * Refuse a plaintext file of a sealed store when plaintext may not be read
 * any more. For a reader that recognised the file as plaintext itself and
 * would serve it without {@link openFromDisk} (a stream).
 *
 * @param {string} store - Store id.
 * @param {string} name - The file's name inside the store.
 * @returns {void}
 * @throws {PlaintextFileError} While the mode is `enforced`.
 */
export function assertPlaintextReadable(store, name) {
  if (sealedFilesMode() !== 'enforced') return;
  throw new PlaintextFileError(
    `${store}/${name} is stored in plaintext although encryption at rest is enforced`
  );
}

/**
 * Whether a file on disk is sealed, from its first bytes and its size.
 *
 * @param {string} filePath - Absolute, validated path of the file.
 * @returns {Promise<boolean>}
 * @throws What `fs` throws when the file cannot be read (`ENOENT`).
 */
export async function isSealedOnDisk(filePath) {
  const [head, stat] = await Promise.all([readHead(filePath), fs.stat(filePath)]);
  return isSealedFile(head, stat.size);
}

/**
 * Read a file of a sealed store as text.
 *
 * @param {string} store - Store id.
 * @param {string} name - The file's name inside the store.
 * @param {string} filePath - Absolute, validated path of the file.
 * @returns {Promise<string>}
 * @throws What `fs.readFile` throws (`ENOENT`), and what {@link openFromDisk} throws.
 */
export async function readSealedText(store, name, filePath) {
  // lgtm[js/path-injection] -- the caller validated the path.
  return (await openFromDisk(store, name, await fs.readFile(filePath))).toString('utf8');
}

/**
 * The size of a file's content, whatever its stored form: a sealed file is
 * larger on disk than what it holds.
 *
 * @param {string} filePath - Absolute, validated path of the file.
 * @param {number} storedBytes - Its size on disk (`stat.size`).
 * @returns {Promise<number>}
 */
export async function contentSize(filePath, storedBytes) {
  const head = await readHead(filePath);
  return isSealedFile(head, storedBytes) ? plainLength(storedBytes) : storedBytes;
}

/** The first bytes of a file, enough to recognise an envelope. */
async function readHead(filePath) {
  // lgtm[js/path-injection] -- the caller validated the path.
  const handle = await fs.open(filePath, 'r');
  try {
    const head = Buffer.alloc(ENVELOPE_HEADER_BYTES);
    const { bytesRead } = await handle.read(head, 0, ENVELOPE_HEADER_BYTES, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Whether a directory entry is a file a store's service reads. */
function isStoreFile(store, name) {
  if (name.startsWith('.') || name.endsWith('.lock') || name.endsWith('.tmp')) return false;
  return !store.suffix || name.endsWith(store.suffix);
}

/** The files of one store: `{ file, name }`, name as bound into the seal. */
async function listStoreFiles(contentsDir, store) {
  const root = path.join(contentsDir, store.path);
  if (store.depth === 0) {
    const stat = await fs.stat(root).catch(() => null);
    return stat?.isFile() ? [{ file: root, name: path.basename(root) }] : [];
  }
  const found = [];
  const walk = async (dir, segments) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
      throw error;
    }
    for (const entry of entries) {
      const below = [...segments, entry.name];
      if (below.length < store.depth) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          await walk(path.join(dir, entry.name), below);
        }
      } else if (entry.isFile() && isStoreFile(store, entry.name)) {
        found.push({ file: path.join(dir, entry.name), name: sealedFileName(...below) });
      }
    }
  };
  await walk(root, []);
  return found;
}

/**
 * The sealed stores of one contents directory, as the conversion walks them.
 *
 * @param {Object} options
 * @param {string} options.contentsDir - Absolute contents directory.
 * @param {Object} options.keyProvider - Wraps the data keys of what is sealed.
 * @returns {{list: () => Promise<Array<{store: string, name: string, file: string}>>,
 *   inspect: (entry: Object) => Promise<{state: 'plain'|'sealed'|'missing', bytes: number}>,
 *   seal: (entry: Object) => Promise<'sealed'|'already'|'missing'>}}
 *
 * @example
 * const files = createSealedFilesTarget({ contentsDir, keyProvider });
 * for (const entry of await files.list()) await files.seal(entry);
 */
export function createSealedFilesTarget({ contentsDir, keyProvider: provider }) {
  const missing = error => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
  return {
    async list() {
      const entries = [];
      for (const store of SEALED_FILE_STORES) {
        for (const found of await listStoreFiles(contentsDir, store)) {
          entries.push({ store: store.id, ...found });
        }
      }
      return entries;
    },

    async inspect({ file }) {
      try {
        const { size } = await fs.stat(file);
        const sealed = isSealedFile(await readHead(file), size);
        return { state: sealed ? 'sealed' : 'plain', bytes: size };
      } catch (error) {
        if (missing(error)) return { state: 'missing', bytes: 0 };
        throw error;
      }
    },

    async seal({ store, name, file }) {
      let stored;
      let stat;
      try {
        stat = await fs.stat(file);
        stored = await fs.readFile(file);
      } catch (error) {
        if (missing(error)) return 'missing';
        throw error;
      }
      if (isSealedFile(stored)) return 'already';
      const sealed = await sealFile({
        keyProvider: provider,
        tenant: TENANT,
        store,
        name,
        plain: stored
      });
      // One rename: after a crash the file is plaintext or sealed, never a mix.
      await atomicWriteFile(file, sealed);
      // The conversion is not a change of the content: keep its age, which
      // the artifact list shows and the sweep of tool-job results goes by.
      await fs.utimes(file, stat.atime, stat.mtime).catch(() => {});
      return 'sealed';
    }
  };
}

/**
 * Read one file of a sealed store by store id and name, whatever its stored
 * form and whatever the mode: for the support command (`storage:show`).
 *
 * @param {Object} options
 * @param {string} options.contentsDir - Absolute contents directory.
 * @param {string} options.store - Store id, one of {@link SEALED_FILE_STORES}.
 * @param {string} options.name - The file's name inside the store
 *   (`research.md`, `<runId>/report.md`, `shortlinks.json`).
 * @param {Object} options.keyProvider - Unwraps the data key of a sealed file.
 * @returns {Promise<Buffer|null>} The content; null when there is no such
 *   store or file, or the name is not one a file of that store can have.
 * @throws {CorruptDocumentError|KeyUnavailableError} A sealed file that does
 *   not open.
 */
export async function readStoreFile({ contentsDir, store: storeId, name, keyProvider: provider }) {
  const store = SEALED_FILE_STORES.find(candidate => candidate.id === storeId);
  const segments = typeof name === 'string' ? name.split('/') : [];
  if (
    !store ||
    segments.some(part => !part || part === '.' || part === '..' || /[\\\0]/.test(part))
  ) {
    return null;
  }
  const root = path.join(contentsDir, store.path);
  let file;
  if (store.depth === 0) {
    if (name !== path.basename(root)) return null;
    file = root;
  } else {
    if (segments.length !== store.depth) return null;
    file = path.join(root, ...segments);
  }
  let stored;
  try {
    stored = await fs.readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EISDIR') return null;
    throw error;
  }
  if (!isSealedFile(stored)) return stored;
  try {
    return await openFile({ keyProvider: provider, tenant: TENANT, store: storeId, name, stored });
  } catch (error) {
    throw sealFailure(error, `${storeId}/${name}`);
  }
}

/**
 * Whether the sealed stores of a contents directory hold no file at all.
 *
 * @param {string} contentsDir - Absolute contents directory.
 * @returns {Promise<boolean>}
 */
export async function sealedStoresHoldNothing(contentsDir) {
  for (const store of SEALED_FILE_STORES) {
    if ((await listStoreFiles(contentsDir, store)).length > 0) return false;
  }
  return true;
}
