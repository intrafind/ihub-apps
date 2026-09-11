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
 * A held lease is refreshed while its section runs
 * ({@link FilesystemLockManager#_startRenewal}), so `ttlMs` bounds only how
 * long a *crashed* holder blocks the name. Without that it also bounded how
 * long the section itself could take, and a section that overran it was evicted
 * and carried on — two holders at once, with nothing logged on the side that
 * lost.
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
 * The start time is the *earlier* of what the holder wrote down and what the
 * filesystem recorded, never the holder's word alone. `at` is a timestamp from
 * whichever clock the holder had; `Date.now()` here is the reader's. One NTP
 * correction or one clock skew between cluster hosts is enough to put `at` in
 * the reader's future, and then the age is negative forever and a dead lease
 * never expires. That failure is invisible: waiters get `LockTimeoutError` and
 * the caller turns it into a 503, while the takeover warning — the one line
 * that would name the lock — is never reached. mtime cannot drift from the
 * reader this way, because both come from the same machine reading the same
 * filesystem, and it is preserved by the `rename` in `_evictExpired`.
 *
 * The min is the safe direction of the two: it can only ever judge a lease
 * older than the holder claimed, never younger, so a lock cannot be wedged —
 * only taken over sooner than a skewed clock would have liked.
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
  const startedAt = Number.isNaN(recordedAt)
    ? marker.mtimeMs
    : Math.min(recordedAt, marker.mtimeMs);
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
   * {@link LockTimeoutError} after `waitMs`.
   *
   * @param {string} name - Lock name; any non-empty string
   * @param {() => Promise<T>|T} fn - The critical section
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
    const stopRenewal = renew > 0 ? this._startRenewal(lockPath, owner, ttl, renew, name) : null;
    try {
      return await fn();
    } finally {
      stopRenewal?.();
      this._held.delete(lockPath);
      await this._release(lockPath, owner, name);
    }
  }

  /**
   * Keep a held lease young while its critical section runs.
   *
   * Without this the TTL is doing two incompatible jobs: bounding how long a
   * crashed holder blocks everyone, and bounding how long the section may take.
   * Sized for the crash it is short, and a section that overruns it is evicted
   * and keeps running — two critical sections at once, silently, which is the
   * one thing the lock exists to prevent. Sized for the section it is long, and
   * a crashed worker wedges the name for that whole time.
   *
   * Renewal separates them. `ttlMs` becomes only "how long after a holder stops
   * reporting in is it presumed dead", and a live holder is never preempted
   * however long it takes — the waiter gets its {@link LockTimeoutError} at
   * `waitMs` instead, which is a failure the caller can see and handle, where
   * an overlap is not. A process that dies stops renewing and its lease ages
   * out exactly as before.
   *
   * The timer is unref'd: it must never be the reason the process stays alive.
   *
   * @param {string} lockPath - Absolute lease file path
   * @param {string} owner - This holder's token
   * @param {number} ttlMs - Lease lifetime rewritten on each refresh
   * @param {number} renewMs - Interval between refreshes
   * @param {string} name - Lock name, for the log message
   * @returns {() => void} Stops the renewal; safe to call more than once
   * @private
   */
  _startRenewal(lockPath, owner, ttlMs, renewMs, name) {
    let stopped = false;
    let inFlight = false;
    const stop = () => {
      stopped = true;
      clearInterval(timer);
    };
    const timer = setInterval(() => {
      // A refresh slower than the interval must not queue up behind itself; on
      // a loaded disk that would spend the whole budget writing lease files.
      if (stopped || inFlight) return;
      inFlight = true;
      void this._touch(lockPath, owner, ttlMs, name)
        .then(kept => {
          // Once the lease is gone it is not coming back, and the section can
          // run for a long time yet: stop rather than re-open the file on
          // every interval for the rest of it.
          if (!kept) stop();
        })
        .finally(() => {
          inFlight = false;
        });
    }, renewMs);
    timer.unref?.();
    return stop;
  }

  /**
   * Rewrite our own lease's start time, and report whether we still hold it.
   *
   * Opened `r+` rather than written by path: a lease that has been evicted is
   * gone from that path, and a plain write would put a file carrying our dead
   * token back where the new holder is about to create theirs. `r+` fails with
   * `ENOENT` instead, and we simply stop renewing.
   *
   * The payload is written before the truncate so the file is never briefly
   * empty. A reader that catches a torn refresh mid-write judges the lease
   * unparseable, which `_evictExpired` handles by putting it back — the right
   * answer here, since a lease being refreshed has a holder that is alive.
   *
   * @param {string} lockPath - Absolute lease file path
   * @param {string} owner - This holder's token
   * @param {number} ttlMs - Lease lifetime to record
   * @param {string} name - Lock name, for the log message
   * @returns {Promise<boolean>} False once the lease is no longer ours
   * @private
   */
  async _touch(lockPath, owner, ttlMs, name) {
    let handle;
    try {
      handle = await fs.open(lockPath, 'r+');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.warn('Could not refresh a storage lease', {
          component: COMPONENT,
          name: String(name).slice(0, 64),
          error: err.message
        });
        // Transient — keep refreshing rather than abandoning a lease we hold.
        return true;
      }
      logger.warn('Storage lease disappeared while it was held', {
        component: COMPONENT,
        name: String(name).slice(0, 64)
      });
      return false;
    }
    try {
      const current = await handle.readFile('utf8');
      let parsed = null;
      try {
        parsed = JSON.parse(current);
      } catch {
        parsed = null;
      }
      if (parsed?.owner !== owner) {
        logger.warn('Storage lease was taken over while it was held', {
          component: COMPONENT,
          name: String(name).slice(0, 64)
        });
        return false;
      }
      const payload = JSON.stringify({
        owner,
        pid: process.pid,
        at: new Date().toISOString(),
        ttlMs
      });
      await handle.write(payload, 0, 'utf8');
      await handle.truncate(Buffer.byteLength(payload, 'utf8'));
      return true;
    } catch (error) {
      logger.warn('Could not refresh a storage lease', {
        component: COMPONENT,
        name: String(name).slice(0, 64),
        error: error.message
      });
      return true;
    } finally {
      await handle.close().catch(() => {});
    }
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
        // Try immediately rather than looping back to the deadline guard.
        // Eviction is a rename, a read and an unlink, so with a short `waitMs`
        // — `ANSWER_LOCK_OPTIONS` uses 50ms — the budget can be gone by the
        // time the path is free, and the very caller that cleared the dead
        // lease is the one that gives up on it. That surfaces as a spurious
        // 409 ANSWER_IN_PROGRESS against a run that has been finished for
        // however long the TTL is.
        if (await tryCreateExclusive(lockPath, payload)) return;
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
    // The scratch file goes away whatever happens below. It is inert if it
    // survives — only the exact lease path is ever acquired — but one left
    // behind per takeover fills the lock directory with them.
    try {
      const moved = await readJsonMarker(evicted);
      if (moved && leaseIdentity(moved) !== leaseIdentity(expected)) {
        logger.warn('Restoring a storage lease acquired during a takeover', {
          component: COMPONENT,
          name: String(name).slice(0, 64)
        });
        // The bytes as they were, not `JSON.stringify(moved.data)`: a lease
        // that did not parse has no `data` to re-serialize, and it is exactly
        // the lease that most needs putting back.
        const bytes = await fs.readFile(evicted, 'utf8').catch(() => null);
        if (bytes !== null) await tryCreateExclusive(lockPath, bytes);
      }
    } finally {
      await removeIfExists(evicted);
    }
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
