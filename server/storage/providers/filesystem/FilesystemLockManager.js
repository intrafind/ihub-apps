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
 * Why this does not call `utils/fileLock.js#withFileLock`: that helper
 * deliberately **runs its critical section anyway** once its timeout expires
 * (a warning, then the unguarded write), because its callers would rather lose
 * a bookkeeping guarantee than block a request forever. A `LockManager` cannot
 * do that — the contract is that `fn` never runs without the lock — so this
 * builds directly on the primitives from that same module
 * (`tryCreateExclusive`, `readJsonMarker`, `removeIfExists`) and throws
 * {@link LockTimeoutError} instead.
 *
 * Taking over an abandoned lease is the one step `O_EXCL` does not cover, and
 * it is handled by `rename`/`link` rather than by `unlink` — see
 * {@link FilesystemLockManager#_evictExpired} for why an `unlink` there is a
 * compare-and-set against nothing.
 *
 * @module storage/providers/filesystem/FilesystemLockManager
 */
import { promises as fs } from 'fs';
import crypto from 'crypto';
import { tryCreateExclusive, readJsonMarker, removeIfExists } from '../../../utils/fileLock.js';
import logger from '../../../utils/logger.js';
import { LockManager } from '../../LockManager.js';
import { InvalidKeyError, LockTimeoutError, StorageError } from '../../errors.js';
import { containedPath } from './paths.js';

const COMPONENT = 'FilesystemLockManager';

/** Directory under the provider base directory holding the lease files. */
const LOCKS_DIR = 'locks';

/** Hex characters of the lock-name digest used as the lease file name. */
const NAME_DIGEST_LENGTH = 40;

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_WAIT_MS = 5_000;
const DEFAULT_POLL_MS = 25;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  const digest = crypto
    .createHash('sha256')
    .update(name, 'utf8')
    .digest('hex')
    .slice(0, NAME_DIGEST_LENGTH);
  return `${digest}.lock`;
}

/**
 * Whether an existing lease may be taken over.
 *
 * The lease carries its own `ttlMs`, so a long-running holder is judged by the
 * TTL it asked for rather than by the waiter's. A lease that cannot be parsed
 * (a half-written file, or one from an older format) is judged by its mtime
 * against the waiter's TTL instead — an unreadable lease must not be able to
 * wedge a lock name forever.
 *
 * @param {{data: Object|null, mtimeMs: number}} marker - Result of `readJsonMarker`
 * @param {number} fallbackTtlMs - TTL to apply when the lease says nothing usable
 * @returns {boolean} True when the lease is older than its TTL
 */
function isExpiredLease(marker, fallbackTtlMs) {
  const ttlMs =
    Number.isFinite(marker.data?.ttlMs) && marker.data.ttlMs > 0
      ? marker.data.ttlMs
      : fallbackTtlMs;
  const recordedAt = Date.parse(marker.data?.at ?? '');
  const startedAt = Number.isNaN(recordedAt) ? marker.mtimeMs : recordedAt;
  return Date.now() - startedAt > ttlMs;
}

/**
 * Identity of one lease *instance*, so a waiter can tell the lease it judged
 * abandoned from a lease that appeared since.
 *
 * The owner token is a uuid minted per acquisition, which pins the instance
 * exactly. A lease too damaged to parse has no token, so it falls back to the
 * modification time `isExpiredLease` already judged it by — `rename` preserves
 * mtime, so the value still matches after the lease has been moved aside.
 *
 * @param {{data: Object|null, mtimeMs: number}|null} marker - Result of `readJsonMarker`
 * @returns {string} Comparable identity of that lease
 */
function leaseIdentity(marker) {
  const owner = marker?.data?.owner;
  return typeof owner === 'string' ? `owner:${owner}` : `mtime:${marker?.mtimeMs}`;
}

