/**
 * Documents on a filesystem: one JSON envelope per key plus a per-owner index.
 *
 * Layout under the provider's base directory:
 *
 *   <base>/<ns>/<key>.json                      the document envelope
 *   <base>/<ns>/.owners/<ownerSegment>/<key>    empty marker file (the per-owner index)
 *   <base>/<ns>/.locks/<key>.lock               transient compare-and-set lock
 *
 * Design note — flat documents, owners as an index. The persistence concept
 * sketches `contents/data/<ns>/[<ownerId>/]<key>.json`, but `get(ns, key)`
 * takes no ownerId: a document filed under an owner directory could not be
 * located by key in a single read. The documents therefore stay flat and the
 * per-owner subdirectories become the *index* instead — which is what the
 * constraint behind that sketch ("`list(ns, { ownerId })` must be indexed,
 * never a scan") actually asks for. Owner directories are named by a sha256
 * prefix of the ownerId because owner ids are external strings (e-mail
 * addresses, OIDC subjects) that are not path-safe; the raw ownerId stays
 * readable inside every envelope.
 *
 * `etag` and `size` are derived on read from `JSON.stringify(data)` and never
 * stored, so they can never drift away from the bytes they describe.
 *
 * @module storage/providers/filesystem/FilesystemDocumentStore
 */
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { atomicCreateJSON, atomicWriteJSON } from '../../../utils/atomicWrite.js';
import { withFileLock, removeIfExists, tryCreateExclusive } from '../../../utils/fileLock.js';
import { isValidId } from '../../../utils/pathSecurity.js';
import logger from '../../../utils/logger.js';
import { DocumentStore } from '../../DocumentStore.js';
import {
  CorruptDocumentError,
  EtagMismatchError,
  InvalidKeyError,
  StorageError
} from '../../errors.js';
import {
  DOC_EXT,
  assertValidKey,
  assertValidNamespace,
  containedPath,
  ownerSegment
} from './paths.js';

const COMPONENT = 'FilesystemDocumentStore';

/** Envelope schema version, so a later layout change can be detected on read. */
const ENVELOPE_VERSION = 1;

const DEFAULT_CONTENT_TYPE = 'application/json';
const DEFAULT_LIMIT = 100;
const MIN_LIMIT = 1;
const MAX_LIMIT = 1000;

/** Sub-directories of a namespace that hold bookkeeping rather than documents. */
const OWNERS_DIR = '.owners';
const LOCKS_DIR = '.locks';

/** Prefix `atomicWrite` gives its scratch files while a write is in flight. */
const TEMP_PREFIX = '.tmp_';

/**
 * Whether a directory entry is this store's own bookkeeping rather than a
 * document.
 *
 * Named exactly, not by a blanket "starts with a dot": `isValidId` accepts a
 * leading dot, so `.draft` is a perfectly storable key whose envelope is
 * `.draft.json`. A blanket rule hid every such document from `list(ns)` while
 * `list(ns, { ownerId })` — which reads the owner index, where the same rule
 * was never applied — still returned it, so the two listings disagreed about
 * what the namespace holds. Both call this instead.
 *
 * @param {string} entry - Directory entry name
 * @returns {boolean} True when the entry is bookkeeping and must not be listed
 */
function isReservedEntry(entry) {
  return entry === OWNERS_DIR || entry === LOCKS_DIR || entry.startsWith(TEMP_PREFIX);
}

/**
 * sha256 hex of a serialized document body — the provider-independent etag.
 *
 * This is a content digest for cache validation and compare-and-set, not a
 * credential derivation: it is never compared against a user-supplied secret
 * and never authenticates anything. A fast hash is the right tool, and it has
 * to stay one so that the same document yields the same etag on every provider
 * — that is what lets a migration verify a copy (see docs/storage.md).
 *
 * CodeQL reaches this sink from config loaders that carry secret-shaped fields
 * and reads it as a password hash. It is not one. What *would* make it one:
 * handing a document's etag to a caller who could use it to confirm a guessed
 * secret. Re-examine this suppression if an etag ever becomes externally
 * visible for a document that stores credentials.
 */
function etagOf(json) {
  return crypto.createHash('sha256').update(json, 'utf8').digest('hex'); // lgtm[js/insufficient-password-hash] -- entity tag over a document body, not a stored password
}

/**
 * The stored body of an envelope together with its canonical JSON, the single
 * source for both `etag` and `size`.
 */
