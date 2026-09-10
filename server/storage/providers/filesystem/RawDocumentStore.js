/**
 * Configuration documents as the files they already are.
 *
 * `FilesystemDocumentStore` writes an envelope (`{v, key, ownerId, …, data}`)
 * under `contents/data/<ns>/`. Configuration cannot live like that: it is
 * hand-edited, git-tracked, docker-mounted, seeded from `server/defaults/` and
 * rewritten by checksum-frozen migrations, so moving it or wrapping it would
 * change every file of every installation. This store is the other mode: for
 * the namespaces declared in `server/storage/namespaces.js`, the JSON file at
 * `<contents>/<dir>/<key>.json` **is** the document body.
 *
 * What follows from "the file is the document", and how it differs from the
 * enveloped store:
 *
 * - **Bytes are the truth.** A write emits exactly `JSON.stringify(data, null, 2)`
 *   with no trailing newline — what `utils/atomicWrite.js` has always produced —
 *   so a save through this store leaves a file no different from a save through
 *   the admin routes before it existed.
 * - **`etag` is the sha256 of those bytes**, not of a re-serialization of the
 *   parsed data. Two files with equal data but different formatting are
 *   different documents here, which is what makes a compare-and-set notice
 *   that somebody edited the file by hand between the read and the write.
 * - **There is no owner.** Config belongs to the installation, so `ownerId` is
 *   rejected rather than quietly ignored, and `list({ownerId})` is rejected
 *   with it.
 * - **Timestamps come from `stat`.** The file carries no creation record, so
 *   `createdAt` and `updatedAt` are both the modification time; an atomic
 *   replace gives the file a new inode anyway, so any "created" metadata a
 *   filesystem offers would reset on every save and report a falsehood.
 * - **No sidecars.** Locks live under the provider's `<base>/.config-locks/`,
 *   never inside a namespace directory: `resourceLoader` loads every `*.json`
 *   under `contents/apps` as an app, and a stray one would be loaded as one.
 * - **A read never throws.** Missing, unreadable and malformed all resolve to
 *   `null`, because `configCache` branches on `data !== null` in eleven places
 *   and a throw during boot would change behaviour that has held for years.
 *
 * @module storage/providers/filesystem/RawDocumentStore
 */
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { atomicWriteFile } from '../../../utils/atomicWrite.js';
import { withFileLock, removeIfExists } from '../../../utils/fileLock.js';
import { isValidId } from '../../../utils/pathSecurity.js';
import logger from '../../../utils/logger.js';
import { DocumentStore } from '../../DocumentStore.js';
import { EtagMismatchError, NotSupportedError, StorageError } from '../../errors.js';
import { CONFIG_NAMESPACES, RAW_DOC_EXT } from '../../namespaces.js';
import { assertValidKey, containedPath } from './paths.js';

const COMPONENT = 'RawDocumentStore';

/** The only content type a raw namespace can hold: the file is JSON. */
const CONTENT_TYPE = 'application/json';

const DEFAULT_LIMIT = 100;
const MIN_LIMIT = 1;
const MAX_LIMIT = 1000;

/**
 * Serialize a document body exactly the way `atomicWriteJSON` does.
 *
 * The two-space indent and the absent trailing newline are not a style choice
 * here, they are the compatibility contract: every config file in every
 * installation was written with this serializer, and a different one would
 * make the first save after an upgrade rewrite files nobody edited.
 *
 * @param {any} data - Document body
 * @returns {string} The bytes to write
 * @throws {StorageError} Code `INVALID_DATA` when `data` cannot be serialized
 */
function serializeRaw(data) {
  if (data === undefined) {
    throw new StorageError('Document data must not be undefined', { code: 'INVALID_DATA' });
  }
  let json;
  try {
    json = JSON.stringify(data, null, 2);
  } catch (cause) {
    throw new StorageError('Document data must be JSON-serializable', {
      code: 'INVALID_DATA',
      cause
    });
  }
  // Functions and symbols serialize to `undefined` instead of throwing.
  if (json === undefined) {
    throw new StorageError('Document data must be JSON-serializable', { code: 'INVALID_DATA' });
  }
  return json;
}

