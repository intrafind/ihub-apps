// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Shared-filesystem exclusivity primitives for cluster workers.
 *
 * Every worker of one installation sees the same `contents/` directory, so an
 * exclusively created file (`O_EXCL`) is the one compare-and-set the workers
 * have in common without a database or the cluster bus: whoever creates the
 * file first owns it. Two shapes are built on that:
 *
 *  - `withFileLock(path, fn)` — a critical section guarded by a lease file.
 *    The holder renews the lease while `fn` runs, so `staleMs` only bounds how
 *    long a *crashed* holder blocks the path; a lease nobody renewed is taken
 *    over by exactly one waiter (a per-lease removal claim), and release only removes a lease that is
 *    still the holder's own. When the lock cannot be had within `timeoutMs`
 *    it **throws** {@link LockTimeoutError} — `fn` never runs unguarded.
 *  - `tryCreateExclusive(path, content)` — a durable marker whose lifecycle
 *    the caller manages (e.g. "this interaction is being answered").
 *
 * @module utils/fileLock
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import logger from './logger.js';
import { LockTimeoutError } from '../storage/errors.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Create `filePath` with `content` unless it already exists.
 * @returns {Promise<boolean>} true when this call created the file
 */
export async function tryCreateExclusive(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * Read a JSON marker file. Resolves `null` when the file does not exist;
 * `data` is `null` when it exists but does not (yet) hold valid JSON.
 * @returns {Promise<{data: Object|null, mtimeMs: number}|null>}
 */
export async function readJsonMarker(filePath) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let data = null;
  try {
    data = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    data = null;
  }
  return { data, mtimeMs: stat.mtimeMs };
}

