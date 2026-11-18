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
 * The lease primitives — publishing a lease whole (scratch file `link`ed onto
 * the path), the per-lease removal claim that makes a takeover or release a
 * compare-and-delete, owner-checked release, renewal, and one-read judging of
 * a lease — live in `utils/fileLock.js` and are shared with `withFileLock`.
 * This class adds the named-lease layout and the fencing tokens. Both fail
 * closed: when the lease cannot be had within the wait, `LockTimeoutError` is
 * thrown and `fn` never runs.
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
 * The counter is seeded from the clock (`max(previous + 1, now)`), which is
 * what lets {@link FilesystemLockManager#sweepIdleFences} delete the counter of
 * a name nobody has locked for a day: the next token is still larger than any
 * token issued before the deletion. Without the sweep every lock name ever
 * used — one per chat, per run, per import — left a counter file behind for
 * good (346 000 of them on one load-test installation).
 *
 * @module storage/providers/filesystem/FilesystemLockManager
 */
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import {
  acquireLease,
  isExpiredLease,
  readLease,
  releaseLease,
  removeIfExists,
  startLeaseRenewal,
  touchLease,
  withLeaseLine
} from '../../../utils/fileLock.js';
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

/** How long a fencing counter must sit untouched before the sweep removes it. */
export const DEFAULT_FENCE_IDLE_MS = 24 * 60 * 60 * 1000;

/** Lease the sweep holds while it removes one counter: a few file operations. */
/** Idle counters the sweep handles between pauses, and the pause. */
const SWEEP_BATCH = 50;
const SWEEP_PAUSE_MS = 1000;
const SWEEP_LEASE_TTL_MS = 10_000;

/** A lease, fencing counter, or counter scratch file name: digest, suffix, rest. */
const LOCK_FILE_NAME = /^([0-9a-f]{40})\.(lock|fence)(\..+)?$/;

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
   * {@link LockTimeoutError} after `waitMs`.
   *
   * `fn` receives the lease (`{ name, token, isCurrent }`): `token` is this
   * acquisition's fencing token, `isCurrent()` whether it still holds the
   * lease (see {@link FilesystemLockManager#isTokenCurrent}).
   *
   * `fence: false` skips the token: no counter is read or written and the
   * lease is not rewritten to name one, which saves about a dozen file
   * operations per acquisition. Exclusion, renewal and release are the same.
   * For sections that never read `token` (a chat or run-summary
   * read-modify-write, which already guards itself with an etag). Such a
   * section gets `token: null`, and `isCurrent()` then only asks whether the
   * lease file is still this acquisition's and has not aged out. Tokens stay
   * increasing across the fenced acquisitions of a name; an unfenced one in
   * between takes none, and a fenced holder it took over still reads false.
   *
   * Callers of one process wait in memory, in line, instead of each polling
   * the lease file, and an unfenced lease is handed straight to the next local
   * caller with the same `ttlMs` and `renewMs`, for a bounded run while another
   * process waits (`withLeaseLine` in `utils/fileLock.js`). A lease renewed
   * more rarely than every half TTL stays out of the line: it may age out, and
   * any caller must then be able to take it over.
   *
   * @param {string} name - Lock name; any non-empty string
   * @param {(lease: import('../../LockManager.js').LockLease) => Promise<T>|T} fn - The critical section
   * @param {Object} [opts]
   * @param {number} [opts.ttlMs=30000] - Lease lifetime; an older lease is taken over
   * @param {number} [opts.waitMs=5000] - How long to wait for a held lease
   * @param {number} [opts.renewMs] - Refresh interval while `fn` runs; defaults
   *   to a third of `ttlMs`. 0 disables renewal, so the lease ages out under a
   *   running holder
   * @param {boolean} [opts.fence=true] - Issue a fencing token (see above)
   * @returns {Promise<T>} Whatever `fn` returned
   * @throws {InvalidKeyError} When `name` is not a non-empty string
   * @throws {LockTimeoutError} When the lease could not be acquired within `waitMs`
   * @template T
   */
  async withLock(
    name,
    fn,
    { ttlMs = DEFAULT_TTL_MS, waitMs = DEFAULT_WAIT_MS, renewMs, fence = true } = {}
  ) {
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
    // Callers of this process line up in memory (`withLeaseLine`): only the
    // head of the line polls the lease file, and an unfenced lease is handed
    // straight to the next local caller with the same TTL and renewal.
    return withLeaseLine(
      lockPath,
      async held => {
        let token = null;
        if (fence) {
          // A fenced lease is not handed on: renewal would rewrite the next
          // section's token with this one's.
          held.noHandOff = true;
          try {
            token = await this._issueToken(name);
            // The lease names its token, so `isTokenCurrent` can tell this lease
            // from one a later holder created after taking the name over.
            if (!(await this._touch(lockPath, held.owner, ttl, name, token, held.clock))) {
              // Lost before the section started (a TTL shorter than issuing the
              // token takes): running `fn` now would run it without the lock.
              throw new LockTimeoutError(
                `Storage lock "${String(name).slice(0, 64)}" was taken over before its section started`
              );
            }
          } catch (error) {
            held.lost = true;
            throw error;
          }
          if (renew > 0) {
            held.stopRenewal = this._startRenewal(
              lockPath,
              held.owner,
              ttl,
              renew,
              name,
              token,
              held.clock,
              () => (held.lost = true)
            );
          }
        }
        const lease = Object.freeze({
          name,
          token,
          isCurrent: fence
            ? () => this.isTokenCurrent(name, token)
            : () => this._isLeaseOwned(lockPath, held.owner, ttl)
        });
        return fn(lease);
      },
      {
        name,
        component: COMPONENT,
        timeoutMs: wait,
        pollMs: this._pollMs,
        // A lease that may age out under its holder is taken over from the file.
        lined: renew > 0 && renew <= ttl / 2,
        // A fenced section needs a lease of its own (see above).
        reusable: held => !fence && held.ttlMs === ttl && held.renewMs === renew,
        acquire: async (waitMs, politeUntil) => {
          // The owner token is what makes a takeover safe: only the holder that
          // still matches the token on disk may unlink the lease, so a holder
          // whose lease expired and was taken over cannot delete the new
          // holder's lease.
          const owner = crypto.randomUUID();
          const writtenAt = await this._acquire(lockPath, owner, ttl, waitMs, name, politeUntil);
          // `clock`: when the lease was last written, for the fast release (`releaseLease`).
          const held = {
            owner,
            name,
            ttlMs: ttl,
            renewMs: renew,
            clock: { writtenAt, ttlMs: ttl },
            lost: false,
            stopRenewal: null,
            onRelease: () => this._held.delete(lockPath)
          };
          this._held.set(lockPath, held);
          // A fenced section starts the renewal itself, with its token.
          if (renew > 0 && !fence) {
            held.stopRenewal = this._startRenewal(
              lockPath,
              owner,
              ttl,
              renew,
              name,
              undefined,
              held.clock,
              () => (held.lost = true)
            );
          }
          return held;
        }
      }
    );
  }

  /**
   * Keep a held lease young while its section runs (`startLeaseRenewal` in
   * `utils/fileLock.js`, shared with `withFileLock`).
   *
   * @returns {() => void} Stops the renewal; safe to call more than once
   * @private
   */
  _startRenewal(lockPath, owner, ttlMs, renewMs, name, token, clock, onLost) {
    return startLeaseRenewal(
      lockPath,
      owner,
      ttlMs,
      renewMs,
      name,
      token,
      COMPONENT,
      onLost,
      clock
    );
  }

  /**
   * Whether the lease at `lockPath` is still `owner`'s and has not aged out:
   * `isCurrent()` of an unfenced acquisition.
   *
   * @returns {Promise<boolean>}
   * @private
   */
  async _isLeaseOwned(lockPath, owner, ttlMs) {
    const lease = await readLease(lockPath);
    return lease?.data?.owner === owner && !isExpiredLease(lease, ttlMs);
  }

  /**
   * Rewrite our own lease's start time, and report whether we still hold it
   * (`touchLease`).
   *
   * @returns {Promise<boolean>} False once the lease is no longer ours
   * @private
   */
  _touch(lockPath, owner, ttlMs, name, token, clock) {
    return touchLease(lockPath, owner, ttlMs, name, token, COMPONENT, clock);
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
   * the old counter or the new one, never a torn one.
   *
   * The token is `max(previous + 1, now in ms)`: it grows by one per
   * acquisition and never falls behind the clock. That is what makes a missing
   * counter safe — one swept as idle ({@link FilesystemLockManager#sweepIdleFences})
   * or damaged by hand (unreadable, so it continues from the clock) — because
   * every token issued before was at most the counter's value when it was last
   * written, and that was more than a day ago. A clock set back keeps the
   * `previous + 1` side, so the token still grows.
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
    const token = Math.max(previous + 1, Date.now());
    const scratch = `${fencePath}.${process.pid}-${crypto.randomUUID()}`;
    // No mkdir: the caller's lease file was just published in this directory.
    try {
      await fs.writeFile(scratch, JSON.stringify({ token }), 'utf8');
      await fs.rename(scratch, fencePath);
    } catch (error) {
      // After a successful rename the scratch name is gone; only a failed
      // write or rename leaves one behind.
      await removeIfExists(scratch).catch(() => {});
      throw error;
    }
    return token;
  }

  /**
   * Remove the fencing counters of names nobody has locked for `idleMs`, and
   * counter scratch files left behind by a crash.
   *
   * Safe against a running holder and against a later one:
   * - a token is issued only by the holder of the name's lease, and the sweep
   *   takes the same lease (one attempt, no wait — a name in use is simply
   *   skipped) and checks the age again under it, so no token is issued while
   *   a counter is being removed;
   * - a counter is removed only when its token is below the current time, so
   *   the next token for the name — at least the current time
   *   ({@link FilesystemLockManager#_issueToken}) — is larger than any token
   *   issued before; a counter that ran ahead of the clock is kept until the
   *   clock passes it;
   * - the sweep's lease is not renewed, so it is checked to be still ours right
   *   before the counter goes;
   * - a holder still working with an old token finds `isCurrent()` false: the
   *   counter it compared against is gone.
   *
   * The lease and counter files are named by a digest of the lock name, so
   * the sweep never needs the name itself.
   *
   * @param {Object} [options]
   * @param {number} [options.idleMs=86400000] - Minimum age (modification time)
   * @param {() => boolean} [options.shouldStop] - Checked between files; true
   *   ends the sweep early (provider shutdown)
   * @param {number} [options.batch=50] - Counters handled between pauses
   * @param {number} [options.pauseMs=1000] - Pause after each batch. Each
   *   counter costs several file creations and removals; a first sweep over a
   *   backlog of hundreds of thousands, unpaced, kept the disk busy enough to
   *   slow requests for many minutes after it ended. Paced, it drains such a
   *   backlog in the background over hours, and a day's idle counters in minutes.
   * @returns {Promise<{removed: number, scratch: number, busy: number}>}
   *   Counters removed, scratch files and stale want markers removed, counters
   *   skipped because their name was locked
   */
  async sweepIdleFences({
    idleMs = DEFAULT_FENCE_IDLE_MS,
    shouldStop = () => false,
    batch = SWEEP_BATCH,
    pauseMs = SWEEP_PAUSE_MS
  } = {}) {
    const outcome = { removed: 0, scratch: 0, busy: 0 };
    let handled = 0;
    const pace = async () => {
      handled += 1;
      if (pauseMs > 0 && handled % batch === 0) {
        await new Promise(resolve => setTimeout(resolve, pauseMs).unref?.());
      }
    };
    let names;
    try {
      names = await fs.readdir(this.lockDir);
    } catch (error) {
      if (error.code === 'ENOENT') return outcome;
      throw error;
    }
    const isIdle = async file => {
      try {
        return Date.now() - (await fs.stat(file)).mtimeMs >= idleMs;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    };
    for (const entry of names) {
      if (shouldStop()) break;
      const match = LOCK_FILE_NAME.exec(entry);
      const wantMarker = match?.[2] === 'lock' && match[3] === '.want';
      if (!match || (match[2] !== 'fence' && !wantMarker)) continue;
      const file = containedPath(this._baseDir, LOCKS_DIR, entry);
      if (!(await isIdle(file))) continue;
      await pace();
      if (shouldStop()) break;
      if (wantMarker || match[3]) {
        // `<digest>.lock.want`: a waiter's request (see `signalWant` in
        // fileLock.js) left by a process that died waiting; a live one lasts
        // one lock wait.
        // `<digest>.fence.<pid>-<uuid>`: a counter write that never reached
        // its rename. A live one is milliseconds old.
        if (await removeIfExists(file)) outcome.scratch += 1;
        continue;
      }
      const lockPath = containedPath(this._baseDir, LOCKS_DIR, `${match[1]}.lock`);
      const owner = crypto.randomUUID();
      try {
        await acquireLease(lockPath, owner, {
          ttlMs: SWEEP_LEASE_TTL_MS,
          waitMs: 0,
          pollMs: this._pollMs,
          name: match[1],
          component: COMPONENT
        });
      } catch (error) {
        if (!(error instanceof LockTimeoutError)) throw error;
        outcome.busy += 1;
        continue;
      }
      try {
        // Only a counter the clock has passed: one that ran ahead of it (a
        // clock corrected backwards, more than one acquisition per ms) would
        // otherwise restart below tokens it already issued. And only while the
        // lease is still ours — it is not renewed, so a slow sweep could have
        // lost it to a waiter that took it over as expired.
        if (
          (await isIdle(file)) &&
          (await this._fenceBehindClock(file)) &&
          (await this._touch(lockPath, owner, SWEEP_LEASE_TTL_MS, match[1])) &&
          (await removeIfExists(file))
        ) {
          outcome.removed += 1;
        }
      } finally {
        await this._release(lockPath, owner, match[1]);
      }
    }
    return outcome;
  }

  /**
   * Whether the counter at `file` holds a token below the current time. An
   * unreadable counter counts as behind: the next acquisition continues from
   * the clock either way.
   *
   * @param {string} file - Counter path
   * @returns {Promise<boolean>}
   * @private
   */
  async _fenceBehindClock(file) {
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    let token;
    try {
      token = JSON.parse(text)?.token;
    } catch {
      return true;
    }
    return !Number.isSafeInteger(token) || token < Date.now();
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
    for (const [lockPath, lease] of held) {
      // Not to be handed on to a caller still waiting in this process, nor
      // released a second time when its section ends.
      lease.released = true;
      lease.noHandOff = true;
      lease.stopRenewal?.();
      await this._release(lockPath, lease.owner, lease.name);
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
   * Create the lease, waiting out (or taking over) an existing one
   * (`acquireLease`).
   *
   * @throws {LockTimeoutError} When the budget ran out
   * @private
   */
  _acquire(lockPath, owner, ttlMs, waitMs, name, politeUntil = 0) {
    return acquireLease(lockPath, owner, {
      ttlMs,
      waitMs,
      pollMs: this._pollMs,
      name,
      component: COMPONENT,
      politeUntil
    });
  }

  /**
   * Remove the lease, but only while it is still ours (`releaseLease`); with
   * `clock`, by one unlink while the lease is young enough.
   *
   * @private
   */
  _release(lockPath, owner, name, clock) {
    return releaseLease(lockPath, owner, name, COMPONENT, clock);
  }
}

export default FilesystemLockManager;
