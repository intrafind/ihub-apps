// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Documents on a filesystem: one JSON envelope per key plus a per-owner index.
 *
 * Layout under the provider's base directory:
 *
 *   <base>/<ns>/<key>.json                      the document envelope
 *   <base>/<ns>/.owners/<ownerSegment>/<key>    empty marker file (the per-owner index)
 *   <base>/<ns>/.locks/<key>.lock               transient compare-and-set lock
 *   <base>/<ns>/.prefixes/<partition>/<key>     empty marker file (the key-prefix index,
 *                                               only for namespaces in KEY_PREFIX_SEGMENTS;
 *                                               see ./prefixIndex.js)
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
 * `etag` and `size` are minted by `put` over the canonical serialization of
 * `data` and stored before it, so a metadata read never parses the body.
 *
 * Encryption at rest (#2316). With a sealing mode (see `./atRestContext.js`)
 * a document is stored as envelope version 3: the same file, the same head,
 * but `data` is the encrypted body and the etag is sealed in `tag`
 * (`crypto/documentSeal.js`). Callers see no difference: the etag a read
 * reports is the one `put` returned, in every mode. A stored document is
 * recognised as sealed by `v: 3` alone, never by trying to decrypt it; a
 * version 2 envelope is plaintext, which is read in the modes `off` and
 * `converting` and is an error (`PLAINTEXT_DOCUMENT`) in the mode `enforced`.
 *
 * @module storage/providers/filesystem/FilesystemDocumentStore
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { atomicCreateJSON, atomicWriteJSON, writeInDirectory } from '../../../utils/atomicWrite.js';
import { withFileLock, removeIfExists, tryCreateExclusive } from '../../../utils/fileLock.js';
import { isValidId } from '../../../utils/pathSecurity.js';
import logger from '../../../utils/logger.js';
import { DocumentStore } from '../../DocumentStore.js';
import { documentDigest } from '../../etag.js';
import {
  CorruptDocumentError,
  EtagMismatchError,
  InvalidKeyError,
  PlaintextDocumentError,
  StorageError
} from '../../errors.js';
import { assertValidKey, assertValidNamespace } from '../../keys.js';
import {
  isSealedHead,
  openDocument,
  openDocumentEtag,
  sealDocument
} from '../../../crypto/documentSeal.js';
import { RUNTIME_NAMESPACES } from '../../namespaces.js';
import { AtRestContext } from './atRestContext.js';
import { DOC_EXT, containedPath, ownerSegment } from './paths.js';
import { PREFIXES_DIR, PrefixIndex } from './prefixIndex.js';

const COMPONENT = 'FilesystemDocumentStore';

/**
 * Envelope schema version, so a later layout change can be detected on read.
 *
 * 2 carries `etag` and `size`, written before `data` (migration V247 upgraded
 * the version-1 envelopes, which had neither).
 */
const ENVELOPE_VERSION = 2;

/**
 * Envelope version of a sealed document: the head of version 2 without `etag`,
 * plus the sealed members of `crypto/documentSeal.js`, `data` last.
 */
const SEALED_ENVELOPE_VERSION = 3;

/** Plaintext documents reported once each while encryption is enforced. */
const MAX_REPORTED_PLAINTEXT = 1000;

/** Directories of the base directory that never hold documents. */
const NON_DOCUMENT_DIRS = new Set(['logs', 'blobs', 'locks']);

/** Namespaces this release declares; a legacy envelope is only trusted there. */
const DECLARED_NAMESPACES = new Set([...Object.values(RUNTIME_NAMESPACES), '_health']);

/** Bytes a metadata read takes from the start of an envelope at a time. */
const HEAD_CHUNK = 4096;

/** A stored etag: sha256 hex. */
const ETAG_PATTERN = /^[0-9a-f]{64}$/;

/** Head scanner verdict: the text read so far ends before the metadata does. */
const NEED_MORE = Symbol('need-more');

/** Head scanner verdict: not laid out as this store writes envelopes. */
const NOT_A_HEAD = Symbol('not-a-head');

const DEFAULT_CONTENT_TYPE = 'application/json';
const DEFAULT_LIMIT = 100;
const MIN_LIMIT = 1;
const MAX_LIMIT = 1000;

/**
 * How many document envelopes a page reads at once.
 *
 * The reads inside one page have no order between them, so serializing them
 * bought nothing and cost the whole latency of a listing. Bounded rather than
 * unbounded: a page may ask for up to `MAX_LIMIT` documents, and opening a
 * thousand file handles at once is a different way to be slow — and on a
 * shared volume, a way to be rude to everything else on it.
 */
const READ_CONCURRENCY = 16;

/** Marks a listed document that is present but cannot be parsed. */
const UNREADABLE = Symbol('unreadable');

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
  return (
    entry === OWNERS_DIR ||
    entry === LOCKS_DIR ||
    entry === PREFIXES_DIR ||
    entry.startsWith(TEMP_PREFIX)
  );
}

/**
 * Marks an envelope whose `etag` and `size` were derived on this read because
 * it was stored without them; the value is the whole envelope, body included,
 * so the caller can write the upgraded envelope back.
 */
const LEGACY_ENVELOPE = Symbol('legacy-envelope');