function envelopeBody(envelope) {
  const data = envelope.data === undefined ? null : envelope.data;
  return { data, json: JSON.stringify(data) };
}

/** Serialize document data, rejecting anything JSON cannot represent. */
function serializeData(data) {
  if (data === undefined) {
    throw new StorageError('Document data must not be undefined', { code: 'INVALID_DATA' });
  }
  let json;
  try {
    json = JSON.stringify(data);
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

/** Owner id as stored; anything but a non-empty string reads as unowned. */
function storedOwnerId(envelope) {
  const ownerId = envelope?.ownerId;
  return typeof ownerId === 'string' && ownerId.length > 0 ? ownerId : null;
}

/** Owner id as passed to `put()`: a non-empty string, or null to clear it. */
function requestedOwnerId(ownerId) {
  if (ownerId === undefined || ownerId === null) return null;
  if (typeof ownerId !== 'string' || ownerId.length === 0) {
    throw new InvalidKeyError(`Invalid ownerId: ${String(ownerId).slice(0, 64)}`);
  }
  return ownerId;
}

/**
 * An overwrite that says nothing about the content type keeps the stored one,
 * the same rule `ownerId` follows.
 */
function resolveContentType(contentType, existing) {
  if (typeof contentType === 'string' && contentType.length > 0) return contentType;
  const stored = existing?.contentType;
  if (typeof stored === 'string' && stored.length > 0) return stored;
  return DEFAULT_CONTENT_TYPE;
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
 * Filesystem-backed {@link DocumentStore}.
 *
 * @augments DocumentStore
 */
export class FilesystemDocumentStore extends DocumentStore {
  /**
   * @param {Object} options
   * @param {string} options.baseDir - Absolute directory this store owns
   * @param {{publish: (event: Object) => Promise<void>}} [options.notifier] - Change notifier the
   *   store publishes `document.put` / `document.delete` on; omitted, the store stays silent
   */
  constructor({ baseDir, notifier } = {}) {
    super();
    if (typeof baseDir !== 'string' || baseDir.length === 0) {
      throw new StorageError('FilesystemDocumentStore requires a baseDir', {
        code: 'INVALID_CONFIG'
      });
    }
    this._baseDir = path.resolve(baseDir);
    this._notifier = notifier || null;
  }

  /**
   * Absolute base directory holding every namespace.
   * @returns {string}
   */
  get baseDir() {
    return this._baseDir;
  }

  /**
   * Read one document.
   *
   * @param {string} ns - Namespace
   * @param {string} key - Document key
   * @returns {Promise<Object|null>} The document, or null when it does not exist
   * @throws {InvalidKeyError} When `ns` or `key` is not a safe id
   */
  async get(ns, key) {
    assertValidNamespace(ns);
    assertValidKey(key);
    const envelope = await this._readEnvelope(ns, key);
    if (!envelope) return null;
    return this._toDocument(ns, key, envelope, true);
  }

  /**
   * Create or overwrite a document.
   *
   * @param {string} ns - Namespace
   * @param {string} key - Document key
   * @param {any} data - JSON-serializable body (never `undefined`)
   * @param {Object} [opts]
   * @param {string|null} [opts.ownerId] - Omit to keep the stored owner, null to clear it
   * @param {string|null} [opts.etag] - String for compare-and-set, null for create-only,
   *   omitted for an unconditional write
   * @param {string} [opts.contentType] - Defaults to the stored type, then `application/json`
   * @returns {Promise<Object>} The stored document
   * @throws {EtagMismatchError} When the conditional write does not hold
   * @throws {StorageError} Code `INVALID_DATA` when `data` cannot be serialized
   */
  async put(ns, key, data, opts = {}) {
    assertValidNamespace(ns);
    assertValidKey(key);
    const json = serializeData(data);
    const options = opts || {};

    const expectedEtag = options.etag;
    if (expectedEtag !== undefined && expectedEtag !== null && typeof expectedEtag !== 'string') {
      throw new StorageError('put() etag must be a string, null, or omitted', {
        code: 'INVALID_ETAG'
      });
    }
    // An absent `ownerId` keeps whatever is stored; an explicit null clears it,
    // so presence of the property — not its value — decides.
    const ownerRequested = 'ownerId' in options;
    const nextOwnerId = ownerRequested ? requestedOwnerId(options.ownerId) : null;

    const document = await withFileLock(
      this._lockPath(ns, key),
      async () => {
        // Lenient: an unconditional overwrite is the deliberate repair for a
        // torn document, and the create-only branch below asks `_docExists`
        // rather than this, so it still refuses to write over one.
        const existing = await this._readEnvelope(ns, key, { lenient: true });

        if (expectedEtag === null && existing) {
          throw new EtagMismatchError(`Document ${ns}/${key} already exists`);
        }
        if (typeof expectedEtag === 'string') {
          if (!existing) {
            throw new EtagMismatchError(`Document ${ns}/${key} does not exist`);
          }
          if (etagOf(envelopeBody(existing).json) !== expectedEtag) {
            throw new EtagMismatchError(`Etag mismatch for document ${ns}/${key}`);
          }
        }

        const previousOwnerId = storedOwnerId(existing);
        const ownerId = ownerRequested ? nextOwnerId : previousOwnerId;
        const now = new Date().toISOString();
        const envelope = {
          v: ENVELOPE_VERSION,
          key,
          ownerId,
          contentType: resolveContentType(options.contentType, existing),
          createdAt: typeof existing?.createdAt === 'string' ? existing.createdAt : now,
          updatedAt: now,
          // Store the round-tripped body so what put() returns is exactly what
          // a following get() reads back (JSON drops undefined-valued keys and
          // applies any toJSON()).
          data: JSON.parse(json)
        };

        await fs.mkdir(this._nsDir(ns), { recursive: true });

        if (expectedEtag === null) {
          // O_EXCL decides the create, not the read above, for two reasons
          // that the read cannot cover on its own.
          //
          // `withFileLock` runs its critical section anyway once its 5 s wait
          // expires, so two concurrent creates can both read "absent" and both
          // write, and the second silently replaces the first — with both told
          // they created it.
          //
          // And `_readEnvelope` answers null for a file that exists but does
          // not parse, so a create-only write over a truncated document would
          // be allowed to destroy it. That file is somebody's chat; "it did
          // not parse" is a reason to preserve it for a human, not a licence
          // to overwrite. The filesystem knows the file is there whether or
          // not its contents make sense.
          //
          // Marker first, as below — but recorded, so a create that loses the
          // race does not leave this owner's index pointing at a document that
          // belongs to somebody else. `tryCreateExclusive` reports whether it
          // was this call that created the marker, which is what makes the
          // rollback safe when the winner happens to share the owner.
          const markerPath = ownerId ? this._ownerMarkerPath(ns, ownerId, key) : null;
          const markerCreated = markerPath ? await tryCreateExclusive(markerPath, '') : false;
          try {
            await atomicCreateJSON(this._docPath(ns, key), envelope);
          } catch (error) {
            if (markerCreated) await removeIfExists(markerPath);
            if (error?.code === 'EEXIST') {
              throw new EtagMismatchError(`Document ${ns}/${key} already exists`);
            }
            throw error;
          }
          return this._toDocument(ns, key, envelope, true);
        }

        // Not a create, and nothing parsed — so this write is about to replace
        // a document that is on disk and unreadable. `_readEnvelope` logs that
        // at warn as a read problem; here it is a write destroying the last
        // copy of a body nobody could read, which the operator has to see
        // before the user does. It still proceeds: the alternative is a key
        // that can never be written again.
        if (!existing && (await this._docExists(ns, key))) {
          logger.error('Overwriting a stored document that could not be read', {
            component: COMPONENT,
            ns,
            key
          });
        }

        // The owner marker is written BEFORE the envelope. A crash between the
        // two leaves an index entry pointing at a document that does not
        // exist; list() skips such markers and the next put/delete removes
        // them. The reverse order would leave a stored document that its
        // owner's listing cannot see — invisible data is worse than a
        // dangling index entry.
        if (ownerId) await this._writeOwnerMarker(ns, ownerId, key);
        await atomicWriteJSON(this._docPath(ns, key), envelope);
        // Retire the previous owner's marker only once the new envelope is on
        // disk, so the document is never missing from both indexes at once.
        if (previousOwnerId && previousOwnerId !== ownerId) {
          await removeIfExists(this._ownerMarkerPath(ns, previousOwnerId, key));
        }

        return this._toDocument(ns, key, envelope, true);
      },
      { component: COMPONENT }
    );

    // Published outside the critical section: subscribers must not be able to
    // hold the key's lock while they work.
    await this._publish({ type: 'document.put', ns, key, ownerId: document.ownerId });
    return document;
  }

  /**
   * Remove a document and its index entry.
   *
   * @param {string} ns - Namespace
   * @param {string} key - Document key
   * @returns {Promise<boolean>} True when a document was actually removed
   */
  async delete(ns, key) {
    assertValidNamespace(ns);
    assertValidKey(key);

    const outcome = await withFileLock(
      this._lockPath(ns, key),
      async () => {
        // Lenient: a delete does not need to parse what it is removing, and
        // refusing to remove a torn document would leave the caller no way to
        // clear it.
        const existing = await this._readEnvelope(ns, key, { lenient: true });
        const ownerId = storedOwnerId(existing);
        const removed = await removeIfExists(this._docPath(ns, key));
        // Drop the index entry after the envelope: a marker may outlive its
        // document, never the other way round.
        if (ownerId) await removeIfExists(this._ownerMarkerPath(ns, ownerId, key));
        return { removed, ownerId };
      },
      { component: COMPONENT }
    );

    if (outcome.removed) {
      await this._publish({ type: 'document.delete', ns, key, ownerId: outcome.ownerId });
    }
    return outcome.removed;
  }

  /**
   * List a namespace in ascending key order.
   *
   * @param {string} ns - Namespace
   * @param {Object} [opts]
   * @param {string} [opts.ownerId] - Restrict to one owner; served from the per-owner index
   * @param {string} [opts.prefix] - Keep only keys starting with this prefix
   * @param {number} [opts.limit=100] - Page size, clamped to 1..1000
   * @param {string} [opts.cursor] - Opaque cursor from a previous page
   * @param {boolean} [opts.includeData=true] - False omits `data` and keeps the metadata
   * @returns {Promise<{items: Object[], nextCursor: string|null}>}
   * @throws {StorageError} Code `INVALID_CURSOR` when `cursor` cannot be decoded
   */
  async list(ns, opts = {}) {
    assertValidNamespace(ns);
    const { ownerId, prefix, limit, cursor, includeData = true } = opts || {};
    const pageSize = clampLimit(limit);
    const after = cursor === undefined || cursor === null ? null : decodeCursor(cursor);

    let keys =
      ownerId === undefined || ownerId === null
        ? await this._namespaceKeys(ns)
        : await this._ownerKeys(ns, ownerId);

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
      const envelope = await this._readEnvelope(ns, keys[index], { lenient: true });
      // A missing envelope is a stale owner marker (or a document deleted
      // between the readdir and here). Skip it — never delete it here: a
      // marker whose put has not yet written its envelope looks exactly the
      // same, and removing that one would hide a live document from its owner.
      if (!envelope) continue;
      if (await this._rejectForeign(ns, keys[index], envelope, ownerId)) continue;
      items.push(this._toDocument(ns, keys[index], envelope, includeData !== false));
    }

    const nextCursor =
      index < keys.length && items.length > 0 ? encodeCursor(items[items.length - 1].key) : null;
    return { items, nextCursor };
  }

  /**
   * Walk a namespace once, yielding every document in ascending key order.
   *
   * The cursor-free counterpart to {@link FilesystemDocumentStore#list}. The
   * enumeration and the sort happen once here instead of once per page, which
   * is what makes a whole-namespace read O(N) rather than O(N) per page.
   *
   * Envelopes are read lazily, so a caller that breaks out of the loop pays
   * only for what it consumed.
   *
   * @param {string} ns - Namespace
   * @param {Object} [opts]
   * @param {string} [opts.ownerId] - Restrict to one owner
   * @param {string} [opts.prefix] - Keep only keys starting with this prefix
   * @param {boolean} [opts.includeData=true] - False omits `data`
   * @yields {Object} Documents in ascending key order
   */
  async *scan(ns, opts = {}) {
    assertValidNamespace(ns);
    const { ownerId, prefix, includeData = true } = opts || {};
    let keys =
      ownerId === undefined || ownerId === null
        ? await this._namespaceKeys(ns)
        : await this._ownerKeys(ns, ownerId);
    keys.sort(compareKeys);
    if (typeof prefix === 'string' && prefix.length > 0) {
      keys = keys.filter(key => key.startsWith(prefix));
    }
    for (const key of keys) {
      // Same reasoning as `list`: a missing envelope is a stale owner marker
      // or a document deleted mid-walk, and is skipped rather than removed.
      const envelope = await this._readEnvelope(ns, key, { lenient: true });
      if (!envelope) continue;
      if (await this._rejectForeign(ns, key, envelope, ownerId)) continue;
      yield this._toDocument(ns, key, envelope, includeData !== false);
    }
  }

  /** This store implements `scan`. @returns {boolean} true */
  get supportsScan() {
    return true;
  }

  /**
   * Does this document belong to somebody other than the owner being listed?
   *
   * The owner index is a set of empty marker files, and a change of owner is
   * three steps: write the new marker, write the envelope, remove the old
   * marker. Lose the third — a crash, a full disk — and the previous owner's
   * index claims a document that is no longer theirs, forever. Nothing else
   * re-checks, so `list(ns, {ownerId})` hands that owner the document and its
   * contents.
   *
   * The envelope has already been read by the time this is asked, so the check
   * costs a string comparison and closes it outright rather than leaving the
   * index as the only authority on who owns what.
   *
   * Pruning is safe *here* and nowhere else in this walk: the envelope exists
   * and names a different owner, so this marker is definitively wrong. A
   * *missing* envelope is the case that must never be pruned — it looks
   * identical to a put whose marker has landed and whose envelope has not, and
   * removing that one would hide a live document from its owner.
   *
   * @param {string} ns - Namespace
   * @param {string} key - Document key
   * @param {Object} envelope - The envelope already read for this key
   * @param {string|null|undefined} ownerId - Owner being listed, if any
   * @returns {Promise<boolean>} True when the caller should skip this key
   * @private
   */
  async _rejectForeign(ns, key, envelope, ownerId) {
    if (ownerId === undefined || ownerId === null) return false;
    if (storedOwnerId(envelope) === ownerId) return false;
    logger.warn('Pruning an owner index entry for a document owned by somebody else', {
      component: COMPONENT,
      ns,
      key
    });
    await removeIfExists(this._ownerMarkerPath(ns, ownerId, key));
    return true;
  }

  /** Namespace directory. @private */
  _nsDir(ns) {
    return containedPath(this._baseDir, ns);
  }

  /** Document envelope path. @private */
  _docPath(ns, key) {
    return containedPath(this._baseDir, ns, `${key}${DOC_EXT}`);
  }

  /** Index directory of one owner within a namespace. @private */
  _ownerDir(ns, ownerId) {
    return containedPath(this._baseDir, ns, OWNERS_DIR, ownerSegment(ownerId));
  }

  /** Index marker of one document within one owner's index. @private */
  _ownerMarkerPath(ns, ownerId, key) {
    return containedPath(this._baseDir, ns, OWNERS_DIR, ownerSegment(ownerId), key);
  }

  /**
   * Per-key lock file guarding the read-modify-write of put()/delete().
   *
   * `withFileLock` is advisory and single-machine: it serializes the cluster
   * workers sharing this volume — which is what the etag compare-and-set and
   * the createdAt carry-over need — and nothing beyond them. Like everywhere
   * else in the codebase it proceeds without the lock once its wait expires
   * rather than failing the write; callers that need a hard lease use the
   * provider's LockManager.
   *
   * @private
   */
  _lockPath(ns, key) {
    return containedPath(this._baseDir, ns, LOCKS_DIR, `${key}.lock`);
  }

  /** Write (or heal) the index marker for a document. @private */
  async _writeOwnerMarker(ns, ownerId, key) {
    const marker = this._ownerMarkerPath(ns, ownerId, key);
    await fs.mkdir(path.dirname(marker), { recursive: true });
    // Rewritten on every put so an entry lost to a crash reappears on the next
    // write. The file is empty: its name is the whole payload.
    await fs.writeFile(marker, '', 'utf8');
  }

  /** Keys of every document file directly in a namespace. @private */
  async _namespaceKeys(ns) {
    const entries = await this._readdirSafe(this._nsDir(ns));
    const keys = [];
    for (const entry of entries) {
      if (isReservedEntry(entry) || !entry.endsWith(DOC_EXT)) continue;
      const key = entry.slice(0, -DOC_EXT.length);
      // Only surface names this store would itself accept, so a file dropped
      // into the directory by hand can never reach containedPath().
      if (isValidId(key)) keys.push(key);
    }
    return keys;
  }

  /** Keys held by one owner's index. @private */
  async _ownerKeys(ns, ownerId) {
    const entries = await this._readdirSafe(this._ownerDir(ns, ownerId));
    // The same reserved-name rule as the unfiltered listing, so the owner index
    // can never surface a key the namespace listing hides.
    return entries.filter(entry => !isReservedEntry(entry) && isValidId(entry));
  }

  /** readdir that reports a missing directory as an empty listing. @private */
  async _readdirSafe(dir) {
    try {
      return await fs.readdir(dir);
    } catch (error) {
      // An unknown namespace, or an owner with nothing filed, is an empty
      // listing rather than an error.
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
      throw error;
    }
  }

  /**
   * Is there a file for this key, whatever is in it?
   *
   * Separate from `_readEnvelope` on purpose: that one answers "is there a
   * document I can give you", and a corrupt file is correctly absent by that
   * measure. This one answers "is this key taken", which is what a create has
   * to ask — the two differ exactly when a file has been truncated or edited
   * out of band, and that is the case where overwriting is the wrong move.
   *
   * @private
   */
  async _docExists(ns, key) {
    try {
      await fs.stat(this._docPath(ns, key));
      return true;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
      throw error;
    }
  }

  /**
   * Read and parse an envelope.
   *
   * Absent is null. Present-but-unparseable is an error by default, and the
   * difference matters more than it looks: envelopes are written atomically,
   * so a file that will not parse was truncated or edited out of band — the
   * document is still there. Folding that into null hands the caller "no such
   * document", and the callers act on it. `ChatRepository.ensureChat` sees no
   * chat and writes a fresh one owned by whoever asked, while the transcript —
   * a separate document that still parses — comes along, so a torn chat
   * document silently transfers one user's conversation to another, at warn
   * level. `atomicWriteFile` does not fsync the temp file or the parent
   * directory, so a host crash after the rename can leave exactly that.
   *
   * `lenient` is for the callers that are enumerating rather than fetching. A
   * listing must not fail its whole page because one document in it is torn,
   * and a delete does not need to parse what it is removing — but both log it,
   * at error, so a corrupt document is never silent.
   *
   * Nothing quarantines the file. Moving it aside would make the next
   * `ensureChat` succeed and re-own the chat, which is the outcome this exists
   * to prevent; the file stays where an operator can look at it, and
   * `_docExists` already stops a create from writing over it.
   *
   * @param {string} ns - Namespace.
   * @param {string} key - Document key.
   * @param {Object} [options]
   * @param {boolean} [options.lenient=false] - Report a torn document as
   *   absent instead of throwing.
   * @returns {Promise<Object|null>} The envelope, or null.
   * @throws {CorruptDocumentError} When the file is present but unreadable.
   * @private
   */
  async _readEnvelope(ns, key, { lenient = false } = {}) {
    let raw;
    try {
      raw = await fs.readFile(this._docPath(ns, key), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR') return null;
      throw error;
    }
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch (cause) {
      return this._corrupt(ns, key, lenient, cause);
    }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      return this._corrupt(ns, key, lenient, null);
    }
    return envelope;
  }

  /**
   * Report a document that exists but cannot be read as one.
   *
   * @param {string} ns - Namespace.
   * @param {string} key - Document key.
   * @param {boolean} lenient - Whether to answer null instead of throwing.
   * @param {unknown} cause - The parse error, when there was one.
   * @returns {null} When `lenient`.
   * @throws {CorruptDocumentError} Otherwise.
   * @private
   */
  _corrupt(ns, key, lenient, cause) {
    logger.error('Storage document exists but cannot be read', {
      component: COMPONENT,
      ns,
      key,
      path: this._docPath(ns, key),
      ...(cause ? { error: cause.message } : { reason: 'not a document envelope' })
    });
    if (lenient) return null;
    throw new CorruptDocumentError(`Document ${ns}/${key} is present but unreadable`, {
      ...(cause ? { cause } : {})
    });
  }

  /** Project a stored envelope into the public Document shape. @private */
  _toDocument(ns, key, envelope, includeData) {
    const { data, json } = envelopeBody(envelope);
    const document = {
      ns,
      key,
      ownerId: storedOwnerId(envelope),
      contentType:
        typeof envelope.contentType === 'string' && envelope.contentType.length > 0
          ? envelope.contentType
          : DEFAULT_CONTENT_TYPE,
      createdAt: envelope.createdAt,
      updatedAt: envelope.updatedAt,
      etag: etagOf(json),
      size: Buffer.byteLength(json, 'utf8')
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

export default FilesystemDocumentStore;
