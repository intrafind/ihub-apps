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
 * Why this does not call `utils/fileLock.js#withFileLock`: that helper
 * deliberately **runs its critical section anyway** once its timeout expires
 * (a warning, then the unguarded write), because its callers would rather lose
 * a bookkeeping guarantee than block a request forever. A `LockManager` cannot
 * do that — the contract is that `fn` never runs without the lock — so this
 * builds on primitives of its own (and `tryCreateExclusive`/`removeIfExists`
 * from that module) and throws {@link LockTimeoutError} instead.
 *
 * A lease is published whole: written to a scratch file and `link`ed onto the
 * lease path, which fails with `EEXIST` when the name is taken. No reader ever
 * sees a lease file without its content (see
 * {@link FilesystemLockManager#_publish}).
 *
 * Removing a lease — a holder's release or a waiter's takeover of an abandoned
 * one — is the step `O_EXCL` does not cover, and it goes through a per-lease
 * removal claim — see {@link FilesystemLockManager#_removeLease} for why that
 * is what makes the removal a compare-and-delete.
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
import { tryCreateExclusive, removeIfExists } from '../../../utils/fileLock.js';
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

/**
 * How old a removal claim must be before it is presumed abandoned by a worker
 * that died between claiming a lease and removing it. A claim is held for a
 * read and an unlink, so this is generous; see `_claimRemoval`.
 */
const CLAIM_STALE_MS = 10_000;

/** Error codes of a filesystem that has no hard links (some SMB/FAT mounts). */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV']);

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

/**
 * Whether an existing lease may be taken over.
 *
 * The lease carries its own `ttlMs`, so a long-running holder is judged by the
 * TTL it asked for rather than by the waiter's. A lease that cannot be parsed
 * (a refresh caught mid-write, a crash, a hand edit) is judged by its own mtime
 * against the waiter's TTL but never less than the default TTL: a file that is
 * still being written was touched just now, so it reads as held, while one
 * that stays unreadable ages out and cannot wedge a lock name forever.
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
 * filesystem.
 *
 * The min is the safe direction of the two: it can only ever judge a lease
 * older than the holder claimed, never younger, so a lock cannot be wedged —
 * only taken over sooner than a skewed clock would have liked.
 *
 * Both values must come from one read of one file (`readLease`): the mtime of
 * the lease that was there a moment ago, paired with the content of the lease
 * that replaced it, made a live lease look as old as a dead one.
 *
 * @param {{data: Object|null, mtimeMs: number}} marker - Result of `readLease`
 * @param {number} fallbackTtlMs - TTL to apply when the lease says nothing usable
 * @returns {boolean} True when the lease is older than its TTL
 */
function isExpiredLease(marker, fallbackTtlMs) {
  const ttlMs =
    Number.isFinite(marker.data?.ttlMs) && marker.data.ttlMs > 0
      ? marker.data.ttlMs
      : marker.data
        ? fallbackTtlMs
        : Math.max(fallbackTtlMs, DEFAULT_TTL_MS);
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
 * file itself: inode, mtime and size together.
 *
 * @param {{data: Object|null, mtimeMs: number, ino: number, size: number}} marker - Result of `readLease`
 * @returns {string} Comparable identity of that lease
 */
function leaseIdentity(marker) {
  const owner = marker?.data?.owner;
  return typeof owner === 'string'
    ? `owner:${owner}`
    : `file:${marker?.ino}:${marker?.mtimeMs}:${marker?.size}`;
}

/**
 * Read a lease file: its content and its metadata through one open handle, so
 * both describe the same file even when the path is replaced meanwhile.
 *
 * @param {string} lockPath - Absolute lease file path
 * @returns {Promise<{data: Object|null, mtimeMs: number, ino: number, size: number}|null>}
 *   Null when there is no lease; `data` null when it does not parse
 */
async function readLease(lockPath) {
  let handle;
  try {
    handle = await fs.open(lockPath, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const stat = await handle.stat();
    const text = await handle.readFile('utf8');
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return { data, mtimeMs: stat.mtimeMs, ino: stat.ino, size: stat.size };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Lease content for an owner, stamped now. */
function leasePayload(owner, ttlMs, token) {
  return JSON.stringify({
    owner,
    pid: process.pid,
    at: new Date().toISOString(),
    ttlMs,
    ...(token === undefined ? {} : { token })
  });
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
      if (!(await this._touch(lockPath, owner, ttl, name, token))) {
        // Lost before the section started (a TTL shorter than issuing the
        // token takes): running `fn` now would run it without the lock.
        throw new LockTimeoutError(
          `Storage lock "${String(name).slice(0, 64)}" was taken over before its section started`
        );
      }
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
   * @param {number} token - The fencing token the lease carries
   * @returns {() => void} Stops the renewal; safe to call more than once
   * @private
   */
  _startRenewal(lockPath, owner, ttlMs, renewMs, name, token) {
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
      void this._touch(lockPath, owner, ttlMs, name, token)
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
   * empty. A reader that catches a torn refresh mid-write finds an unparseable
   * lease written just now, which `isExpiredLease` counts as held — the right
   * answer, since a lease being refreshed has a holder that is alive.
   *
   * @param {string} lockPath - Absolute lease file path
   * @param {string} owner - This holder's token
   * @param {number} ttlMs - Lease lifetime to record
   * @param {string} name - Lock name, for the log message
   * @param {number} [token] - The fencing token to record with the lease
   * @returns {Promise<boolean>} False once the lease is no longer ours
   * @private
   */
  async _touch(lockPath, owner, ttlMs, name, token) {
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
      const payload = leasePayload(owner, ttlMs, token);
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
    const lease = await readLease(lockPath);
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
    // Stamped per attempt, not once up front: a lease that recorded when its
    // waiter *started* waiting looked abandoned the moment it appeared
    // whenever the wait had outlasted the TTL.
    const publish = () => this._publish(lockPath, leasePayload(owner, ttlMs));
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
      if (await publish()) return;

      const existing = await readLease(lockPath);
      if (!existing) continue; // released between the two calls — retry at once
      if (isExpiredLease(existing, ttlMs)) {
        const outcome = await this._removeLease(lockPath, existing, current =>
          isExpiredLease(current, ttlMs)
        );
        if (outcome === 'removed') {
          logger.warn('Took over an expired storage lease', {
            component: COMPONENT,
            pid: existing.data?.pid,
            name: String(name).slice(0, 64)
          });
        }
        if (outcome === 'removed' || outcome === 'gone') {
          // Try immediately rather than looping back to the deadline guard.
          // With a short `waitMs` — `ANSWER_LOCK_OPTIONS` uses 50ms — the
          // budget can be gone by the time the path is free, and the very
          // caller that cleared the dead lease is the one that gives up on it.
          // That surfaces as a spurious 409 ANSWER_IN_PROGRESS against a run
          // that has been finished for however long the TTL is.
          if (await publish()) return;
          continue;
        }
        // 'changed' (another lease is there now, or this one was refreshed)
        // or 'busy' (another worker is removing it): wait as for any lease.
      }
      if (Date.now() >= deadline) throw timedOut();
      await sleep(this._pollMs);
    }
  }

  /**
   * Put a lease on the path unless one is there: atomically, and whole.
   *
   * The content goes to a scratch file first, which is then hard-linked onto
   * the lease path. `link` refuses an existing target with `EEXIST`, so it is
   * the same election `O_EXCL` is, but the lease appears with its content
   * already in it. Created with `O_EXCL` and written afterwards, a lease spent
   * a moment as an empty file, and a waiter reading it then saw no owner and
   * no TTL. On a filesystem without hard links this falls back to `O_EXCL`;
   * an empty lease read there was written just now and counts as held (see
   * `isExpiredLease`).
   *
   * @param {string} lockPath - Absolute lease file path
   * @param {string} content - Lease content
   * @returns {Promise<boolean>} True when this call created the lease
   * @private
   */
  async _publish(lockPath, content) {
    await fs.mkdir(this.lockDir, { recursive: true });
    const scratch = `${lockPath}.new-${crypto.randomUUID()}`;
    try {
      await fs.writeFile(scratch, content, { encoding: 'utf8', flag: 'wx' });
      await fs.link(scratch, lockPath);
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      if (NO_HARD_LINKS.has(err.code)) return tryCreateExclusive(lockPath, content);
      throw err;
    } finally {
      await removeIfExists(scratch).catch(() => {});
    }
  }

  /**
   * Remove the lease at the path if, and only if, it is still the lease
   * `expected` describes and `stillWanted` still holds for it.
   *
   * POSIX has no compare-and-delete: `unlink` removes whatever sits at the
   * path, while the decision to remove was taken from a read a round-trip
   * earlier. Two earlier schemes failed on that. Unlinking let two waiters
   * that saw the same abandoned lease both unlink, the second one deleting the
   * fresh lease the first had created meanwhile. Renaming the lease aside,
   * checking what was moved and linking it back when it was the wrong one left
   * the path empty in between, and any third waiter creating its lease in
   * that gap made two holders. (Nor is `unlink` itself an election: two
   * concurrent unlinks of one file can both succeed on macOS.)
   *
   * So removal is serialized per lease instance instead. Whoever wants to
   * remove a lease — a waiter taking it over, or its holder releasing it —
   * first creates a claim file named after that lease's identity, with
   * `O_EXCL`; exactly one worker wins it. The winner then re-reads the path.
   * The lease at a path changes in only two ways: a new one is published,
   * which `link` allows only while the path is empty, or the current one is
   * removed, which needs its claim. So when the re-read still finds the
   * expected lease, it stays there until the claim holder unlinks it, and
   * that unlink removes exactly that lease and nothing else. Nothing is ever
   * moved off the path and put back, so there is no window, whatever the
   * number of waiters or processes on the volume. (A holder refreshing its
   * lease rewrites it in place, which keeps its identity; the re-read
   * re-checks `stillWanted`, so a lease refreshed meanwhile is left alone.)
   *
   * The one assumption is about time, the same kind the TTL makes: a claim
   * older than `CLAIM_STALE_MS` is presumed to belong to a worker that died
   * holding it, and the next round's claim is taken. A worker frozen for that
   * long between its re-read and its unlink could still remove a lease
   * published since. A worker killed while holding a claim leaves an inert
   * claim file behind; a later lease cannot be confused with it, because
   * owner tokens are never reused.
   *
   * @param {string} lockPath - Absolute lease file path
   * @param {{data: Object|null, mtimeMs: number, ino: number, size: number}} expected
   *   The lease the decision was taken from
   * @param {(current: Object) => boolean} stillWanted - Re-checked on the
   *   lease as re-read under the claim (a takeover re-checks it is expired)
   * @returns {Promise<'removed'|'gone'|'changed'|'busy'>} `gone` when there is
   *   no lease at the path any more, `changed` when it is another lease or no
   *   longer wanted, `busy` when another worker holds the claim
   * @private
   */
  async _removeLease(lockPath, expected, stillWanted) {
    const identity = leaseIdentity(expected);
    const claim = await this._claimRemoval(lockPath, identity);
    if (!claim) return 'busy';
    try {
      const current = await readLease(lockPath);
      if (!current) return 'gone';
      if (leaseIdentity(current) !== identity || !stillWanted(current)) return 'changed';
      return (await removeIfExists(lockPath)) ? 'removed' : 'gone';
    } finally {
      await removeIfExists(claim).catch(() => {});
    }
  }

  /**
   * Win the right to remove one lease instance, or learn that another worker
   * has it.
   *
   * @param {string} lockPath - Absolute lease file path
   * @param {string} identity - `leaseIdentity` of the lease to remove
   * @returns {Promise<string|null>} Path of the claim file now owned by this
   *   call, or null while another worker's claim is live
   * @private
   */
  async _claimRemoval(lockPath, identity) {
    const digest = crypto.createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 16);
    for (let round = 1; ; round++) {
      const claim = `${lockPath}.claim-${digest}-${round}`;
      try {
        const handle = await fs.open(claim, 'wx');
        await handle.close();
        return claim;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
      const stat = await fs.stat(claim).catch(err => {
        if (err.code === 'ENOENT') return null;
        throw err;
      });
      // Released just now, so the lease it was for has been dealt with; the
      // caller reads the path again on its next pass.
      if (!stat) return null;
      if (Date.now() - stat.mtimeMs < CLAIM_STALE_MS) return null;
      // Abandoned by a worker that died holding it: try the next round.
    }
  }

  /**
   * Remove the lease, but only while it is still ours.
   *
   * Goes through the same removal claim as a takeover (`_removeLease`), so a
   * release racing a takeover of the same lease cannot remove the lease the
   * taker publishes next: whichever of the two wins the claim removes ours,
   * and the other finds it gone.
   *
   * @param {string} lockPath - Absolute lease file path
   * @param {string} owner - This holder's token
   * @param {string} name - Lock name, for the log message
   * @returns {Promise<void>}
   */
  async _release(lockPath, owner, name) {
    try {
      const existing = await readLease(lockPath);
      if (!existing) return;
      if (existing.data?.owner !== owner) {
        logger.warn('Storage lease was taken over before release', {
          component: COMPONENT,
          name: String(name).slice(0, 64)
        });
        return;
      }
      await this._removeLease(lockPath, existing, () => true);
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
