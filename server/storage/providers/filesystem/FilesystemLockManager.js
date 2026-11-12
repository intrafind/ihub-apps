// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Named leases on a shared filesystem.
 *
 * One lease file per lock name under `<base>/locks/`, holding
 * `{ owner, pid, at, ttlMs }`. Exclusivity comes from `O_EXCL`: whichever
 * worker creates the file first owns the lease, which is the only compare-and-set
 * cluster workers sharing one volume have without a database. That makes the
 * reach `advisory-single-machine` — it guards the workers of one installation
 * against each other, not two installations against each other.
 *
 * The lease primitives (exclusive create, guarded takeover of an expired
 * lease, owner-checked release, renewal) live in `utils/fileLock.js` and are
 * shared with `withFileLock`; this class adds the named-lease layout and the
 * fencing tokens on top. Both fail closed: when the lease cannot be had within
 * the wait, `LockTimeoutError` is thrown and `fn` never runs.
 *
 * A held lease is refreshed while its section runs
 * ({@link FilesystemLockManager#_startRenewal}), so `ttlMs` bounds only how
 * long a *crashed* holder blocks the name. Without that it also bounded how
 * long the section itself could take, and a section that overran it was evicted
 * and carried on — two holders at once, with nothing logged on the side that
 * lost.
 *
 * Every acquisition is also issued a **fencing token** (`LockLease.token`):
 * a per-name counter in `<base>/locks/<digest>.fence`, incremented by the
 * holder right after it won the lease and written with a rename, so it only
 * grows and survives restarts. The lease file records the token it was issued
 * with; {@link FilesystemLockManager#isTokenCurrent} compares both, which is
 * how a holder that was taken over finds out before it publishes.
 *
 * @module storage/providers/filesystem/FilesystemLockManager
 */
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import {
  acquireLease,
  isExpiredLease,
  readJsonMarker,
  releaseLease,
  removeIfExists,
  startLeaseRenewal,
  touchLease
} from '../../../utils/fileLock.js';
import logger from '../../../utils/logger.js';
import { LockManager } from '../../LockManager.js';
import { InvalidKeyError, StorageError } from '../../errors.js';
import { containedPath } from './paths.js';

const COMPONENT = 'FilesystemLockManager';

/** Directory under the provider base directory holding the lease files. */
const LOCKS_DIR = 'locks';

/** Hex characters of the lock-name digest used as the lease file name. */
const NAME_DIGEST_LENGTH = 40;

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_WAIT_MS = 5_000;
const DEFAULT_POLL_MS = 25;

/**
 * Lease file name for a lock name.
 *
 * Lock names are arbitrary caller strings (`'chat:user@example.com'`), so they
 * are hashed rather than validated — the caller should not have to know that
 * the lease ends up as a file name.
 *
 * @param {string} name - Lock name
 * @returns {string} File name, digest plus `.lock`
 */
function leaseFileName(name) {
  return `${nameDigest(name)}.lock`;
}

/**
 * Fencing counter file name for a lock name: the same digest as the lease,
 * so the two sit side by side.
 *
 * @param {string} name - Lock name
 * @returns {string} File name, digest plus `.fence`
 */
function fenceFileName(name) {
  return `${nameDigest(name)}.fence`;
}

/** The hex digest a lock name is stored under. */
function nameDigest(name) {
  return crypto
    .createHash('sha256')
    .update(name, 'utf8')
    .digest('hex')
    .slice(0, NAME_DIGEST_LENGTH);
}

/** Reject a non-positive or non-numeric duration instead of looping forever on it. */
function positiveNumber(value, fallback, label) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new StorageError(`${label} must be a positive number`, { code: 'INVALID_LOCK_OPTIONS' });
  }
  return value;
}

/** Same, but 0 is a meaningful value — it switches lease renewal off. */
function nonNegativeNumber(value, fallback, label) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new StorageError(`${label} must be zero or a positive number`, {
      code: 'INVALID_LOCK_OPTIONS'
    });
  }
  return value;
}

/**
 * Filesystem {@link LockManager}: exclusive named leases with TTL takeover.
 */
export class FilesystemLockManager extends LockManager {
  /**
   * @param {Object} [options]
   * @param {string} options.baseDir - Absolute base directory of the provider
   * @param {number} [options.pollMs=25] - Interval between acquisition attempts
   *   while another holder has the lease
   * @throws {StorageError} Code `INVALID_CONFIG` when `baseDir` is missing
   */
  constructor({ baseDir, pollMs = DEFAULT_POLL_MS } = {}) {
    super();
    if (typeof baseDir !== 'string' || baseDir.length === 0) {
      throw new StorageError('FilesystemLockManager requires a baseDir', {
        code: 'INVALID_CONFIG'
      });
    }
    this._baseDir = baseDir;
    this._pollMs = pollMs;
    // Leases this process currently holds, so `releaseAll()` can hand them
    // back at shutdown. `withLock`'s own `finally` covers the ordinary case;
    // this covers the one where the process is going away and the `finally`
    // will not get its turn.
    this._held = new Map();
  }