/**
 * sha256 hex of the file's bytes — the raw namespace's entity tag.
 *
 * A content digest for cache validation and compare-and-set, never a
 * credential derivation: it is not compared against a user-supplied secret and
 * authenticates nothing. CodeQL reaches this sink from platform config, which
 * carries secret-shaped fields, and reads it as a password hash; it is not
 * one. What would make it one is exposing a document's etag to a caller who
 * could use it to confirm a guessed secret — re-examine this suppression if
 * that ever becomes possible.
 *
 * @param {string} bytes - File content as read or as about to be written
 * @returns {string} Hex digest
 */
function etagOfBytes(bytes) {
  return crypto.createHash('sha256').update(bytes, 'utf8').digest('hex'); // lgtm[js/insufficient-password-hash] -- entity tag over a file body, not a stored password
}

/** Clamp a caller's page size into the supported range instead of throwing. */
function clampLimit(limit) {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT;
  const value = Number(limit);
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.floor(value)));
}

/** Key ordering: plain string comparison, so every provider pages identically. */
function compareKeys(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function encodeCursor(key) {
  return Buffer.from(JSON.stringify({ k: key })).toString('base64url');
}

function decodeCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (!parsed || typeof parsed.k !== 'string') {
      throw new Error('cursor carries no key');
    }
    return parsed.k;
  } catch (cause) {
    throw new StorageError('Invalid list cursor', { code: 'INVALID_CURSOR', cause });
  }
}

/**
 * Split a declared namespace directory into path segments, refusing anything
 * that is not a plain relative directory.
 *
 * The declarations are code, not input, so this is a boot-time assertion: a
 * typo in the map is caught when the provider is constructed rather than on
 * the first write into a directory nobody expected.
 *
 * @param {string} ns - Namespace name, for the error message
 * @param {string} dir - Declared directory, `/`-separated
 * @returns {string[]} Path segments
 * @throws {StorageError} Code `INVALID_CONFIG` when the declaration is unusable
 */
function namespaceSegments(ns, dir) {
  const segments = typeof dir === 'string' ? dir.split('/').filter(Boolean) : [];
  if (segments.length === 0 || !segments.every(segment => isValidId(segment))) {
    throw new StorageError(`Raw namespace ${ns} declares an unusable directory: ${String(dir)}`, {
      code: 'INVALID_CONFIG'
    });
  }
  return segments;
}

/**
 * Refuse an owner.
 *
 * Configuration belongs to the installation, and there is nowhere in a plain
 * JSON file to keep an owner anyway. Accepting the option and dropping it
 * would let a caller believe a document is protected when it is not, so this
 * is an error rather than a silent no-op. An explicit `null` — "unowned",
 * which is the only state a raw document has — passes.
 *
 * @param {any} ownerId - The requested owner
 * @param {string} operation - Operation name for the message
 * @returns {void}
 * @throws {NotSupportedError} When an owner other than null is requested
 */
function assertNoOwner(ownerId, operation) {
  if (ownerId === undefined || ownerId === null) return;
  throw new NotSupportedError(
    `Raw configuration namespaces have no owner; ${operation} cannot use ownerId`
  );
}

/**
 * Refuse a content type the file cannot hold.
 *
 * @param {any} contentType - The requested content type
 * @param {string} operation - Operation name for the message
 * @returns {void}
 * @throws {NotSupportedError} When a type other than `application/json` is requested
 */
function assertJsonContentType(contentType, operation) {
  if (contentType === undefined || contentType === null || contentType === CONTENT_TYPE) return;
  throw new NotSupportedError(
    `Raw configuration namespaces are ${CONTENT_TYPE}; ${operation} cannot use ${String(
      contentType
    ).slice(0, 64)}`
  );
}

/**
 * A {@link DocumentStore} over the configuration files in `contents/`.
 *
 * @augments DocumentStore
 */
