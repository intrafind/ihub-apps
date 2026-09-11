/**
 * Path helpers shared by every facet of the filesystem storage provider.
 *
 * Everything that turns caller-supplied text (namespace, key, stream name,
 * blob name, owner id) into a path lives here, so the containment rules are
 * written once and the documents, append-logs and locks all inherit the same
 * ones. The rule throughout: validate the segment with `pathSecurity.isValidId()`
 * first, then resolve it under the provider's base directory and refuse
 * anything that lands outside.
 *
 * @module storage/providers/filesystem/paths
 */
import path from 'path';
import crypto from 'crypto';
import { isValidId } from '../../../utils/pathSecurity.js';
import { InvalidKeyError, StorageError } from '../../errors.js';

/** File extension every document envelope is stored under. */
export const DOC_EXT = '.json';

/** Bucket for streams that carry no `<kind>:<id>` prefix. */
const DEFAULT_STREAM_BUCKET = '_';

/** Longest blob file name kept after sanitizing. */
const MAX_BLOB_NAME_LENGTH = 120;

/**
 * Hex characters of the owner-id digest used as a directory name. 40 hex
 * characters are 160 bits — short enough to keep paths readable, wide enough
 * that an accidental collision between two owner ids cannot happen.
 */
const OWNER_SEGMENT_LENGTH = 40;

/** Truncate an offending value for an error message so logs stay bounded. */
function describe(value) {
  return String(value).slice(0, 64);
}

/**
 * Assert that `ns` is usable as a namespace directory name.
 *
 * @param {string} ns - Namespace supplied by the caller
 * @returns {string} The namespace, unchanged, so it can be used inline
 * @throws {InvalidKeyError} When `ns` is not a safe id
 */
export function assertValidNamespace(ns) {
  if (!isValidId(ns)) {
    throw new InvalidKeyError(`Invalid storage namespace: ${describe(ns)}`);
  }
  return ns;
}

/**
 * Assert that `key` is usable as a document file name.
 *
 * @param {string} key - Document key supplied by the caller
 * @returns {string} The key, unchanged, so it can be used inline
 * @throws {InvalidKeyError} When `key` is not a safe id
 */
export function assertValidKey(key) {
  if (!isValidId(key)) {
    throw new InvalidKeyError(`Invalid storage key: ${describe(key)}`);
  }
  return key;
}

/**
 * Directory name for an owner's index entries.
 *
 * Owner ids are external strings (e-mail addresses, OIDC subjects) that are
 * not path-safe and may be long, so the index is keyed by a digest prefix
 * instead. The raw owner id stays readable inside every document envelope.
 *
 * @param {string} ownerId - Non-empty owner identifier
 * @returns {string} Hex digest prefix used as the directory name
 * @throws {InvalidKeyError} When `ownerId` is not a non-empty string
 */
export function ownerSegment(ownerId) {
  if (typeof ownerId !== 'string' || ownerId.length === 0) {
    throw new InvalidKeyError(`Invalid ownerId: ${describe(ownerId)}`);
  }
  return crypto
    .createHash('sha256')
    .update(ownerId, 'utf8')
    .digest('hex')
    .slice(0, OWNER_SEGMENT_LENGTH);
}

/**
 * Join `segments` under `rootDir` and refuse anything that resolves outside it.
 *
 * Defense in depth on top of the id validation above: the relative-path guard
 * (`path.relative()` neither escaping with '..' nor absolute) is the sanitizer
 * shape both reviewers and static analysis (CodeQL js/path-injection)
 * recognize, and the prefix check keeps the older, blunter assertion in place.
 *
 * **The check is lexical.** It resolves `..` and absolute segments and nothing
 * else — a symlink inside the tree pointing out of it is followed, because
 * nothing here asks the filesystem what a path really is. That is a deliberate
 * limit, not an oversight: the tree is the installation's own `contents/`
 * directory, and an operator who puts a symlink in it is configuring the
 * server, not attacking it. Several deployments do exactly that, which is why
 * `docs/storage.md` describes `contents/` as a trusted tree.
 *
 * What the guard is for is the *keys*, which reach it from requests: ids are
 * validated first, and this is the second wall behind that. Making containment
 * real against symlinks needs the base and namespace directories realpathed at
 * `initialize()` and every resolved path checked against those — worth doing
 * the day an untrusted principal can choose a path segment that is not an id.
 *
 * @param {string} rootDir - Directory the result must stay inside
 * @param {...string} segments - Path segments to append
 * @returns {string} The resolved absolute path
 * @throws {StorageError} Code `PATH_ESCAPE` when the result leaves `rootDir`
 */