/**
 * Whether an envelope's stored `etag` and `size` are usable.
 *
 * They are minted by `put` — over the canonical JSON of the body, see
 * `storage/canonicalJson.js` and {@link documentDigest} — and stored, so a
 * read never derives them again.
 *
 * @param {Object} envelope - Parsed envelope, or its head
 * @returns {boolean}
 */
function hasStoredDigest(envelope) {
  return (
    typeof envelope.etag === 'string' &&
    ETAG_PATTERN.test(envelope.etag) &&
    Number.isSafeInteger(envelope.size) &&
    envelope.size >= 0
  );
}

/**
 * Whether an envelope is in the format of releases before migration V247: a
 * document envelope (it has `data`, and the key it names is this one) with no
 * `etag` and no `size` at all.
 *
 * Such envelopes keep appearing after the migration has run — a rollback to
 * the previous release that kept writing, a restore of `contents/data` from a
 * backup taken before the upgrade, an older release on the same volume, a
 * script or fixture writing files — and they hold somebody's chats, projects
 * and runs. They are read (their etag derived the way it always was) and
 * upgraded in place, never reported as corrupt. An envelope whose etag or size
 * is present but malformed is something else and stays corrupt.
 *
 * @param {Object} envelope - Parsed envelope
 * @param {string} key - Key the file is stored under
 * @returns {boolean}
 */
function isLegacyEnvelope(envelope, key) {
  return (
    envelope.etag === undefined &&
    envelope.size === undefined &&
    Object.hasOwn(envelope, 'data') &&
    (envelope.key === undefined || envelope.key === key)
  );
}

/**
 * Remember on an envelope (or its head) the full legacy envelope it came from.
 * Non-enumerable, so it never reaches a spread copy or a serialization.
 *
 * @param {Object} target - Envelope or head to mark
 * @param {Object} envelope - The full legacy envelope
 * @returns {Object} `target`
 */
function markLegacy(target, envelope) {
  Object.defineProperty(target, LEGACY_ENVELOPE, { value: envelope, enumerable: false });
  return target;
}

/**
 * Index just past the closing quote of the JSON string starting at `start`.
 *
 * @param {string} text - Text being scanned
 * @param {number} start - Index of the opening quote
 * @returns {number} Index after the closing quote, or -1 when the text ends first
 */
function stringEnd(text, start) {
  for (let i = start + 1; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\\') i += 1;
    else if (char === '"') return i + 1;
  }
  return -1;
}

const isJsonSpace = char => char === ' ' || char === '\n' || char === '\r' || char === '\t';

/**
 * The metadata of an envelope from the start of its text, without the body.
 *
 * Walks the top-level members in order and stops at `data`, which `put`
 * always writes last. Every member before it is a primitive (a string, a
 * number, null), so the walk only ever parses those small values — never a
 * byte of the body.
 *
 * @param {string} text - The start of the envelope file
 * @returns {Object|NEED_MORE|NOT_A_HEAD} The members before `data`; NEED_MORE
 *   when `text` ends first; NOT_A_HEAD when the file is not laid out like that.
 */