export class RawDocumentStore extends DocumentStore {
  /**
   * @param {Object} options
   * @param {string} options.contentsDir - Absolute `contents/` directory the
   *   namespaces are views over
   * @param {string} options.lockDir - Absolute directory for the lock files.
   *   Must be outside `contentsDir`'s namespace directories.
   * @param {Object<string, {dir: string}>} [options.namespaces] - Namespace
   *   declarations; defaults to {@link CONFIG_NAMESPACES}
   * @param {{publish: (event: Object) => Promise<void>}} [options.notifier] -
   *   Change notifier the store publishes `document.put` / `document.delete`
   *   on; omitted, the store stays silent
   * @throws {StorageError} Code `INVALID_CONFIG` when a directory is missing
   *   from the options or a declaration is unusable
   */
  constructor({ contentsDir, lockDir, namespaces = CONFIG_NAMESPACES, notifier } = {}) {
    super();
    if (typeof contentsDir !== 'string' || contentsDir.length === 0) {
      throw new StorageError('RawDocumentStore requires a contentsDir', { code: 'INVALID_CONFIG' });
    }
    if (typeof lockDir !== 'string' || lockDir.length === 0) {
      throw new StorageError('RawDocumentStore requires a lockDir', { code: 'INVALID_CONFIG' });
    }
    // Resolved so the accessors and every joined path speak absolute paths
    // regardless of the process's working directory.
    this._contentsDir = path.resolve(contentsDir);
    this._lockDir = path.resolve(lockDir);
    // Resolved once: every declaration is validated here so an unusable map
    // cannot reach a path join later, and the per-call lookup stays a Map read.
    this._dirs = new Map(
      Object.entries(namespaces).map(([ns, descriptor]) => [
        ns,
        containedPath(this._contentsDir, ...namespaceSegments(ns, descriptor?.dir))
      ])
    );
    this._notifier = notifier || null;
  }

  /**
   * Absolute `contents/` directory these namespaces are views over.
   * @returns {string}
   */
  get contentsDir() {
    return this._contentsDir;
  }

  /**
   * Names of the namespaces this store serves, in ascending order.
   * @returns {string[]}
   */
  get namespaceNames() {
    return [...this._dirs.keys()].sort();
  }

  /**
   * Whether this store is responsible for a namespace.
   *
   * @param {string} ns - Namespace name
   * @returns {boolean} True when `ns` is one of the declared raw namespaces
   */
  handles(ns) {
    return typeof ns === 'string' && this._dirs.has(ns);
  }

  /**
   * Read one document.
   *
   * Missing, unreadable and malformed files all resolve to null — see the
   * module note; this is the `loadFile` behaviour `configCache` is built on.
   *
   * @param {string} ns - Raw namespace
   * @param {string} key - Document key
   * @returns {Promise<Object|null>} The document, or null when it is not readable
   * @throws {InvalidKeyError} When `key` is not a safe id
   * @throws {StorageError} Code `UNKNOWN_NAMESPACE` when `ns` is not raw
   */
  async get(ns, key) {
    this._assertNamespace(ns);
    assertValidKey(key);
    const file = await this._readFile(ns, key);
    if (!file) return null;
    const parsed = this._parse(ns, key, file.bytes);
    if (parsed === undefined) return null;
    return this._toDocument(ns, key, file, parsed, true);
  }

