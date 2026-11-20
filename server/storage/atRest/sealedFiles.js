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
 * read through {@link openFromDisk}, or through {@link openSealedStream} when
 * the content goes straight to a response:
 *
 * | Mode | Switch, state record | Writes | Reading plaintext | Reading sealed |
 * | --- | --- | --- | --- | --- |
 * | `off` | switch off | plaintext | yes | yes, when the key is there |
 * | `converting` | switch on, facet `files` not recorded | sealed | yes | yes |
 * | `enforced` | switch on, facet `files` recorded | sealed | error | yes |
 *
 * Whether a file is sealed is decided by its own format (the envelope
 * header), never by the mode. The mode comes from the storage start
 * ({@link configureSealedFiles}, called by `initializeStorage`). A process in
 * which storage is not started (before the start, after the shutdown, a
 * command) does not fall back to plaintext: it works the mode out the way the
 * start does, from the switch in `platform.json` and the state record, the
 * first time a file is written or read.
 *
 * The one-time conversion of files written before (`./convert.js`, facet
 * `files`) uses {@link createSealedFilesTarget}.
 *
 * Depends on the crypto modules and the state record only, so a service can
 * import it without loading the storage layer.
 *
 * @module storage/atRest/sealedFiles
 */
import nodeFs, { promises as fs } from 'node:fs';
import path from 'node:path';
import { ENVELOPE_HEADER_BYTES, plainLength } from '../../crypto/blobEnvelope.js';
import { isSealedFile, openFile, openFileStream, sealFile } from '../../crypto/fileSeal.js';
import { atomicWriteFile } from '../../utils/atomicWrite.js';
import { CorruptDocumentError, KeyUnavailableError, StorageError } from '../errors.js';
import { isFacetComplete, readAtRestState } from './state.js';

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
/** What {@link resolveUnconfigured} found, while storage is not started. */
let fallback = null;
/** @type {Promise<Object>|null} */
let loadedKeys = null;

/**
 * The switch and the state record as a storage start would find them, for a
 * process in which storage is not started.
 *
 * @returns {Promise<{enabled: boolean, state: Object|null, loadKeys: null, keyProvider: null}>}
 * @throws What reading the state record throws: an unreadable record is never
 *   read as "encryption off".
 */
async function resolveUnconfigured() {
  // One after the other: both pull in `config.js`, and a test runner that
  // links modules itself cannot link one module from two imports at once.
  const { loadJson } = await import('../../configLoader.js');
  const storage = await import('../index.js');
  const platformConfig = storage.withStartDecision((await loadJson('config/platform.json')) || {});
  const { encryption } = storage.resolveStorageConfig(platformConfig);
  if (!encryption.enabled)
    return { enabled: false, state: null, loadKeys: null, keyProvider: null };
  const baseDir = await storage.resolveStorageBaseDir(platformConfig);
  return {
    enabled: true,
    state: baseDir ? await readAtRestState(baseDir) : null,
    loadKeys: null,
    keyProvider: null
  };
}

/**
 * The context in effect: what the storage start set, or what the
 * configuration says while storage is not started.
 *
 * @returns {Promise<Object>}
 */
async function activeContext() {
  if (context) return context;
  if (!fallback) {
    const pending = resolveUnconfigured();
    fallback = pending;
    // A failure is not remembered: the next call reads again.
    pending.catch(() => {
      if (fallback === pending) fallback = null;
    });
  }
  return fallback;
}

/** The mode a context stands for. */
function modeOf(active) {
  if (!active?.enabled) return 'off';
  return isFacetComplete(active.state, FILES_FACET) ? 'enforced' : 'converting';
}

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
  fallback = null;
  loadedKeys = null;
}

/**
 * Forget what {@link configureSealedFiles} was told (storage shut down). The
 * next write or read works the mode out from the configuration again.
 *
 * @returns {void}
 */
export function resetSealedFiles() {
  context = null;
  fallback = null;
  loadedKeys = null;
}

/**
 * The mode the storage start set for the sealed stores of this process.
 *
 * Only what {@link configureSealedFiles} was told: `off` while storage is not
 * started. Code that decides whether to seal or to accept plaintext uses
 * {@link resolveSealedFilesMode}, which does not default to plaintext.
 *
 * @returns {'off'|'converting'|'enforced'}
 */
export function sealedFilesMode() {
  return modeOf(context);
}

/**
 * The mode of the sealed stores, also while storage is not started: then it
 * is worked out from `storage.encryption.enabled` and the state record.
 *
 * @returns {Promise<'off'|'converting'|'enforced'>}
 * @throws When the state record exists and cannot be read.
 */