export function containedPath(rootDir, ...segments) {
  for (const segment of segments) {
    if (typeof segment !== 'string') {
      throw new StorageError(`Storage path segment must be a string, got ${typeof segment}`, {
        code: 'PATH_ESCAPE'
      });
    }
  }
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, ...segments);
  const relative = path.relative(root, resolved);
  // The traversal test is anchored on a separator ('..' itself, or '..' as the
  // first segment). A bare `startsWith('..')` would also reject a legitimate
  // name that merely begins with two dots — `sanitizeBlobName('../../etc/x')`
  // yields `.._.._etc_x`, a perfectly contained file name — and rejecting that
  // as an escape is a false positive, not defense in depth.
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    relative.startsWith('../') ||
    path.isAbsolute(relative)
  ) {
    throw new StorageError('Storage path escapes the provider base directory', {
      code: 'PATH_ESCAPE'
    });
  }
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new StorageError('Storage path escapes the provider base directory', {
      code: 'PATH_ESCAPE'
    });
  }
  return resolved;
}

/**
 * Split a stream name into its path segments.
 *
 * `'run:abc'` becomes `['run', 'abc']` so streams of the same kind share a
 * directory; a name without a `:` is filed under a single `_` bucket rather
 * than sitting loose next to the kind directories.
 *
 * @param {string} stream - Stream name, optionally `<kind>:<id>`
 * @returns {string[]} Validated path segments
 * @throws {InvalidKeyError} When the name is empty or any part is not a safe id
 */
export function streamSegments(stream) {
  if (typeof stream !== 'string' || stream.length === 0) {
    throw new InvalidKeyError(`Invalid stream name: ${describe(stream)}`);
  }
  const segments = stream.includes(':') ? stream.split(':') : [DEFAULT_STREAM_BUCKET, stream];
  for (const segment of segments) {
    if (!isValidId(segment)) {
      throw new InvalidKeyError(`Invalid stream name: ${describe(stream)}`);
    }
  }
  return segments;
}

/**
 * The directory segment holding every stream of one kind.
 *
 * A stream name is `<kind>:<id>` and its first segment is its directory, so a
 * sweep or a listing scoped to one kind is a matter of where the walk starts.
 * Validated by the same rule as a stream name, which is what keeps a
 * caller-supplied kind from walking out of the log tree.
 *
 * @param {string} kind - Stream kind, e.g. `run`
 * @returns {string} The directory segment
 * @throws {InvalidKeyError} When `kind` is not a usable identifier
 */
export function streamKindSegment(kind) {
  if (typeof kind !== 'string' || !isValidId(kind)) {
    throw new InvalidKeyError(`Invalid stream kind: ${describe(kind)}`);
  }
  return kind;
}

/**
 * Reduce a blob name to a flat, path-safe file name.
 *
 * Unlike namespaces and keys, blob names come from payload metadata (upload
 * file names), so they are sanitized rather than rejected — but a name that
 * sanitizes to nothing, or to a directory reference, is still an error.
 *
 * @param {string} name - Caller-supplied blob name
 * @returns {string} The sanitized file name
 * @throws {InvalidKeyError} When the sanitized name is '', '.' or '..'
 */
export function sanitizeBlobName(name) {
  const sanitized = String(name ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .slice(0, MAX_BLOB_NAME_LENGTH);
  if (sanitized === '' || sanitized === '.' || sanitized === '..') {
    throw new InvalidKeyError(`Invalid blob name: ${describe(name)}`);
  }
  return sanitized;
}