function scanEnvelopeHead(text) {
  const head = {};
  const n = text.length;
  let i = 0;
  const skipSpace = () => {
    while (i < n && isJsonSpace(text[i])) i += 1;
  };
  skipSpace();
  if (i >= n) return NEED_MORE;
  if (text[i] !== '{') return NOT_A_HEAD;
  i += 1;
  for (;;) {
    skipSpace();
    if (i >= n) return NEED_MORE;
    if (text[i] === '}') return head;
    if (text[i] !== '"') return NOT_A_HEAD;
    const nameEnd = stringEnd(text, i);
    if (nameEnd === -1) return NEED_MORE;
    let name;
    try {
      name = JSON.parse(text.slice(i, nameEnd));
    } catch {
      return NOT_A_HEAD;
    }
    i = nameEnd;
    skipSpace();
    if (i >= n) return NEED_MORE;
    if (text[i] !== ':') return NOT_A_HEAD;
    i += 1;
    skipSpace();
    if (i >= n) return NEED_MORE;
    if (name === 'data') return head;

    let valueEnd;
    if (text[i] === '"') {
      valueEnd = stringEnd(text, i);
      if (valueEnd === -1) return NEED_MORE;
    } else if (text[i] === '{' || text[i] === '[') {
      return NOT_A_HEAD; // metadata members are primitives
    } else {
      valueEnd = i;
      while (valueEnd < n && text[valueEnd] !== ',' && text[valueEnd] !== '}') {
        if (isJsonSpace(text[valueEnd])) break;
        valueEnd += 1;
      }
      if (valueEnd >= n) return NEED_MORE;
    }
    let value;
    try {
      value = JSON.parse(text.slice(i, valueEnd));
    } catch {
      return NOT_A_HEAD;
    }
    if (name !== '__proto__') head[name] = value;
    i = valueEnd;
    skipSpace();
    if (i >= n) return NEED_MORE;
    if (text[i] === ',') {
      i += 1;
    } else if (text[i] === '}') {
      return head;
    } else {
      return NOT_A_HEAD;
    }
  }
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
   * @param {Record<string, number>} [options.keyPrefixSegments] - Namespaces kept in the
   *   key-prefix index; defaults to `KEY_PREFIX_SEGMENTS`. `{}` switches it off (tests)
   * @param {AtRestContext} [options.atRest] - Encryption mode and key access,
   *   shared with the provider's append log; omitted, documents are plaintext
   */
  constructor({ baseDir, notifier, keyPrefixSegments, atRest } = {}) {
    super();
    if (typeof baseDir !== 'string' || baseDir.length === 0) {
      throw new StorageError('FilesystemDocumentStore requires a baseDir', {
        code: 'INVALID_CONFIG'
      });
    }
    this._baseDir = path.resolve(baseDir);
    this._notifier = notifier || null;
    this._prefixIndex = new PrefixIndex(keyPrefixSegments);
    this._atRest = atRest || new AtRestContext();
    /** Keys of plaintext documents already reported in the mode `enforced`. */
    this._reportedPlaintext = new Set();
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
    if (envelope[LEGACY_ENVELOPE]) await this._upgradeLegacyEnvelopes(ns, [[key, envelope]]);
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
        // rather than this, so it still refuses to write over one. The head
        // is all a write needs of the stored document (etag, owner, content
        // type, createdAt), so the previous body is never parsed.
        //
        // A sealed head is opened (its tag, 64 bytes) when the write depends
        // on it: for a compare-and-set, and when the owner or the content
        // type is carried over. Opening is what authenticates those two
        // members, so an owner edited into the head on disk is never sealed
        // into the next version. A create-only write, and an overwrite that
        // names both, open nothing and need no key for the old document.
        const inheritsHead =
          !ownerRequested ||
          !(typeof options.contentType === 'string' && options.contentType.length > 0);
        const existing = await this._readEnvelopeHead(ns, key, {
          lenient: true,
          openEtag: expectedEtag !== null && (typeof expectedEtag === 'string' || inheritsHead)
        });

        if (expectedEtag === null && existing) {
          throw new EtagMismatchError(`Document ${ns}/${key} already exists`);
        }
        if (typeof expectedEtag === 'string') {
          if (!existing) {
            throw new EtagMismatchError(`Document ${ns}/${key} does not exist`);
          }
          if (existing.etag !== expectedEtag) {
            throw new EtagMismatchError(`Etag mismatch for document ${ns}/${key}`);
          }
        }

        const previousOwnerId = storedOwnerId(existing);
        const ownerId = ownerRequested ? nextOwnerId : previousOwnerId;
        const now = new Date().toISOString();
        // Store the round-tripped body so what put() returns is exactly what a
        // following get() reads back (JSON drops undefined-valued keys and
        // applies any toJSON()).
        const body = JSON.parse(json);
        const envelope = {
          v: ENVELOPE_VERSION,
          key,
          ownerId,
          contentType: resolveContentType(options.contentType, existing),
          createdAt: typeof existing?.createdAt === 'string' ? existing.createdAt : now,
          updatedAt: now,
          // Minted once here and stored, before `data`, so every later read —
          // a metadata-only listing above all — takes them from the start of
          // the file instead of re-hashing the body.
          ...documentDigest(body),
          data: body
        };
        // What goes to disk: the envelope itself, or its sealed form. What is
        // returned is built from `envelope` either way, so the caller gets the
        // same document, etag included, in every mode.
        const stored = this._atRest.writesSealed
          ? await this._sealEnvelope(ns, key, envelope, json)
          : envelope;

        // The namespace directory is created by the first write that finds it
        // missing (`writeInDirectory`), not by a `mkdir` on every put.
        const nsDir = this._nsDir(ns);

        if (expectedEtag === null) {
          // O_EXCL decides the create, not the read above, for two reasons
          // that the read cannot cover on its own.
          //
          // The advisory lock is the first line of defence, but it is advisory
          // and single-machine (a lease taken over from a stalled holder, a
          // shared volume whose O_EXCL is not honoured): if two creates ever
          // both read "absent", they would both write, and the second would
          // silently replace the first — with both told they created it.
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
          // The prefix marker is left in place when the create loses: the key
          // then holds the winner's document, which belongs in the partition.
          await this._prefixIndex.writeMarker(nsDir, ns, key);
          try {
            await writeInDirectory(nsDir, () => atomicCreateJSON(this._docPath(ns, key), stored));
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
        // Same order for the key-prefix index, same reason.
        await this._prefixIndex.writeMarker(nsDir, ns, key);
        // Store documents always carry the default mode, so there is none to
        // carry over (`keepMode: false` skips the stat and the chmod). Both
        // fsyncs stay.
        await writeInDirectory(nsDir, () =>
          atomicWriteJSON(this._docPath(ns, key), stored, { keepMode: false })
        );
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
        const existing = await this._readEnvelopeHead(ns, key, {
          lenient: true,
          requireDigest: false
        });
        const ownerId = storedOwnerId(existing);
        const removed = await removeIfExists(this._docPath(ns, key));
        // Drop the index entry after the envelope: a marker may outlive its
        // document, never the other way round.
        if (ownerId) await removeIfExists(this._ownerMarkerPath(ns, ownerId, key));
        try {
          await this._prefixIndex.removeMarker(this._nsDir(ns), ns, key);
        } catch (error) {
          // The document is gone; a leftover marker is skipped by listings.
          logger.warn('Could not remove the prefix index entry of a deleted document', {
            component: COMPONENT,
            ns,
            key,
            error: error.message
          });
        }
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
   * @returns {Promise<{items: Object[], nextCursor: string|null, skipped?: number}>}
   *   `skipped` counts documents present but unreadable, when there were any
   * @throws {StorageError} Code `INVALID_CURSOR` when `cursor` cannot be decoded
   */
  async list(ns, opts = {}) {
    assertValidNamespace(ns);
    const { ownerId, prefix, limit, cursor, includeData = true } = opts || {};
    const withData = includeData !== false;
    const pageSize = clampLimit(limit);
    const after = cursor === undefined || cursor === null ? null : decodeCursor(cursor);

    let keys = await this._listingKeys(ns, ownerId, prefix);

    keys.sort(compareKeys);
    if (typeof prefix === 'string' && prefix.length > 0) {
      keys = keys.filter(key => key.startsWith(prefix));
    }
    if (after !== null) {
      keys = keys.filter(key => key > after);
    }

    const items = [];
    // Read in parallel batches rather than one document at a time. A page is
    // assembled from the keys in order, but the reads have no order between
    // them, and serially they were the whole cost of a listing: an owner at the
    // shipped `maxChatsPerUser` of 200 paid 200 `readFile`s, parses and sha256s
    // to return 30 rows, once per call — and the chat list is invalidated after
    // every completed turn. On a shared NFS volume at a few ms per read that is
    // most of a second of strictly serialized I/O before the sidebar paints.
    let consumed = 0;
    let skipped = 0;
    const legacy = [];
    while (consumed < keys.length && items.length < pageSize) {
      const batch = keys.slice(consumed, consumed + READ_CONCURRENCY);
      // Not `lenient`: a torn document is still skipped, but counted, so the
      // page can say it is not the whole set (`skipped`).
      const envelopes = await Promise.all(
        batch.map(key =>
          (withData ? this._readEnvelope(ns, key) : this._readEnvelopeHead(ns, key)).catch(
            error => {
              if (error instanceof CorruptDocumentError) return UNREADABLE;
              throw error;
            }
          )
        )
      );
      let taken = 0;
      for (let offset = 0; offset < batch.length && items.length < pageSize; offset += 1) {
        // Counted before the skips, so `consumed` means "keys this page has
        // looked at" — a batch that is half rejected must not be read again.
        taken = offset + 1;
        const key = batch[offset];
        const envelope = envelopes[offset];
        if (envelope === UNREADABLE) {
          skipped += 1;
          continue;
        }
        // A missing envelope is a stale owner marker (or a document deleted
        // between the readdir and here). Skip it — never delete it here: a
        // marker whose put has not yet written its envelope looks exactly the
        // same, and removing that one would hide a live document from its owner.
        if (!envelope) continue;
        if (await this._rejectForeign(ns, key, envelope, ownerId)) continue;
        if (envelope[LEGACY_ENVELOPE]) legacy.push([key, envelope]);
        items.push(this._toDocument(ns, key, envelope, withData));
      }
      consumed += taken;
    }
    if (legacy.length > 0) await this._upgradeLegacyEnvelopes(ns, legacy);

    const nextCursor =
      consumed < keys.length && items.length > 0 ? encodeCursor(items.at(-1).key) : null;
    return { items, nextCursor, ...(skipped > 0 ? { skipped } : {}) };
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
    let keys = await this._listingKeys(ns, ownerId, prefix);
    keys.sort(compareKeys);
    if (typeof prefix === 'string' && prefix.length > 0) {
      keys = keys.filter(key => key.startsWith(prefix));
    }
    const upgrades = { upgraded: 0, failed: 0 };
    try {
      // Read ahead one batch at a time, as `list` does: one document after the
      // other made a walk over a user's files slower than the paged listing it
      // replaced, which read each page in parallel.
      for (let start = 0; start < keys.length; start += READ_CONCURRENCY) {
        const batch = keys.slice(start, start + READ_CONCURRENCY);
        const envelopes = await Promise.all(
          batch.map(key =>
            includeData !== false
              ? this._readEnvelope(ns, key, { lenient: true })
              : this._readEnvelopeHead(ns, key, { lenient: true })
          )
        );
        for (let offset = 0; offset < batch.length; offset += 1) {
          const key = batch[offset];
          const envelope = envelopes[offset];
          // Same reasoning as `list`: a missing envelope is a stale owner marker
          // or a document deleted mid-walk, and is skipped rather than removed.
          if (!envelope) continue;
          if (await this._rejectForeign(ns, key, envelope, ownerId)) continue;
          if (envelope[LEGACY_ENVELOPE]) {
            if (await this._upgradeLegacyEnvelope(ns, key, envelope[LEGACY_ENVELOPE])) {
              upgrades.upgraded += 1;
            } else {
              upgrades.failed += 1;
            }
          }
          yield this._toDocument(ns, key, envelope, includeData !== false);
        }
      }
    } finally {
      // One line per walk, however many documents it upgraded.
      this._logLegacyUpgrades(ns, upgrades);
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
    // Rewritten on every put so an entry lost to a crash reappears on the next
    // write. The file is empty: its name is the whole payload.
    await writeInDirectory(path.dirname(marker), () => fs.writeFile(marker, '', 'utf8'));
  }

  /**
   * The candidate keys of a listing, unsorted and not yet prefix-filtered: the
   * owner's index for an owner listing, the key-prefix index when the prefix
   * pins one partition, the whole namespace directory otherwise.
   *
   * @param {string} ns - Namespace
   * @param {string|null|undefined} ownerId - Owner filter
   * @param {string|undefined} prefix - Prefix filter
   * @returns {Promise<string[]>}
   * @private
   */
  async _listingKeys(ns, ownerId, prefix) {
    if (ownerId !== undefined && ownerId !== null) return this._ownerKeys(ns, ownerId);
    const partition = this._prefixIndex.partition(ns, prefix);
    if (partition) return this._prefixIndex.keys(this._nsDir(ns), partition);
    return this._namespaceKeys(ns);
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
   * level. `atomicWriteFile` fsyncs the temp file and the parent directory,
   * so a host crash should leave the old envelope or the new one; a torn file
   * comes from a disk or filesystem that does not honour that, a hand edit, or
   * a copy taken mid-write.
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
    // The version alone says whether a document is sealed. Nothing below
    // tries to decrypt a plaintext envelope or to parse a sealed one.
    if (envelope.v === SEALED_ENVELOPE_VERSION) return this._openSealed(ns, key, envelope, lenient);
    if (this._atRest.rejectsPlaintext) return this._plaintext(ns, key, lenient);
    if (hasStoredDigest(envelope)) return envelope;
    if (isLegacyEnvelope(envelope, key)) {
      // Derived the way releases before V247 derived it on every read — the
      // same values — for this document only; the caller writes it back.
      const data = envelope.data === undefined ? null : envelope.data;
      Object.assign(envelope, documentDigest(data));
      // While documents are being sealed the conversion rewrites it, sealed;
      // writing the plaintext upgrade first would be a write for nothing.
      return this._atRest.writesSealed ? envelope : markLegacy(envelope, envelope);
    }
    return this._corrupt(ns, key, lenient, null, 'malformed stored etag or size');
  }

  /**
   * The address a sealed document is bound to: where the caller asked for it,
   * and the owner and content type its head names. Those two come from the
   * file and are authenticated by opening the document with them.
   *
   * @param {string} ns - Namespace.
   * @param {string} key - Document key.
   * @param {Object} head - Envelope or its head.
   * @returns {import('../../../crypto/documentSeal.js').DocumentAddress}
   * @private
   */
  _address(ns, key, head) {
    return {
      tenant: this._atRest.tenant,
      ns,
      key,
      ownerId: storedOwnerId(head),
      contentType:
        typeof head.contentType === 'string' && head.contentType.length > 0
          ? head.contentType
          : DEFAULT_CONTENT_TYPE
    };
  }

  /**
   * Seal an envelope for the disk.
   *
   * @param {string} ns - Namespace.
   * @param {string} key - Document key.
   * @param {Object} envelope - The plaintext envelope (`etag`, `size`, `data`).
   * @param {string} json - `envelope.data` as JSON text.
   * @returns {Promise<Object>} Envelope version 3.
   * @throws {KeyUnavailableError} When the data key cannot be wrapped. Nothing
   *   is written then; there is no plaintext fallback.
   * @private
   */
  async _sealEnvelope(ns, key, envelope, json) {
    const keyProvider = await this._atRest.keyProvider();
    let sealed;
    try {
      sealed = await sealDocument({
        keyProvider,
        address: this._address(ns, key, envelope),
        json,
        etag: envelope.etag
      });
    } catch (error) {
      throw (
        this._atRest.keyFailure(error, `document ${ns}/${key}`) ||
        new StorageError(`Document ${ns}/${key} could not be sealed`, {
          code: 'IO_ERROR',
          cause: error
        })
      );
    }
    return {
      v: SEALED_ENVELOPE_VERSION,
      key,
      ownerId: envelope.ownerId,
      contentType: envelope.contentType,
      createdAt: envelope.createdAt,
      updatedAt: envelope.updatedAt,
      size: envelope.size,
      ...sealed
    };
  }

  /**
   * Whether the head of a version 3 envelope is one this store wrote.
   *
   * @param {Object} head - Envelope or its head.
   * @returns {boolean}
   * @private
   */
  _isSealedHead(head) {
    return isSealedHead(head) && Number.isSafeInteger(head.size) && head.size >= 0;
  }

  /**
   * Open a sealed envelope into the plaintext form the rest of the store
   * works with.
   *
   * @param {string} ns - Namespace.
   * @param {string} key - Document key.
   * @param {Object} envelope - The stored envelope, version 3.
   * @param {boolean} lenient - Answer null for a document that does not open.
   * @returns {Promise<Object|null>}
   * @throws {CorruptDocumentError} When it does not open (and not `lenient`).
   * @throws {KeyUnavailableError} When the key is not here, `lenient` or not.
   * @private
   */
  async _openSealed(ns, key, envelope, lenient) {
    if (!this._isSealedHead(envelope)) {
      return this._corrupt(ns, key, lenient, null, 'malformed sealed envelope');
    }
    const keyProvider = await this._atRest.keyProvider();
    let opened;
    let data;
    try {
      opened = await openDocument({
        keyProvider,
        address: this._address(ns, key, envelope),
        envelope
      });
      data = JSON.parse(opened.json);
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        const keyError = this._atRest.keyFailure(error, `document ${ns}/${key}`);
        if (keyError) throw keyError;
      }
      return this._corrupt(
        ns,
        key,
        lenient,
        null,
        `sealed document does not open (${error.code || 'not JSON'})`
      );
    }
    return {
      v: SEALED_ENVELOPE_VERSION,
      key,
      ownerId: envelope.ownerId,
      contentType: envelope.contentType,
      createdAt: envelope.createdAt,
      updatedAt: envelope.updatedAt,
      etag: opened.etag,
      size: envelope.size,
      data
    };
  }

  /**
   * Report a plaintext document found while encryption is enforced. Logged
   * once per key: a listing that meets it on every page must not fill the log.
   *
   * @param {string} ns - Namespace.
   * @param {string} key - Document key.
   * @param {boolean} lenient - Whether to answer null instead of throwing.
   * @returns {null} When `lenient`.
   * @throws {PlaintextDocumentError} Otherwise.
   * @private
   */
  _plaintext(ns, key, lenient) {
    const id = `${ns}/${key}`;
    if (!this._reportedPlaintext.has(id)) {
      if (this._reportedPlaintext.size >= MAX_REPORTED_PLAINTEXT) this._reportedPlaintext.clear();
      this._reportedPlaintext.add(id);
      logger.error('A stored document is not encrypted although encryption at rest is enforced', {
        component: COMPONENT,
        code: 'PLAINTEXT_DOCUMENT',
        ns,
        key,
        path: this._docPath(ns, key)
      });
    }
    if (lenient) return null;
    throw new PlaintextDocumentError(
      `Document ${ns}/${key} is stored in plaintext although encryption at rest is enforced`
    );
  }

  /**
   * Read the metadata of an envelope — everything before `data` — without
   * parsing the body.
   *
   * `put` writes `data` last and every member before it is a primitive, so
   * the head is read from the start of the file a few kilobytes at a time and
   * the body is never decoded past its first bytes. A file that is not laid
   * out that way (written by hand, say) is parsed whole instead, and so is an
   * envelope stored without `etag` and `size` (see {@link isLegacyEnvelope}):
   * its digest has to be derived from the body this once.
   *
   * @param {string} ns - Namespace.
   * @param {string} key - Document key.
   * @param {Object} [options]
   * @param {boolean} [options.lenient=false] - Report a torn document as
   *   absent instead of throwing.
   * @param {boolean} [options.requireDigest=true] - False for a caller that
   *   only needs the owner (a delete), so an envelope without a stored etag
   *   can still be removed together with its index entry.
   * @param {boolean} [options.openEtag=true] - False for a caller that does
   *   not need the etag of a sealed document; its head is then returned as
   *   stored, without `etag`, unauthenticated, and no key is needed.
   * @returns {Promise<Object|null>} The envelope without `data`, or null.
   * @throws {CorruptDocumentError} When the file is present but unreadable.
   * @throws {KeyUnavailableError} When a sealed etag is needed and the key is
   *   not here, `lenient` or not.
   * @private
   */
  async _readEnvelopeHead(
    ns,
    key,
    { lenient = false, requireDigest = true, openEtag = true } = {}
  ) {
    let handle;
    try {
      handle = await fs.open(this._docPath(ns, key), 'r');
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR') return null;
      throw error;
    }
    let head;
    try {
      let buffer = Buffer.alloc(0);
      for (;;) {
        const chunk = Buffer.alloc(HEAD_CHUNK);
        const { bytesRead } = await handle.read(chunk, 0, HEAD_CHUNK, buffer.length);
        if (bytesRead > 0) buffer = Buffer.concat([buffer, chunk.subarray(0, bytesRead)]);
        head = scanEnvelopeHead(buffer.toString('utf8'));
        if (head !== NEED_MORE) break;
        if (bytesRead === 0) {
          head = NOT_A_HEAD; // the file ended inside the metadata
          break;
        }
      }
    } catch (error) {
      if (error.code === 'EISDIR') return null;
      throw error;
    } finally {
      await handle.close();
    }

    if (head !== NOT_A_HEAD && head.v === SEALED_ENVELOPE_VERSION) {
      if (!requireDigest) return head;
      if (!this._isSealedHead(head)) {
        return this._corrupt(ns, key, lenient, null, 'malformed sealed envelope');
      }
      if (!openEtag) return head;
      const keyProvider = await this._atRest.keyProvider();
      try {
        const etag = await openDocumentEtag({
          keyProvider,
          address: this._address(ns, key, head),
          head
        });
        return { ...head, etag };
      } catch (error) {
        const keyError = this._atRest.keyFailure(error, `document ${ns}/${key}`);
        if (keyError) throw keyError;
        return this._corrupt(
          ns,
          key,
          lenient,
          null,
          `sealed document does not open (${error.code})`
        );
      }
    }
    // A plaintext head. A delete (`requireDigest: false`) still reads the
    // owner from it; every other caller gets no plaintext once it is enforced.
    if (head !== NOT_A_HEAD && requireDigest && this._atRest.rejectsPlaintext) {
      return this._plaintext(ns, key, lenient);
    }

    const needsWhole =
      head === NOT_A_HEAD || (requireDigest && head.etag === undefined && head.size === undefined);
    if (needsWhole) {
      let whole;
      try {
        whole = await this._readEnvelope(ns, key, { lenient: lenient || !requireDigest });
      } catch (error) {
        if (!requireDigest && error instanceof CorruptDocumentError) return null;
        throw error;
      }
      if (!whole) return null;
      const { data: _data, ...rest } = whole;
      return whole[LEGACY_ENVELOPE] ? markLegacy(rest, whole) : rest;
    }
    if (requireDigest && !hasStoredDigest(head)) {
      return this._corrupt(ns, key, lenient, null, 'malformed stored etag or size');
    }
    return head;
  }

  /**
   * Write envelopes read in the pre-V247 format back with their `etag` and
   * `size`, and log the outcome once.
   *
   * @param {string} ns - Namespace.
   * @param {Array<[string, Object]>} entries - Keys with the envelope (or head)
   *   each was read as.
   * @returns {Promise<void>}
   * @private
   */
  async _upgradeLegacyEnvelopes(ns, entries) {
    const upgrades = { upgraded: 0, failed: 0 };
    for (const [key, envelope] of entries) {
      if (await this._upgradeLegacyEnvelope(ns, key, envelope[LEGACY_ENVELOPE] || envelope)) {
        upgrades.upgraded += 1;
      } else {
        upgrades.failed += 1;
      }
    }
    this._logLegacyUpgrades(ns, upgrades);
  }

  /**
   * Write one pre-V247 envelope back with the `etag` and `size` derived for it.
   *
   * Not an edit: `data`, `ownerId`, `contentType`, `createdAt` and `updatedAt`
   * are kept as they were, and no change event is published. Under the
   * document's lock, and only if the file is still the envelope that was read
   * — still without an etag and with the same `updatedAt` — so a write that
   * landed in between is never overwritten. A failure is logged and otherwise
   * ignored: the document was already returned, the next read tries again.
   *
   * @param {string} ns - Namespace.
   * @param {string} key - Document key.
   * @param {Object} envelope - The legacy envelope as read, `etag`/`size` derived.
   * @returns {Promise<boolean>} True when the upgraded envelope was written.
   * @private
   */
  async _upgradeLegacyEnvelope(ns, key, envelope) {
    try {
      return await withFileLock(
        this._lockPath(ns, key),
        async () => {
          const current = await this._readEnvelopeHead(ns, key, {
            lenient: true,
            requireDigest: false
          });
          if (
            !current ||
            current.etag !== undefined ||
            current.size !== undefined ||
            current.updatedAt !== envelope.updatedAt
          ) {
            return false;
          }
          const upgraded = {
            v: ENVELOPE_VERSION,
            key,
            ownerId: envelope.ownerId ?? null,
            ...(envelope.contentType === undefined ? {} : { contentType: envelope.contentType }),
            createdAt: envelope.createdAt,
            updatedAt: envelope.updatedAt,
            etag: envelope.etag,
            size: envelope.size,
            data: envelope.data === undefined ? null : envelope.data
          };
          await atomicWriteJSON(this._docPath(ns, key), upgraded);
          return true;
        },
        { component: COMPONENT }
      );
    } catch (error) {
      logger.error('Could not write back a document upgraded with its etag and size', {
        component: COMPONENT,
        ns,
        key,
        error: error.message
      });
      return false;
    }
  }

  /**
   * One warning for every pre-V247 envelope a read came across.
   *
   * @param {string} ns - Namespace.
   * @param {{upgraded: number, failed: number}} upgrades - Counts.
   * @private
   */
  _logLegacyUpgrades(ns, { upgraded, failed }) {
    if (upgraded + failed === 0) return;
    logger.warn('Read documents stored without etag and size; upgraded them in place', {
      component: COMPONENT,
      ns,
      upgraded,
      ...(failed > 0 ? { notUpgraded: failed } : {})
    });
  }

  /**
   * Report a document that exists but cannot be read as one.
   *
   * @param {string} ns - Namespace.
   * @param {string} key - Document key.
   * @param {boolean} lenient - Whether to answer null instead of throwing.
   * @param {unknown} cause - The parse error, when there was one.
   * @param {string} [reason] - What is wrong, when there is no parse error.
   * @returns {null} When `lenient`.
   * @throws {CorruptDocumentError} Otherwise.
   * @private
   */
  _corrupt(ns, key, lenient, cause, reason = 'not a document envelope') {
    logger.error('Storage document exists but cannot be read', {
      component: COMPONENT,
      ns,
      key,
      path: this._docPath(ns, key),
      ...(cause ? { error: cause.message } : { reason })
    });
    if (lenient) return null;
    throw new CorruptDocumentError(`Document ${ns}/${key} is present but unreadable`, {
      ...(cause ? { cause } : {})
    });
  }

  /**
   * The namespaces that hold documents on disk, for the one-time conversion
   * (`storage/atRest/convert.js`): every declared runtime namespace that has
   * a directory, and every other directory that carries this store's
   * bookkeeping (`.locks`, `.owners`, `.prefixes`), which is what a namespace
   * of a removed feature still looks like.
   *
   * Found on disk and not taken from the declaration alone, so nothing a
   * former release wrote stays plaintext. Not every directory either: the
   * data directory also holds files of other subsystems (token files, usage
   * counters), which are not documents and must never be rewritten.
   *
   * @returns {Promise<string[]>} Sorted namespace names.
   */
  async atRestNamespaces() {
    let entries;
    try {
      entries = await fs.readdir(this._baseDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const found = [];
    for (const entry of entries) {
      const name = entry.name;
      if (!entry.isDirectory() || name.startsWith('.') || NON_DOCUMENT_DIRS.has(name)) continue;
      if (!isValidId(name)) continue;
      if (DECLARED_NAMESPACES.has(name)) {
        found.push(name);
        continue;
      }
      const inside = await this._readdirSafe(path.join(this._baseDir, name));
      if ([OWNERS_DIR, LOCKS_DIR, PREFIXES_DIR].some(dir => inside.includes(dir))) found.push(name);
    }
    return found.sort(compareKeys);
  }

  /**
   * Keys of every document file of a namespace, for the conversion.
   *
   * @param {string} ns - Namespace.
   * @returns {Promise<string[]>} Sorted keys.
   */
  async atRestKeys(ns) {
    assertValidNamespace(ns);
    return (await this._namespaceKeys(ns)).sort(compareKeys);
  }

  /**
   * How one stored document stands: sealed, plaintext, or not readable as a
   * document at all. Reads the file and parses it; opens nothing.
   *
   * @param {string} ns - Namespace.
   * @param {string} key - Document key.
   * @returns {Promise<{state: 'sealed'|'plain'|'unreadable'|'missing', bytes: number,
   *   envelope?: Object}>} `bytes` is the file size; `envelope` the parsed file
   *   of a plaintext document.
   */
  async inspectAtRest(ns, key) {
    assertValidNamespace(ns);
    assertValidKey(key);
    let raw;
    try {
      raw = await fs.readFile(this._docPath(ns, key), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR') return { state: 'missing', bytes: 0 };
      throw error;
    }
    const bytes = Buffer.byteLength(raw, 'utf8');
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      return { state: 'unreadable', bytes };
    }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      return { state: 'unreadable', bytes };
    }
    if (envelope.v === SEALED_ENVELOPE_VERSION) {
      const sealed = this._isSealedHead(envelope) && typeof envelope.data === 'string';
      return { state: sealed ? 'sealed' : 'unreadable', bytes };
    }
    if (hasStoredDigest(envelope) && Object.hasOwn(envelope, 'data')) {
      return { state: 'plain', bytes, envelope };
    }
    // A pre-V247 envelope has no marker of its own beyond `data`, so it is
    // only taken for a document where this release expects documents.
    if (DECLARED_NAMESPACES.has(ns) && isLegacyEnvelope(envelope, key)) {
      const data = envelope.data === undefined ? null : envelope.data;
      return { state: 'plain', bytes, envelope: { ...envelope, ...documentDigest(data), data } };
    }
    return { state: 'unreadable', bytes };
  }

  /**
   * Seal one plaintext document in place, for the conversion. Not an edit:
   * owner, content type, both timestamps and the etag are kept, the owner and
   * prefix markers are not touched and no change event is published. Under
   * the document's lock; the file is replaced in one rename, so a reader sees
   * the plaintext or the sealed envelope, never a mix.
   *
   * @param {string} ns - Namespace.
   * @param {string} key - Document key.
   * @returns {Promise<'sealed'|'already'|'unreadable'|'missing'>} `already`
   *   when it was sealed before; `unreadable` when the file is not a document
   *   (left as it is).
   * @throws {KeyUnavailableError} When the data key cannot be wrapped.
   */
  async sealAtRest(ns, key) {
    return withFileLock(
      this._lockPath(ns, key),
      async () => {
        const found = await this.inspectAtRest(ns, key);
        if (found.state === 'sealed') return 'already';
        if (found.state !== 'plain') return found.state;
        const { envelope } = found;
        const plain = {
          key,
          ownerId: storedOwnerId(envelope),
          contentType: this._address(ns, key, envelope).contentType,
          createdAt: envelope.createdAt,
          updatedAt: envelope.updatedAt,
          etag: envelope.etag,
          size: envelope.size
        };
        const stored = await this._sealEnvelope(ns, key, plain, JSON.stringify(envelope.data));
        await atomicWriteJSON(this._docPath(ns, key), stored, { keepMode: false });
        return 'sealed';
      },
      { component: COMPONENT }
    );
  }

  /** Project a stored envelope into the public Document shape. @private */
  _toDocument(ns, key, envelope, includeData) {
    const data = envelope.data === undefined ? null : envelope.data;
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
      // Stored by `put` (see hasStoredDigest), never derived on read.
      etag: envelope.etag,
      size: envelope.size
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