/** Remove a file, ignoring a missing one. */
export async function removeIfExists(filePath) {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

const COMPONENT = 'FileLock';
const short = name => String(name).slice(0, 64);

/** Lifetime below which an unparseable lease is never judged abandoned. */
const MIN_UNPARSEABLE_TTL_MS = 30_000;

/**
 * How old a removal claim must be before it is presumed abandoned by a worker
 * that died between claiming a lease and removing it. A claim is held for a
 * read and an unlink, so this is generous; see {@link removeLease}.
 */
const CLAIM_STALE_MS = 10_000;

/** Error codes of a filesystem that has no hard links (some SMB/FAT mounts). */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV']);

/**
 * Whether an existing lease may be taken over.
 *
 * The lease carries its own `ttlMs`, so a long-running holder is judged by the
 * TTL it asked for rather than by the waiter's. A lease that cannot be parsed
 * (a refresh caught mid-write, a crash, a hand edit) is judged by its own mtime
 * against the waiter's TTL but never less than 30 s: a file that is still being
 * written was touched just now, so it reads as held, while one that stays
 * unreadable ages out and cannot wedge a path forever.
 *
 * The start time is the *earlier* of what the holder wrote down and what the
 * filesystem recorded: `at` comes from the holder's clock, and a skew could
 * otherwise put it in the reader's future so a dead lease never expires. mtime
 * cannot drift from the reader this way. The min can only judge a lease older
 * than the holder claimed, never younger.
 *
 * Both values must come from one read of one file ({@link readLease}).
 *
 * @param {{data: Object|null, mtimeMs: number}} marker - Result of `readLease`
 * @param {number} fallbackTtlMs - TTL to apply when the lease says nothing usable
 * @returns {boolean} True when the lease is older than its TTL
 */
export function isExpiredLease(marker, fallbackTtlMs) {
  const ttlMs =
    Number.isFinite(marker.data?.ttlMs) && marker.data.ttlMs > 0
      ? marker.data.ttlMs
      : marker.data
        ? fallbackTtlMs
        : Math.max(fallbackTtlMs, MIN_UNPARSEABLE_TTL_MS);
  const recordedAt = Date.parse(marker.data?.at ?? '');
  const startedAt = Number.isNaN(recordedAt)
    ? marker.mtimeMs
    : Math.min(recordedAt, marker.mtimeMs);
  return Date.now() - startedAt > ttlMs;
}

/**
 * Identity of one lease *instance*: the owner token (a uuid minted per
 * acquisition), or for a lease too damaged to parse the file itself — inode,
 * mtime and size together.
 */
export function leaseIdentity(marker) {
  const owner = marker?.data?.owner;
  return typeof owner === 'string'
    ? `owner:${owner}`
    : `file:${marker?.ino}:${marker?.mtimeMs}:${marker?.size}`;
}

/**
 * Read a lease file: its content and its metadata through one open handle, so
 * both describe the same file even when the path is replaced meanwhile.
 * (`stat` then `readFile` on the path paired an old lease's mtime with a new
 * holder's content, and a live lease then looked as old as a dead one.)
 *
 * @param {string} lockPath
 * @returns {Promise<{data: Object|null, mtimeMs: number, ino: number, size: number}|null>}
 *   Null when there is no lease; `data` null when it does not parse
 */
export async function readLease(lockPath) {
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
export function leasePayload(owner, ttlMs, token) {
  return JSON.stringify({
    owner,
    pid: process.pid,
    at: new Date().toISOString(),
    ttlMs,
    ...(token === undefined ? {} : { token })
  });
}

/**
 * Put a lease on the path unless one is there: atomically, and whole.
 *
 * The content goes to a scratch file first, which is then hard-linked onto the
 * lease path. `link` refuses an existing target with `EEXIST`, so it is the
 * same election `O_EXCL` is, but the lease appears with its content already in
 * it; created with `O_EXCL` and written afterwards a lease spends a moment as
 * an empty file. Without hard links this falls back to `O_EXCL`, where an empty
 * lease was written just now and counts as held (see {@link isExpiredLease}).
 *
 * @returns {Promise<boolean>} True when this call created the lease
 */
export async function publishLease(lockPath, content) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
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
 * POSIX has no compare-and-delete: `unlink` removes whatever sits at the path,
 * while the decision to remove was taken from a read a round-trip earlier.
 * Unlinking lets two waiters that saw the same abandoned lease both unlink, the
 * second deleting the fresh lease the first created meanwhile. Renaming the
 * lease aside and linking it back when it was the wrong one leaves the path
 * empty in between, and a third waiter publishing there makes two holders. (Nor
 * is `unlink` an election: two concurrent unlinks can both succeed on macOS.)
 *
 * So removal is serialized per lease instance. Whoever wants to remove a lease
 * — a waiter taking it over, or its holder releasing it — first creates a claim
 * file named after that lease's identity with `O_EXCL`; exactly one worker wins
 * it. The winner re-reads the path. The lease at a path changes in only two
 * ways: a new one is published, which `link` allows only while the path is
 * empty, or the current one is removed, which needs its claim. So when the
 * re-read still finds the expected lease, it stays until the claim holder
 * unlinks it, and that unlink removes exactly that lease. Nothing is ever moved
 * off the path and put back. A holder refreshing its lease rewrites it in place
 * (same identity); the re-read re-checks `stillWanted`, so a lease refreshed
 * meanwhile is left alone.
 *
 * The one assumption is about time, the kind the TTL makes: a claim older than
 * 10 s is presumed to belong to a dead worker and the next round's claim is
 * taken. A worker killed holding a claim leaves an inert `*.claim-*` file.
 *
 * @param {string} lockPath
 * @param {{data: Object|null, mtimeMs: number, ino: number, size: number}} expected
 *   The lease the decision was taken from
 * @param {(current: Object) => boolean} stillWanted - Re-checked on the lease
 *   as re-read under the claim
 * @returns {Promise<'removed'|'gone'|'changed'|'busy'>}
 */
export async function removeLease(lockPath, expected, stillWanted) {
  const identity = leaseIdentity(expected);
  const claim = await claimRemoval(lockPath, identity);
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
 * Win the right to remove one lease instance, or learn that another worker has
 * it. Returns the claim file now owned by this call, or null while another
 * worker's claim is live.
 */
async function claimRemoval(lockPath, identity) {
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
 * Create the lease at `lockPath`, waiting out (or taking over) an existing one.
 *
 * @param {string} lockPath
 * @param {string} owner - This holder's token
 * @param {Object} opts
 * @param {number} opts.ttlMs - Lease lifetime recorded in the file
 * @param {number} opts.waitMs - Acquisition budget
 * @param {number} opts.pollMs
 * @param {string} opts.name - Lock name for messages
 * @param {string} [opts.component]
 * @throws {LockTimeoutError} When the budget ran out
 */
export async function acquireLease(
  lockPath,
  owner,
  { ttlMs, waitMs, pollMs, name, component = COMPONENT }
) {
  const deadline = Date.now() + waitMs;
  // Stamped per attempt, not once up front: a lease that recorded when its
  // waiter *started* waiting looked abandoned the moment it appeared whenever
  // the wait had outlasted the TTL.
  const publish = () => publishLease(lockPath, leasePayload(owner, ttlMs));
  const timedOut = () =>
    new LockTimeoutError(`Timed out after ${waitMs}ms waiting for lock "${short(name)}"`);
  // At least one attempt even with a zero budget; every path that retries
  // without sleeping found the lease gone or removed an expired one.
  let attempted = false;
  for (;;) {
    if (attempted && Date.now() >= deadline) throw timedOut();
    attempted = true;
    if (await publish()) return;

    const existing = await readLease(lockPath);
    if (!existing) continue; // released between the two calls — retry at once
    if (isExpiredLease(existing, ttlMs)) {
      const outcome = await removeLease(lockPath, existing, current =>
        isExpiredLease(current, ttlMs)
      );
      if (outcome === 'removed') {
        logger.warn('Took over an expired lease', {
          component,
          pid: existing.data?.pid,
          name: short(name)
        });
      }
      if (outcome === 'removed' || outcome === 'gone') {
        // Try at once: with a short budget the caller that cleared the dead
        // lease must not be the one that gives up on it.
        if (await publish()) return;
        continue;
      }
      // 'changed' (another lease is there now, or this one was refreshed) or
      // 'busy' (another worker is removing it): wait as for any lease.
    }
    if (Date.now() >= deadline) throw timedOut();
    await sleep(pollMs);
  }
}

/**
 * Rewrite our own lease's start time and report whether we still hold it.
 *
 * Opened `r+`: an evicted lease is gone from the path, and a plain write would
 * put a file carrying our dead token back where the new holder is about to
 * create theirs. The payload is written before the truncate so the file is
 * never briefly empty; a reader that catches a torn refresh finds an
 * unparseable lease written just now, which counts as held.
 *
 * @returns {Promise<boolean>} False once the lease is no longer ours
 */
export async function touchLease(lockPath, owner, ttlMs, name, token, component = COMPONENT) {
  let handle;
  try {
    handle = await fs.open(lockPath, 'r+');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.warn('Could not refresh a lease', {
        component,
        name: short(name),
        error: err.message
      });
      return true; // transient — keep refreshing
    }
    logger.warn('Lease disappeared while it was held', { component, name: short(name) });
    return false;
  }
  try {
    let parsed = null;
    try {
      parsed = JSON.parse(await handle.readFile('utf8'));
    } catch {
      parsed = null;
    }
    if (parsed?.owner !== owner) {
      logger.warn('Lease was taken over while it was held', { component, name: short(name) });
      return false;
    }
    const payload = leasePayload(owner, ttlMs, token);
    await handle.write(payload, 0, 'utf8');
    await handle.truncate(Buffer.byteLength(payload, 'utf8'));
    return true;
  } catch (error) {
    logger.warn('Could not refresh a lease', {
      component,
      name: short(name),
      error: error.message
    });
    return true;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Keep a held lease young while its critical section runs, so `ttlMs` bounds
 * only how long a *crashed* holder blocks the path. The timer is unref'd.
 *
 * @returns {() => void} Stops the renewal; safe to call more than once
 */
export function startLeaseRenewal(
  lockPath,
  owner,
  ttlMs,
  renewMs,
  name,
  token,
  component = COMPONENT
) {
  let stopped = false;
  let inFlight = false;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = true;
    void touchLease(lockPath, owner, ttlMs, name, token, component)
      .then(kept => {
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
 * Remove the lease, but only while it is still ours — a holder whose lease was
 * taken over must not delete the new owner's. It goes through the same removal
 * claim as a takeover, so a release racing a takeover cannot remove the lease
 * the taker publishes next. Never throws: the section already ran, and the TTL
 * makes a leftover lease recoverable.
 */
export async function releaseLease(lockPath, owner, name, component = COMPONENT) {
  try {
    const existing = await readLease(lockPath);
    if (!existing) return;
    if (existing.data?.owner !== owner) {
      logger.warn('Lease was taken over before release', { component, name: short(name) });
      return;
    }
    await removeLease(lockPath, existing, () => true);
  } catch (error) {
    logger.error('Failed to release lease', { component, name: short(name), error });
  }
}

/**
 * Run `fn` while holding the lock file at `lockPath`.
 *
 * Waits (polling) up to `timeoutMs` for a lock held elsewhere, then throws
 * {@link LockTimeoutError} (503) — `fn` **never** runs without the lock. A
 * lease nobody renewed for `staleMs` is presumed abandoned and taken over; a
 * live holder renews every `staleMs / 3`, so it is never preempted however long
 * `fn` takes. Release only removes a lease that is still this holder's.
 *
 * Not reentrant: a nested call on the same path waits for its own caller's
 * lease and times out.
 *
 * @param {string} lockPath
 * @param {() => Promise<T>} fn
 * @param {Object} [opts]
 * @param {number} [opts.staleMs=15000] - Age at which an unrenewed lease is taken over
 * @param {number} [opts.timeoutMs=5000] - Acquisition budget
 * @param {number} [opts.pollMs=20]
 * @param {number} [opts.renewMs] - Renewal interval; default `staleMs / 3`, 0 disables
 * @param {string} [opts.component='FileLock']
 * @returns {Promise<T>}
 * @throws {LockTimeoutError} When the lock was not acquired within `timeoutMs`
 * @template T
 */
export async function withFileLock(
  lockPath,
  fn,
  { staleMs = 15_000, timeoutMs = 5_000, pollMs = 20, renewMs, component = COMPONENT } = {}
) {
  const owner = crypto.randomUUID();
  const name = path.basename(lockPath);
  await acquireLease(lockPath, owner, {
    ttlMs: staleMs,
    waitMs: timeoutMs,
    pollMs,
    name,
    component
  });
  const renew = renewMs ?? Math.max(1, Math.floor(staleMs / 3));
  const stopRenewal =
    renew > 0
      ? startLeaseRenewal(lockPath, owner, staleMs, renew, name, undefined, component)
      : null;
  try {
    return await fn();
  } finally {
    stopRenewal?.();
    await releaseLease(lockPath, owner, name, component);
  }
}

export default {
  withFileLock,
  tryCreateExclusive,
  readJsonMarker,
  removeIfExists,
  acquireLease,
  releaseLease,
  touchLease,
  startLeaseRenewal,
  publishLease,
  removeLease,
  readLease,
  leasePayload,
  isExpiredLease,
  leaseIdentity
};