export async function resolveSealedFilesMode() {
  return modeOf(await activeContext());
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
      const loadKeys = context?.loadKeys || loadKeyModule;
      const pending = (async () => {
        const keys = await loadKeys();
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
  if ((await resolveSealedFilesMode()) === 'off') return content;
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
    await assertPlaintextReadable(store, name);
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
 * @returns {Promise<void>} Await it: the mode may have to be read first.
 * @throws {PlaintextFileError} While the mode is `enforced`.
 */
export async function assertPlaintextReadable(store, name) {
  if ((await resolveSealedFilesMode()) !== 'enforced') return;
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
 * Open a file of a sealed store as a stream of its content, for a reader
 * that sends it on (a download) and need not hold it in memory:
 * {@link openFromDisk} for a stream. The rules are the same. A sealed file is
 * decrypted segment by segment, a plaintext file is read as it is while
 * plaintext may still be read, and refused once the mode is `enforced`.
 *
 * `bytes` is the length of the content, known before the first byte.
 *
 * **The stream can fail after it delivered data.** A sealed file that does
 * not open at all rejects this call; one that is damaged or cut further in
 * makes the stream fail later (`CORRUPT_DOCUMENT`), after genuine earlier
 * segments, and never ends cleanly. A consumer treats the content as read
 * only when the stream ended; an HTTP handler destroys its response on a late
 * failure (`utils/streamResponse.js` does). Read the stream to its end or
 * destroy it: it holds the file open. Learn of a failure through `for await`,
 * `pipeline`, `finished` or `sendStream`: the stream may have failed before
 * the caller listens, and it does not throw then.
 *
 * @param {string} store - Store id.
 * @param {string} name - The file's name inside the store.
 * @param {string} filePath - Absolute, validated path of the file.
 * @returns {Promise<{bytes: number, sealed: boolean, stream: import('node:stream').Readable}>}
 * @throws What `fs` throws when the file cannot be opened (`ENOENT`).
 * @throws {PlaintextFileError} A plaintext file while the mode is `enforced`.
 * @throws {CorruptDocumentError} A sealed file that does not open here.
 * @throws {KeyUnavailableError} When the key it names is not available.
 *
 * @example
 * const file = await openSealedStream('tool-jobs', 'job1.result', resultFile);
 * await sendStream(req, res, file.stream, { headers: { 'Content-Length': String(file.bytes) } });
 */
export async function openSealedStream(store, name, filePath) {
  const what = `${store}/${name}`;
  try {
    const [head, stat] = await Promise.all([readHead(filePath), fs.stat(filePath)]);
    if (!isSealedFile(head, stat.size)) {
      await assertPlaintextReadable(store, name);
      // lgtm[js/path-injection] -- the caller validated the path.
      const stream = nodeFs.createReadStream(filePath);
      // An early failure must not become an uncaught exception; see `guardStream`.
      stream.on('error', () => {});
      return { bytes: stat.size, sealed: false, stream };
    }
    const provider = await keyProvider();
    const opened = await openFileStream({
      keyProvider: provider,
      tenant: TENANT,
      store,
      name,
      head,
      storedBytes: stat.size,
      // lgtm[js/path-injection] -- the caller validated the path.
      source: nodeFs.createReadStream(filePath, { start: ENVELOPE_HEADER_BYTES }),
      mapError: error => sealFailure(error, what)
    });
    opened.stream.on('error', () => {});
    return { bytes: opened.bytes, sealed: true, stream: opened.stream };
  } catch (error) {
    throw sealFailure(error, what);
  }
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

/**
 * The scratch file of `atomicWriteFile` (`utils/atomicWrite.js`), which every
 * sealed store writes through or beside: `.tmp_` and 16 hex digits. No file a
 * service stores has that name.
 */
const ATOMIC_WRITE_SCRATCH = /^\.tmp_[0-9a-f]{16}$/;

/**
 * Whether a directory entry is a file a store's service reads.
 *
 * Only the store's own scratch files are left out, and they are recognised by
 * their exact name. Nothing is left out by a pattern a stored file could
 * match: an agent artifact may be called `yarn.lock` or `notes.tmp`.
 *
 * @param {Object} store - One of {@link SEALED_FILE_STORES}.
 * @param {string} name - File name.
 * @returns {boolean}
 */
export function isStoreFile(store, name) {
  if (ATOMIC_WRITE_SCRATCH.test(name)) return false;
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
