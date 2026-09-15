/**
 * Blobs on a filesystem: one file per key, and nothing else.
 *
 * Layout under the provider's base directory:
 *
 *   <base>/blobs/<ns>/<key>      the payload, byte for byte
 *
 * No envelope, no encoding, no sidecar. A blob file *is* the bytes, which is
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
 * @module storage/providers/filesystem/FilesystemBlobStore
 */
import { promises as fs } from 'fs';
import crypto from 'crypto';
import path from 'path';
import { atomicWriteFile } from '../../../utils/atomicWrite.js';
import { BlobStore } from '../../BlobStore.js';
import { StorageError } from '../../errors.js';
import { assertValidKey, assertValidNamespace, containedPath } from './paths.js';

/** Directory holding every blob namespace, relative to the provider's base. */
export const BLOB_DIR = 'blobs';

const DEFAULT_LIMIT = 100;
const MIN_LIMIT = 1;
const MAX_LIMIT = 1000;

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
    if (!parsed || typeof parsed.k !== 'string') throw new Error('cursor carries no key');
    return parsed.k;
  } catch (cause) {
    throw new StorageError('Invalid blob list cursor', { code: 'INVALID_CURSOR', cause });
  }
}

/**
 * Coerce accepted payload input into a Buffer without copying when possible.
 *
 * @param {Buffer|Uint8Array|string} data - Payload as the caller passed it.
 * @returns {Buffer}
 * @throws {StorageError} Code `INVALID_DATA` for anything else.
 */
function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  throw new StorageError('Blob data must be a Buffer, Uint8Array or string', {
    code: 'INVALID_DATA'
  });
}

/**
 * Blob facet of the filesystem provider.
 */
export class FilesystemBlobStore extends BlobStore {
  /**
   * @param {string} baseDir - The provider's base directory.
   */
  constructor(baseDir) {
    super();
    this.baseDir = baseDir;
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
    assertValidKey(key);
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
    // Atomic (temp file + rename), so a reader never sees half a payload and
    // a crash mid-write leaves the previous bytes rather than a truncated
    // file. `fs.writeFile` ignores the encoding argument for a Buffer.
    await atomicWriteFile(file, buffer, 'binary');
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

  /** @inheritdoc */
  async delete(ns, key) {
    const file = this._path(ns, key);
    try {
      await fs.unlink(file);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw new StorageError(`Failed to delete blob ${ns}/${key}`, {
        code: 'IO_ERROR',
        cause: error
      });
    }
  }

  /** @inheritdoc */
  async list(ns, opts = {}) {
    const { prefix, limit, cursor } = opts || {};
    const dir = this._dir(ns);
    let names;
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      // A namespace nobody has written to is empty, not an error.
      if (error.code === 'ENOENT') return { items: [], nextCursor: null };
      throw new StorageError(`Failed to list blobs in ${ns}`, { code: 'IO_ERROR', cause: error });
    }
    let keys = names.sort(compareKeys);
    if (typeof prefix === 'string' && prefix.length > 0) {
      keys = keys.filter(key => key.startsWith(prefix));
    }
    if (cursor) {
      const after = decodeCursor(cursor);
      keys = keys.filter(key => compareKeys(key, after) > 0);
    }
    const pageSize = clampLimit(limit);
    const page = keys.slice(0, pageSize);
    const items = [];
    for (const key of page) {
      try {
        const stat = await fs.stat(containedPath(dir, key));
        if (!stat.isFile()) continue;
        items.push({ key, bytes: stat.size });
      } catch (error) {
        // Deleted mid-walk: skipped, like a document whose envelope is gone.
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const nextCursor = keys.length > pageSize ? encodeCursor(page[page.length - 1]) : null;
    return { items, nextCursor };
  }
}

export default FilesystemBlobStore;