  /**
   * Create or overwrite a document, writing the body as the file.
   *
   * @param {string} ns - Raw namespace
   * @param {string} key - Document key
   * @param {any} data - JSON-serializable body (never `undefined`)
   * @param {Object} [opts]
   * @param {null} [opts.ownerId] - Only `null` (already the case) is accepted
   * @param {string|null} [opts.etag] - String for compare-and-set, null for
   *   create-only, omitted for an unconditional write
   * @param {string} [opts.contentType] - Only `application/json` is accepted
   * @returns {Promise<Object>} The stored document
   * @throws {NotSupportedError} When an owner or a non-JSON content type is asked for
   * @throws {EtagMismatchError} When the conditional write does not hold
   * @throws {StorageError} Code `INVALID_DATA` when `data` cannot be serialized
   */
  async put(ns, key, data, opts = {}) {
    this._assertNamespace(ns);
    assertValidKey(key);
    const options = opts || {};
    assertNoOwner(options.ownerId, `put ${ns}/${key}`);
    assertJsonContentType(options.contentType, `put ${ns}/${key}`);
    const json = serializeRaw(data);

    const expectedEtag = options.etag;
    if (expectedEtag !== undefined && expectedEtag !== null && typeof expectedEtag !== 'string') {
      throw new StorageError('put() etag must be a string, null, or omitted', {
        code: 'INVALID_ETAG'
      });
    }

    const filePath = this._docPath(ns, key);
    const document = await withFileLock(
      this._lockPath(ns, key),
      async () => {
        // Existence is judged on the bytes, not on whether they parse: a file
        // that somebody truncated still exists, and a create-only write must
        // not silently replace it.
        const existing = await this._readFile(ns, key);

        if (expectedEtag === null && existing) {
          throw new EtagMismatchError(`Document ${ns}/${key} already exists`);
        }
        if (typeof expectedEtag === 'string') {
          if (!existing) {
            throw new EtagMismatchError(`Document ${ns}/${key} does not exist`);
          }
          if (etagOfBytes(existing.bytes) !== expectedEtag) {
            throw new EtagMismatchError(`Etag mismatch for document ${ns}/${key}`);
          }
        }

        await fs.mkdir(this._dirs.get(ns), { recursive: true });
        // `atomicWriteFile` with the bytes this store serialized, rather than
        // `atomicWriteJSON` with the object: the etag below has to describe the
        // bytes that actually landed, and going through one string makes that
        // true by construction instead of by two serializers agreeing.
        await atomicWriteFile(filePath, json, 'utf8');
        const stat = await fs.stat(filePath);
        // The round-tripped body, so what put() returns is exactly what a
        // following get() reads back (JSON drops undefined-valued keys and
        // applies any toJSON()).
        return this._toDocument(ns, key, { bytes: json, stat }, JSON.parse(json), true);
      },
      { component: COMPONENT }
    );

    // Published outside the critical section: subscribers must not be able to
    // hold the key's lock while they work.
    await this._publish({ type: 'document.put', ns, key, ownerId: null });
    return document;
  }

  /**
   * Remove a document's file.
   *
   * @param {string} ns - Raw namespace
   * @param {string} key - Document key
   * @returns {Promise<boolean>} True when a file was actually removed
   * @throws {InvalidKeyError} When `key` is not a safe id
   * @throws {StorageError} Code `UNKNOWN_NAMESPACE` when `ns` is not raw
   */
  async delete(ns, key) {
    this._assertNamespace(ns);
    assertValidKey(key);

    const removed = await withFileLock(
      this._lockPath(ns, key),
      async () => removeIfExists(this._docPath(ns, key)),
      { component: COMPONENT }
    );

    if (removed) {
      await this._publish({ type: 'document.delete', ns, key, ownerId: null });
    }
    return removed;
  }

  /**
   * List a namespace directory in ascending key order.
   *
   * Files that do not parse are skipped rather than surfaced as empty
   * documents, matching `get()`: a listing must not invent a document whose
   * body nobody can read.
   *
   * @param {string} ns - Raw namespace
   * @param {Object} [opts]
   * @param {null} [opts.ownerId] - Only `null` is accepted; config has no owner
   * @param {string} [opts.prefix] - Keep only keys starting with this prefix
   * @param {number} [opts.limit=100] - Page size, clamped to 1..1000
   * @param {string} [opts.cursor] - Opaque cursor from a previous page
   * @param {boolean} [opts.includeData=true] - False omits `data` and keeps the metadata
   * @returns {Promise<{items: Object[], nextCursor: string|null}>}
   * @throws {NotSupportedError} When an owner filter is asked for
   * @throws {StorageError} Code `INVALID_CURSOR` when `cursor` cannot be decoded
   */
  async list(ns, opts = {}) {
    this._assertNamespace(ns);
    const { ownerId, prefix, limit, cursor, includeData = true } = opts || {};
    assertNoOwner(ownerId, `list ${ns}`);
    const pageSize = clampLimit(limit);
    const after = cursor === undefined || cursor === null ? null : decodeCursor(cursor);

    let keys = await this._namespaceKeys(ns);
    keys.sort(compareKeys);
    if (typeof prefix === 'string' && prefix.length > 0) {
      keys = keys.filter(key => key.startsWith(prefix));
    }
    if (after !== null) {
      keys = keys.filter(key => key > after);
    }

    const items = [];
    let index = 0;
    for (; index < keys.length && items.length < pageSize; index++) {
      const key = keys[index];
      const file = await this._readFile(ns, key);
      // Deleted between the readdir and here, or not readable at all.
      if (!file) continue;
      const parsed = this._parse(ns, key, file.bytes);
      if (parsed === undefined) continue;
      items.push(this._toDocument(ns, key, file, parsed, includeData !== false));
    }

    const nextCursor =
      index < keys.length && items.length > 0 ? encodeCursor(items[items.length - 1].key) : null;
    return { items, nextCursor };
  }