  /**
   * Absolute directory holding the lease files.
   * @returns {string}
   */
  get lockDir() {
    return containedPath(this._baseDir, LOCKS_DIR);
  }

  /**
   * Run `fn` while holding the exclusive lease named `name`.
   *
   * The lease is released when `fn` settles either way and `fn`'s rejection is
   * rethrown unchanged. **Not reentrant**: a nested `withLock` on the same name
   * waits for a lease its own caller holds and therefore fails with
   * `LockTimeoutError` after `waitMs`.
   *
   * `fn` receives the lease (`{ name, token, isCurrent }`): `token` is this
   * acquisition's fencing token, `isCurrent()` whether it still holds the
   * lease (see {@link FilesystemLockManager#isTokenCurrent}).
   *
   * @param {string} name - Lock name; any non-empty string
   * @param {(lease: import('../../LockManager.js').LockLease) => Promise<T>|T} fn - The critical section
   * @param {Object} [opts]
   * @param {number} [opts.ttlMs=30000] - Lease lifetime; an older lease is taken over
   * @param {number} [opts.waitMs=5000] - How long to wait for a held lease
   * @param {number} [opts.renewMs] - Refresh interval while `fn` runs; defaults
   *   to a third of `ttlMs`. 0 disables renewal, so the lease ages out under a
   *   running holder
   * @returns {Promise<T>} Whatever `fn` returned
   * @throws {InvalidKeyError} When `name` is not a non-empty string
   * @throws {LockTimeoutError} When the lease could not be acquired within `waitMs`
   * @template T
   */
  async withLock(name, fn, { ttlMs = DEFAULT_TTL_MS, waitMs = DEFAULT_WAIT_MS, renewMs } = {}) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new InvalidKeyError(`Invalid lock name: ${String(name).slice(0, 64)}`);
    }
    if (typeof fn !== 'function') {
      throw new StorageError('withLock requires a function to run', {
        code: 'INVALID_LOCK_SECTION'
      });
    }
    const ttl = positiveNumber(ttlMs, DEFAULT_TTL_MS, 'ttlMs');
    const wait = positiveNumber(waitMs, DEFAULT_WAIT_MS, 'waitMs');
    const renew = nonNegativeNumber(renewMs, Math.max(1, Math.floor(ttl / 3)), 'renewMs');

    const lockPath = containedPath(this._baseDir, LOCKS_DIR, leaseFileName(name));
    // The owner token is what makes a takeover safe: only the holder that still
    // matches the token on disk may unlink the lease, so a holder whose lease
    // expired and was taken over cannot delete the new holder's lease.
    const owner = crypto.randomUUID();
    await this._acquire(lockPath, owner, ttl, wait, name);
    this._held.set(lockPath, { owner, name });
    let token;
    try {
      token = await this._issueToken(name);
      // The lease names its token, so `isTokenCurrent` can tell this lease
      // from one a later holder created after taking the name over.
      await this._touch(lockPath, owner, ttl, name, token);
    } catch (error) {
      this._held.delete(lockPath);
      await this._release(lockPath, owner, name);
      throw error;
    }
    const lease = Object.freeze({
      name,
      token,
      isCurrent: () => this.isTokenCurrent(name, token)
    });
    const stopRenewal =
      renew > 0 ? this._startRenewal(lockPath, owner, ttl, renew, name, token) : null;
    try {
      return await fn(lease);
    } finally {
      stopRenewal?.();
      this._held.delete(lockPath);
      await this._release(lockPath, owner, name);
    }
  }

  /**
   * Keep a held lease young while its critical section runs; see
   * `startLeaseRenewal` in `utils/fileLock.js`, which this and `withFileLock`
   * share so there is one lease scheme.
   *
   * @returns {() => void} Stops the renewal; safe to call more than once
   * @private
   */
  _startRenewal(lockPath, owner, ttlMs, renewMs, name, token) {
    return startLeaseRenewal(lockPath, owner, ttlMs, renewMs, name, token, COMPONENT);
  }

  /**
   * Rewrite our own lease's start time, and report whether we still hold it.
   *
   * @returns {Promise<boolean>} False once the lease is no longer ours
   * @private
   */
  _touch(lockPath, owner, ttlMs, name, token) {
    return touchLease(lockPath, owner, ttlMs, name, token, COMPONENT);
  }

  /**
   * Whether `token` still holds the lease named `name`: it is the newest
   * token the fencing counter issued for the name, the lease file in place
   * carries it, and that lease has not aged past its TTL. Any other answer —
   * a released lease, a takeover, a counter that moved on, a lease nobody
   * refreshed in time — is false.
   *
   * @param {string} name - Lock name
   * @param {number} token - The token `fn` received
   * @returns {Promise<boolean>}
   */
  async isTokenCurrent(name, token) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new InvalidKeyError(`Invalid lock name: ${String(name).slice(0, 64)}`);
    }
    if (!Number.isSafeInteger(token) || token <= 0) return false;
    const issued = await this._readToken(name);
    if (issued !== token) return false;
    const lockPath = containedPath(this._baseDir, LOCKS_DIR, leaseFileName(name));
    const lease = await readJsonMarker(lockPath);
    if (lease?.data?.token !== token) return false;
    return !isExpiredLease(lease, DEFAULT_TTL_MS);
  }

  /**
   * The last fencing token issued for a name: 0 when none was, null when
   * the counter file cannot be read as one.
   *
   * @param {string} name - Lock name
   * @returns {Promise<number|null>}
   * @private
   */
  async _readToken(name) {
    const fencePath = containedPath(this._baseDir, LOCKS_DIR, fenceFileName(name));
    let text;
    try {
      text = await fs.readFile(fencePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw error;
    }
    try {
      const token = JSON.parse(text)?.token;
      return Number.isSafeInteger(token) && token >= 0 ? token : null;
    } catch {
      return null;
    }
  }

  /**
   * Issue the next fencing token for a name. Called by the holder right after
   * it won the lease, so no other acquisition of the name runs it at the same
   * time; written to a scratch file and renamed into place, so a reader sees
   * the old counter or the new one, never a torn one. A counter file that
   * cannot be read (damaged by hand) continues from the clock in
   * milliseconds, which is larger than any counter a name reaches, so the
   * token still grows.
   *
   * @param {string} name - Lock name
   * @returns {Promise<number>} The new token
   * @private
   */
  async _issueToken(name) {
    const fencePath = containedPath(this._baseDir, LOCKS_DIR, fenceFileName(name));
    let previous = await this._readToken(name);
    if (previous === null) {
      logger.warn('Storage lock fencing counter is unreadable; continuing from the clock', {
        component: COMPONENT,
        name: String(name).slice(0, 64)
      });
      previous = Date.now();
    }
    const token = previous + 1;
    const scratch = `${fencePath}.${process.pid}-${crypto.randomUUID()}`;
    await fs.mkdir(this.lockDir, { recursive: true });
    try {
      await fs.writeFile(scratch, JSON.stringify({ token }), 'utf8');
      await fs.rename(scratch, fencePath);
    } finally {
      await removeIfExists(scratch).catch(() => {});
    }
    return token;
  }

  /**
   * Release every lease this process still holds.
   *
   * Called from the provider's shutdown, after the append log has flushed.
   * Without it a SIGTERM leaves each held lease on disk with no holder, and
   * the next worker to want that name waits out the whole TTL before it may
   * take over — 30 seconds of 409s on an interaction, five minutes of skipped
   * imports on a runtime lock. Nothing is wrong with the lease; there is
   * simply nobody left to say so.
   *
   * Only leases still owned by this process are removed: `_release` re-reads
   * the owner token, so a lease taken over while we were on our way out is
   * left to its new holder. Never throws — shutdown must not be blocked by a
   * lock directory that has become unwritable.
   *
   * @returns {Promise<number>} How many leases were handed back
   */
  async releaseAll() {
    const held = [...this._held.entries()];
    this._held.clear();
    for (const [lockPath, { owner, name }] of held) {
      await this._release(lockPath, owner, name);
    }
    if (held.length > 0) {
      logger.info('Released storage leases still held at shutdown', {
        component: COMPONENT,
        count: held.length
      });
    }
    return held.length;
  }

  /**
   * Create the lease, waiting out (or taking over) an existing one; see
   * `acquireLease` in `utils/fileLock.js`.
   *
   * @throws {LockTimeoutError} When the budget ran out
   * @private
   */
  _acquire(lockPath, owner, ttlMs, waitMs, name) {
    return acquireLease(lockPath, owner, {
      ttlMs,
      waitMs,
      pollMs: this._pollMs,
      name,
      component: COMPONENT
    });
  }

  /**
   * Remove the lease, but only while it is still ours; see `releaseLease`.
   *
   * @private
   */
  _release(lockPath, owner, name) {
    return releaseLease(lockPath, owner, name, COMPONENT);
  }
}

export default FilesystemLockManager;
