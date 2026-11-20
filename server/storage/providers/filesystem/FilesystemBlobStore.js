// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Blobs on a filesystem: one file per key, and nothing else.
 *
 * Layout under the provider's base directory:
 *
 *   <base>/blobs/<ns>/<key>                        the payload, byte for byte
 *   <base>/blobs/<ns>/.prefixes/<partition>/<key>  empty marker (key-prefix index, only for
 *                                                  namespaces in KEY_PREFIX_SEGMENTS)
 *
 * No envelope, no encoding, no sidecar beside the payload. A blob file *is* the bytes, which is
 * what makes this facet swappable for an object store later (issue #2318): an
 * S3 adapter maps the same four calls onto `PutObject`, `GetObject`,
 * `DeleteObject` and `ListObjectsV2`, and a domain repository written against
 * {@link BlobStore} does not change.
 *
 * Under `blobs/` rather than beside the documents on purpose. The document
 * store owns `<base>/<ns>/` and walks it expecting `*.json` envelopes plus its
 * `.owners` index; a payload dropped in there would eventually be read as a
 * corrupt document. Keeping the two trees apart also means an operator can see
 * at a glance what the megabytes are.
 *
 * Content type is not stored. It is domain metadata — what the bytes *are* —
 * and it belongs in the document that describes the blob, where it can be read
 * without touching the payload. `put` accepts it as a hint so an object-store
 * implementation can set it on the object; here it is ignored.
 *
 * The key-prefix index (`./prefixIndex.js`) makes a listing scoped to one chat
 * or one project read that scope's partition rather than the namespace. A
 * blob is written with no lock, so a `put` racing a `delete` *of the same key*
 * can end with the payload in place and its marker gone; the facet's callers
 * mint a fresh key per write (see {@link BlobStore#put}), which is what keeps
 * that case out of reach.
 *
 * @module storage/providers/filesystem/FilesystemBlobStore
 */
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { atomicWriteFile, atomicWriteStream } from '../../../utils/atomicWrite.js';
import logger from '../../../utils/logger.js';
import { BlobStore } from '../../BlobStore.js';
import {
  clampBlobLimit as clampLimit,
  compareBlobKeys as compareKeys,
  decodeBlobCursor as decodeCursor,
  encodeBlobCursor as encodeCursor,
  assertStreamLength,
  guardStream,
  mapStreamError,
  streamLengthError,
  toBlobBuffer as toBuffer
} from '../../blobSupport.js';
import { StorageError } from '../../errors.js';
import {
  RESERVED_BLOB_KEY_PREFIX as TEMP_PREFIX,
  assertValidBlobKey,
  assertValidNamespace
} from '../../keys.js';
import { INTERNAL_BLOB_NAMESPACE } from '../../namespaces.js';
import { isValidId } from '../../../utils/pathSecurity.js';
import { containedPath } from './paths.js';
import { PREFIXES_DIR, PrefixIndex } from './prefixIndex.js';

/** Directory holding every blob namespace, relative to the provider's base. */
export const BLOB_DIR = 'blobs';

/**
 * Name prefix of a blob being deleted (renamed aside, then unlinked). It holds
 * `..`, which no key may contain (`isValidId`), so it never hides a real blob.
 */
export const DELETING_PREFIX = '..deleting_';

/**
 * Bytes a streamed read asks the file system for at a time. Larger than
 * Node's default of 64 KiB, which costs sixteen round trips to the thread
 * pool per MiB.
 */
const READ_CHUNK_BYTES = 1024 * 1024;

/** Keys a blob walk stats at once. */
const SCAN_CONCURRENCY = 16;

/** Whether a namespace directory entry is bookkeeping rather than a blob. */
function isReservedEntry(name) {
  return name === PREFIXES_DIR || name.startsWith(DELETING_PREFIX) || name.startsWith(TEMP_PREFIX);
}

/**
 * Blob facet of the filesystem provider.
 */
export class FilesystemBlobStore extends BlobStore {
  /**
   * @param {string} baseDir - The provider's base directory.
   * @param {Object} [options]
   * @param {Record<string, number>} [options.keyPrefixSegments] - Namespaces kept in
   *   the key-prefix index; defaults to `KEY_PREFIX_SEGMENTS`. `{}` switches it off (tests)
   */
  constructor(baseDir, { keyPrefixSegments } = {}) {
    super();
    this.baseDir = baseDir;
    this._prefixIndex = new PrefixIndex(keyPrefixSegments);
    /**
     * Set by the one-time conversion while it replaces plaintext blobs with
     * their encrypted form: an overwrite then keeps the modification time of
     * the blob it replaces, because orphan sweeps judge a blob by its age.
     * @type {boolean}
     */
    this.keepModificationTime = false;
  }

  /**
   * The namespaces that have a directory on disk, for the one-time
   * conversion: a namespace of a removed feature is found here although no
   * declaration names it any more. The internal namespace is left out.
   *
   * @returns {Promise<string[]>} Sorted namespace names.
   */
  async namespaces() {
    let entries;
    try {
      entries = await fs.readdir(containedPath(this.baseDir, BLOB_DIR), { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new StorageError('Failed to list the blob namespaces', {
        code: 'IO_ERROR',
        cause: error
      });
    }
    return entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .filter(name => name !== INTERNAL_BLOB_NAMESPACE && isValidId(name))
      .sort();
  }

  /**
   * Absolute path of one blob, validated and contained.
   *
   * @param {string} ns - Namespace.
   * @param {string} key - Key within the namespace.
   * @returns {string}
   * @private
   */
  _path(ns, key) {
    assertValidNamespace(ns);
    // Also refuses the index directory's name and the prefix `atomicWriteFile`
    // gives its scratch file while a `put` is in flight: both are left out of
    // namespace listings, so neither may be a key.
    assertValidBlobKey(key);
    return containedPath(this.baseDir, BLOB_DIR, ns, key);
  }

  /**
   * Absolute path of a namespace directory.
   *
   * @param {string} ns - Namespace.
   * @returns {string}
   * @private
   */
  _dir(ns) {
    assertValidNamespace(ns);
    return containedPath(this.baseDir, BLOB_DIR, ns);
  }

  /** @inheritdoc */
  async put(ns, key, data, _opts = {}) {
    const file = this._path(ns, key);
    const buffer = toBuffer(data);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Marker first: a marker may outlive its blob, never the reverse.
    await this._prefixIndex.writeMarker(this._dir(ns), ns, key);
    // Atomic (temp file + rename), so a reader never sees half a payload and
    // a crash mid-write leaves the previous bytes rather than a truncated
    // file. `fs.writeFile` ignores the encoding argument for a Buffer.
    const previous = this.keepModificationTime ? await fs.stat(file).catch(() => null) : null;
    await atomicWriteFile(file, buffer, 'binary');
    if (previous) await fs.utimes(file, previous.atime, previous.mtime);
    return {
      key,
      bytes: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex')
    };
  }

  /** @inheritdoc */
  async get(ns, key) {
    const file = this._path(ns, key);
    try {
      const data = await fs.readFile(file);
      return { key, bytes: data.length, data };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new StorageError(`Failed to read blob ${ns}/${key}`, {
        code: 'IO_ERROR',
        cause: error
      });
    }
  }

  /**
   * @inheritdoc
   *
   * A read stream over the open file. The file is opened before the call
   * resolves, so a blob replaced or deleted afterwards is still read to its
   * end as it was (a `put` renames a new file into place and never changes
   * one). A read error arrives on the stream as a `StorageError`, code
   * `IO_ERROR`.
   */
  async openRead(ns, key) {
    const file = this._path(ns, key);
    let handle;
    try {
      handle = await fs.open(file, 'r');
      const stat = await handle.stat();
      if (!stat.isFile()) throw Object.assign(new Error('not a file'), { code: 'EISDIR' });
      if (stat.size === 0) {
        await handle.close();
        return { key, bytes: 0, stream: Readable.from([], { objectMode: false }) };
      }
      // Closes the handle when it ends or is destroyed. `end` pins the read
      // to the size that is reported.
      const stream = handle.createReadStream({
        start: 0,
        end: stat.size - 1,
        highWaterMark: READ_CHUNK_BYTES
      });
      // A failed read reaches the consumer as a storage error, like `get`.
      mapStreamError(
        stream,
        error =>
          new StorageError(`Failed to read blob ${ns}/${key}`, { code: 'IO_ERROR', cause: error })
      );
      return { key, bytes: stat.size, stream: guardStream(stream) };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error.code === 'ENOENT') return null;
      throw new StorageError(`Failed to read blob ${ns}/${key}`, {
        code: 'IO_ERROR',
        cause: error
      });
    }
  }

  /**
   * @inheritdoc
   *
   * The stream is written to a scratch file beside the blob and renamed into
   * place when it ended with the declared length, exactly as `put` replaces a
   * blob: a reader sees the previous payload or the new one. A stream that
   * fails or has another length leaves nothing behind.
   */
  async putStream(ns, key, stream, opts = {}) {
    const bytes = assertStreamLength(opts?.bytes, stream);
    let file;
    try {
      file = this._path(ns, key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      // Marker first: a marker may outlive its blob, never the reverse.
      await this._prefixIndex.writeMarker(this._dir(ns), ns, key);
    } catch (error) {
      stream.destroy();
      throw error;
    }
    const previous = this.keepModificationTime ? await fs.stat(file).catch(() => null) : null;
    const hash = crypto.createHash('sha256');
    let count = 0;
    await atomicWriteStream(file, stream, {
      onChunk: chunk => {
        count += chunk.length;
        if (count > bytes) throw streamLengthError(`${ns}/${key}`, count, bytes);
        hash.update(chunk);
      },
      onEnd: () => {
        if (count !== bytes) throw streamLengthError(`${ns}/${key}`, count, bytes);
      }
    });
    if (previous) await fs.utimes(file, previous.atime, previous.mtime);
    return { key, bytes, sha256: hash.digest('hex') };
  }

  /**
   * The first bytes of one blob, without reading the rest. What the
   * encrypting blob store looks at to tell an encrypted blob from a plaintext
   * one while a store holds both.
   *
   * @param {string} ns - Namespace.
   * @param {string} key - Key within the namespace.
   * @param {number} length - How many bytes to read at most.
   * @returns {Promise<Buffer|null>} Up to `length` bytes, or null when there is no blob.
   */
  async readHead(ns, key, length) {
    const file = this._path(ns, key);
    let handle;
    try {
      handle = await fs.open(file, 'r');
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new StorageError(`Failed to read blob ${ns}/${key}`, {
        code: 'IO_ERROR',
        cause: error
      });
    } finally {
      await handle?.close();
    }
  }

  /**
   * @inheritdoc
   *
   * The blob is first renamed aside, then unlinked: of two concurrent
   * deletes only one rename succeeds. `unlink` alone is no such claim — on
   * macOS (APFS) two unlinks of the same file racing each other both report
   * success.
   */
  async delete(ns, key) {
    const file = this._path(ns, key);
    const claimed = path.join(
      path.dirname(file),
      `${DELETING_PREFIX}${crypto.randomBytes(8).toString('hex')}`
    );
    try {
      await fs.rename(file, claimed);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // Nothing to delete, but a marker a crashed put or delete left behind
        // would otherwise stay for good.
        await this._removeMarker(ns, key);
        return false;
      }
      throw new StorageError(`Failed to delete blob ${ns}/${key}`, {
        code: 'IO_ERROR',
        cause: error
      });
    }
    try {
      await fs.unlink(claimed);
    } catch (error) {
      // The key is gone either way, which is what the caller is told. The
      // leftover is skipped by `list` and removed at the next start
      // (`removeDeletionLeftovers`).
      if (error.code !== 'ENOENT') {
        logger.warn('Could not remove a deleted blob; it is removed at the next start', {
          component: 'FilesystemBlobStore',
          ns,
          key,
          path: claimed,
          error: error.message
        });
      }
    }
    // After the payload, never before; a marker left by a failure is skipped
    // by every listing.
    await this._removeMarker(ns, key);
    return true;
  }

  /**
   * Remove a key's prefix index marker, logging rather than throwing: the
   * blob is gone either way, and a leftover marker is skipped by listings.
   *
   * @param {string} ns - Namespace.
   * @param {string} key - Key.
   * @returns {Promise<void>}
   * @private
   */
  async _removeMarker(ns, key) {
    try {
      await this._prefixIndex.removeMarker(this._dir(ns), ns, key);
    } catch (error) {
      logger.warn('Could not remove the prefix index entry of a deleted blob', {
        component: 'FilesystemBlobStore',
        ns,
        key,
        error: error.message
      });
    }
  }

  /**
   * Remove what deletes left behind (a crash or a failed unlink between the
   * rename and the unlink). Called once when the provider starts, not on any
   * request path. A delete running in another process at the same time finds
   * its file gone and still reports the removal.
   *
   * @returns {Promise<number>} Files removed.
   */
  async removeDeletionLeftovers() {
    const root = containedPath(this.baseDir, BLOB_DIR);
    let namespaces;
    try {
      namespaces = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw error;
    }
    let removed = 0;
    for (const entry of namespaces) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      for (const name of await fs.readdir(dir)) {
        if (!name.startsWith(DELETING_PREFIX)) continue;
        try {
          await fs.unlink(path.join(dir, name));
          removed += 1;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
    return removed;
  }

  /** @inheritdoc */
  async list(ns, opts = {}) {
    const { prefix, limit, cursor } = opts || {};
    const dir = this._dir(ns);
    let keys = await this._keys(ns, prefix);
    if (cursor) {
      const after = decodeCursor(cursor);
      keys = keys.filter(key => compareKeys(key, after) > 0);
    }
    const pageSize = clampLimit(limit);
    const page = keys.slice(0, pageSize);
    const items = [];
    for (const key of page) {
      const item = await this._entry(dir, key);
      if (item) items.push(item);
    }
    const nextCursor = keys.length > pageSize ? encodeCursor(page[page.length - 1]) : null;
    return { items, nextCursor };
  }

  /**
   * @inheritdoc
   *
   * One directory read for the whole walk — the namespace, or the one
   * partition of the key-prefix index the prefix pins — then one `stat` per
   * key as it is yielded, so a caller that stops early stops the work too.
   */
  async *scan(ns, opts = {}) {
    const { prefix } = opts || {};
    const dir = this._dir(ns);
    const keys = await this._keys(ns, prefix);
    // Stat ahead one batch at a time instead of one key after the other.
    for (let start = 0; start < keys.length; start += SCAN_CONCURRENCY) {
      const batch = keys.slice(start, start + SCAN_CONCURRENCY);
      for (const item of await Promise.all(batch.map(key => this._entry(dir, key)))) {
        if (item) yield item;
      }
    }
  }

  /**
   * The keys a listing covers, sorted and prefix-filtered: from the key-prefix
   * index when the prefix pins one partition, from the namespace directory
   * otherwise. A namespace nobody has written to is empty, not an error.
   *
   * @param {string} ns - Namespace.
   * @param {string} [prefix] - Prefix filter.
   * @returns {Promise<string[]>}
   * @private
   */
  async _keys(ns, prefix) {
    const dir = this._dir(ns);
    const partition = this._prefixIndex.partition(ns, prefix);
    let names;
    if (partition) {
      names = await this._prefixIndex.keys(dir, partition);
    } else {
      try {
        names = (await fs.readdir(dir)).filter(name => !isReservedEntry(name));
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw new StorageError(`Failed to list blobs in ${ns}`, { code: 'IO_ERROR', cause: error });
      }
    }
    let keys = names.sort(compareKeys);
    if (typeof prefix === 'string' && prefix.length > 0) {
      keys = keys.filter(key => key.startsWith(prefix));
    }
    return keys;
  }

  /**
   * Size of one listed blob, or null when it is not there (deleted mid-walk,
   * or an index marker whose blob never landed — skipped, never pruned).
   *
   * @param {string} dir - Namespace directory.
   * @param {string} key - Key.
   * @returns {Promise<{key: string, bytes: number}|null>}
   * @private
   */
  async _entry(dir, key) {
    try {
      const stat = await fs.stat(containedPath(dir, key));
      return stat.isFile() ? { key, bytes: stat.size } : null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
}

export default FilesystemBlobStore;