  /**
   * Walk a namespace once, yielding every document in ascending key order.
   *
   * The cursor-free counterpart to {@link RawDocumentStore#list}, for the same
   * reason: paging re-enumerated and re-sorted the directory per page.
   *
   * @param {string} ns - Raw namespace name
   * @param {Object} [opts]
   * @param {string} [opts.prefix] - Keep only keys starting with this prefix
   * @param {boolean} [opts.includeData=true] - False omits `data`
   * @yields {Object} Documents in ascending key order
   */
  async *scan(ns, opts = {}) {
    this._assertNamespace(ns);
    const { prefix, includeData = true } = opts || {};
    let keys = await this._namespaceKeys(ns);
    if (typeof prefix === 'string' && prefix.length > 0) {
      keys = keys.filter(key => key.startsWith(prefix));
    }
    for (const key of keys) {
      const file = await this._readFile(ns, key);
      if (!file) continue;
      const parsed = this._parse(ns, key, file.bytes);
      if (parsed === undefined) continue;
      yield this._toDocument(ns, key, file, parsed, includeData !== false);
    }
  }

  /** This store implements `scan`. @returns {boolean} true */
  get supportsScan() {
    return true;
  }

  /**
   * Whether a document file is present, regardless of whether it parses.
   *
   * `get` and `list` both fold "absent", "unreadable" and "malformed" into
   * the same answer, deliberately — a broken app definition must not take the
   * boot down. That leaves read-modify-write callers with no way to tell a
   * first run from a corrupt file, and folding the second into the first lets
   * the next save write every other entry away. This is the primitive that
   * separates them, and it deliberately does not parse: a file whose contents
   * cannot be read is exactly the case it exists to report.
   *
   * @param {string} ns - Raw namespace name
   * @param {string} key - Document key
   * @returns {Promise<boolean>} True when a file exists at the document's path
   */
  async exists(ns, key) {
    this._assertNamespace(ns);
    assertValidKey(key);
    try {
      const stat = await fs.stat(this._docPath(ns, key));
      return stat.isFile();
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
      // EACCES on the file or its directory means something is there that we
      // are not allowed to look at — which is "present but unreadable", the
      // case this method is for.
      return true;
    }
  }

  /**
   * Reject a namespace this store does not serve.
   *
   * A plain `InvalidKeyError` would be wrong: the name may be perfectly valid
   * and simply belong to the enveloped store, so the failure is "wrong store",
   * not "bad input".
   *
   * @private
   */
  _assertNamespace(ns) {
    if (!this.handles(ns)) {
      throw new StorageError(`Not a raw storage namespace: ${String(ns).slice(0, 64)}`, {
        code: 'UNKNOWN_NAMESPACE'
      });
    }
  }

  /** Absolute path of a document file. @private */
  _docPath(ns, key) {
    return containedPath(this._dirs.get(ns), `${key}${RAW_DOC_EXT}`);
  }

  /**
   * Per-key lock file guarding the read-modify-write of put()/delete().
   *
   * Outside the namespace directory, under the provider's own base directory,
   * so nothing that scans `contents/apps` (or any other config directory) ever
   * sees a file this store created. Namespaces get a subdirectory each so two
   * keys cannot collide across them.
   *
   * `withFileLock` is advisory and single-machine: it serializes the cluster
   * workers sharing this volume — what the etag compare-and-set needs — and
   * nothing beyond them. Like everywhere else in the codebase it proceeds
   * without the lock once its wait expires rather than failing the write.
   *
   * @private
   */
  _lockPath(ns, key) {
    return containedPath(this._lockDir, ns, `${key}.lock`);
  }