/** Reject a non-positive or non-numeric duration instead of looping forever on it. */
function positiveNumber(value, fallback, label) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new StorageError(`${label} must be a positive number`, { code: 'INVALID_LOCK_OPTIONS' });
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
   * {@link LockTimeoutError} after `waitMs`.
   *
   * @param {string} name - Lock name; any non-empty string
   * @param {() => Promise<T>|T} fn - The critical section
   * @param {Object} [opts]
   * @param {number} [opts.ttlMs=30000] - Lease lifetime; an older lease is taken over
   * @param {number} [opts.waitMs=5000] - How long to wait for a held lease
   * @returns {Promise<T>} Whatever `fn` returned
   * @throws {InvalidKeyError} When `name` is not a non-empty string
   * @throws {LockTimeoutError} When the lease could not be acquired within `waitMs`
   * @template T
   */
  async withLock(name, fn, { ttlMs = DEFAULT_TTL_MS, waitMs = DEFAULT_WAIT_MS } = {}) {
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

    const lockPath = containedPath(this._baseDir, LOCKS_DIR, leaseFileName(name));
    // The owner token is what makes a takeover safe: only the holder that still
    // matches the token on disk may unlink the lease, so a holder whose lease
    // expired and was taken over cannot delete the new holder's lease.
    const owner = crypto.randomUUID();
    await this._acquire(lockPath, owner, ttl, wait, name);
    try {
      return await fn();
    } finally {
      await this._release(lockPath, owner, name);
    }
  }

  /**
   * Create the lease, waiting out (or taking over) an existing one.
   *
   * @param {string} lockPath - Absolute lease file path
   * @param {string} owner - This holder's token
   * @param {number} ttlMs - Lease lifetime recorded in the file
   * @param {number} waitMs - Acquisition budget
   * @param {string} name - Lock name, for the timeout message
   * @returns {Promise<void>}
   * @throws {LockTimeoutError} When the budget ran out
   */
  async _acquire(lockPath, owner, ttlMs, waitMs, name) {
    const deadline = Date.now() + waitMs;
    const payload = JSON.stringify({
      owner,
      pid: process.pid,
      at: new Date().toISOString(),
      ttlMs
    });
    // Guarantees at least one attempt even with a zero-length budget, and
    // guarantees termination: every path that retries without sleeping either
    // found the lease gone or removed an expired one, and both are re-checked
    // against the deadline on the next pass.
    const timedOut = () =>
      new LockTimeoutError(
        `Timed out after ${waitMs}ms waiting for storage lock "${String(name).slice(0, 64)}"`
      );
    let attempted = false;
    for (;;) {
      if (attempted && Date.now() >= deadline) throw timedOut();
      attempted = true;
      if (await tryCreateExclusive(lockPath, payload)) return;

      const existing = await readJsonMarker(lockPath);
      if (!existing) continue; // released between the two calls — retry at once
      if (isExpiredLease(existing, ttlMs)) {
        logger.warn('Taking over an expired storage lease', {
          component: COMPONENT,
          pid: existing.data?.pid,
          name: String(name).slice(0, 64)
        });
        await this._evictExpired(lockPath, owner, existing, name);
        continue;
      }
      if (Date.now() >= deadline) throw timedOut();
      await sleep(this._pollMs);
    }
  }

  /**
   * Move an abandoned lease out of the way so the next `tryCreateExclusive`
   * can decide the new owner.
   *
   * `unlink` cannot do this job: it removes whatever sits at the path at unlink
   * time, while the decision to remove was taken from a marker read a round-trip
   * earlier. Two waiters that saw the same abandoned lease would therefore both
   * unlink, and the second unlink would delete the *fresh* lease the first one
   * had meanwhile created — both would then create a lease of their own and
   * both would run their critical section, which is precisely what this class
   * exists to prevent.
   *
   * `rename` supplies the missing atomicity twice over. It elects exactly one
   * evictor — every other waiter gets `ENOENT` and simply retries against
   * whatever is at the path now — and it hands that evictor the bytes it moved,
   * so it can check that it moved the lease it meant to move. When it did not
   * (a takeover completed between the read and the rename) the lease goes
   * straight back through `link`, which refuses an existing target and so can
   * never clobber a lease acquired in the meantime.
   *
   * What remains: the path is unoccupied between the rename and the restore, so
   * a third waiter creating a lease in that window makes the restore fail with
   * `EEXIST` and the lease that was moved aside is lost. A POSIX filesystem has
   * no atomic compare-and-delete, so no eviction scheme closes this entirely —
   * which is why the capability is `advisory-single-machine` and step 3 of the
   * epic elects singletons through a real distributed lock instead. A crash
   * inside the same window also leaves an `.evicted-*` file behind; it is inert
   * (only the exact lease path is ever acquired) and the next takeover writes a
   * fresh one under its own name.
   *
   * @param {string} lockPath - Absolute lease file path
   * @param {string} owner - This waiter's token; keeps the scratch name unique
   * @param {{data: Object|null, mtimeMs: number}} expected - The lease that was
   *   judged expired
   * @param {string} name - Lock name, for the log message
   * @returns {Promise<void>}
   * @private
   */
  async _evictExpired(lockPath, owner, expected, name) {
    const evicted = `${lockPath}.evicted-${owner}`;
    try {
      await fs.rename(lockPath, evicted);
    } catch (err) {
      // Another waiter evicted it first; retry against the new state.
      if (err.code === 'ENOENT') return;
      throw err;
    }
    const moved = await readJsonMarker(evicted);
    if (moved && leaseIdentity(moved) !== leaseIdentity(expected)) {
      logger.warn('Restoring a storage lease acquired during a takeover', {
        component: COMPONENT,
        name: String(name).slice(0, 64)
      });
      try {
        await fs.link(evicted, lockPath);
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
    await removeIfExists(evicted);
  }

  /**
   * Remove the lease, but only while it is still ours.
   *
   * The read and the unlink are not one atomic step, so a takeover landing
   * exactly between them can still lose its lease — the TTL is what bounds
   * that, and it is far narrower than unlinking unconditionally.
   *
   * @param {string} lockPath - Absolute lease file path
   * @param {string} owner - This holder's token
   * @param {string} name - Lock name, for the log message
   * @returns {Promise<void>}
   */
  async _release(lockPath, owner, name) {
    try {
      const existing = await readJsonMarker(lockPath);
      if (!existing) return;
      if (existing.data?.owner !== owner) {
        logger.warn('Storage lease was taken over before release', {
          component: COMPONENT,
          name: String(name).slice(0, 64)
        });
        return;
      }
      await removeIfExists(lockPath);
    } catch (error) {
      // The section already ran; failing to clean up must not replace its
      // result with an I/O error. The TTL makes the stale lease recoverable.
      logger.error('Failed to release storage lease', {
        component: COMPONENT,
        name: String(name).slice(0, 64),
        error
      });
    }
  }
}

export default FilesystemLockManager;