  /** Keys of every JSON file directly in a namespace directory. @private */
  async _namespaceKeys(ns) {
    let entries;
    try {
      entries = await fs.readdir(this._dirs.get(ns));
    } catch (error) {
      // A namespace directory an installation never created lists empty; that
      // is the same answer `loadFile` gives for the files inside it.
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
      throw error;
    }
    const keys = [];
    for (const entry of entries) {
      if (!entry.endsWith(RAW_DOC_EXT)) continue;
      const key = entry.slice(0, -RAW_DOC_EXT.length);
      // Only surface names this store would itself accept, so a file dropped
      // into the directory by hand can never reach containedPath().
      if (isValidId(key)) keys.push(key);
    }
    return keys;
  }

  /**
   * Read a document file's bytes and stat together.
   *
   * One open handle serves both so the timestamps always describe the bytes
   * that were read, even when a concurrent save replaces the file in between.
   *
   * @returns {Promise<{bytes: string, stat: import('fs').Stats}|null>} null
   *   when the file is not readable — see the module note on D3.
   * @private
   */
  async _readFile(ns, key) {
    const filePath = this._docPath(ns, key);
    let handle;
    try {
      handle = await fs.open(filePath, 'r');
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR' || error.code === 'ENOTDIR') {
        return null;
      }
      // A permission or I/O failure reads as "no configuration" exactly as
      // `configLoader.loadFile` has always made it, because callers branch on
      // null and a throw here would turn a misconfigured file mode into a
      // failed boot. It is logged so it is not invisible.
      logger.error('Unable to read configuration document', {
        component: COMPONENT,
        ns,
        key,
        error: error.message
      });
      return null;
    }
    try {
      const stat = await handle.stat();
      if (stat.isDirectory()) return null;
      return { bytes: await handle.readFile('utf8'), stat };
    } catch (error) {
      logger.error('Unable to read configuration document', {
        component: COMPONENT,
        ns,
        key,
        error: error.message
      });
      return null;
    } finally {
      await handle.close().catch(() => {});
    }
  }

  /**
   * Parse a document file.
   *
   * @returns {any} The parsed body, or `undefined` when the file is malformed —
   *   `undefined` rather than null because null is a legitimate body.
   * @private
   */
  _parse(ns, key, bytes) {
    try {
      return JSON.parse(bytes);
    } catch {
      // Config files are hand-edited, so a syntax error is an ordinary event.
      // Reading it as absent is what every existing loader does; failing here
      // would take the server down over one broken app definition.
      logger.warn('Ignoring malformed configuration document', { component: COMPONENT, ns, key });
      return undefined;
    }
  }

  /** Project a file into the public Document shape. @private */
  _toDocument(ns, key, file, data, includeData) {
    const modified = file.stat.mtime.toISOString();
    const document = {
      ns,
      key,
      ownerId: null,
      contentType: CONTENT_TYPE,
      // The file has no creation record that survives an atomic replace, so
      // both timestamps are the modification time rather than one of them
      // being a number that resets on every save.
      createdAt: modified,
      updatedAt: modified,
      etag: etagOfBytes(file.bytes),
      size: Buffer.byteLength(file.bytes, 'utf8')
    };
    // Left off entirely rather than set to undefined, so a metadata-only page
    // is distinguishable with a plain `in` check.
    if (includeData) document.data = data;
    return document;
  }

  /** Publish a change event, never letting a subscriber break a durable write. @private */
  async _publish(event) {
    if (!this._notifier || typeof this._notifier.publish !== 'function') return;
    try {
      await this._notifier.publish(event);
    } catch (error) {
      // The write already landed; a failing notifier must not turn a completed
      // operation into a caller-visible error.
      logger.warn('Storage change notification failed', {
        component: COMPONENT,
        type: event.type,
        error
      });
    }
  }
}

export default RawDocumentStore;
