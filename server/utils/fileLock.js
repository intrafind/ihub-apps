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
 *    over by exactly one waiter (guarded eviction), and release only removes a lease that is
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

/**
 * Whether an existing lease may be taken over.
 *
 * The lease carries its own `ttlMs`, so a long-running holder is judged by the
 * TTL it asked for rather than by the waiter's. A lease that cannot be parsed
 * is judged by its mtime against the waiter's TTL, so it cannot wedge a path
 * forever. The start time is the *earlier* of what the holder wrote down and
 * what the filesystem recorded: `at` comes from the holder's clock and a skew
 * could otherwise put it in the reader's future so the lease never expires;
 * mtime comes from the same filesystem the reader looks at and is preserved by
 * not rewritten by anything but the holder's own renewal.
 *
 * @param {{data: Object|null, mtimeMs: number}} marker - Result of `readJsonMarker`
 * @param {number} fallbackTtlMs - TTL to apply when the lease says nothing usable
 * @returns {boolean}
 */
export function isExpiredLease(marker, fallbackTtlMs) {
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
 * Identity of one lease *instance*: the owner token, or for a lease too
 * damaged to parse the mtime it was judged by (a renewal rewrites it, nothing else does).
 */
export function leaseIdentity(marker) {
  const owner = marker?.data?.owner;
  return typeof owner === 'string' ? `owner:${owner}` : `mtime:${marker?.mtimeMs}`;
}

/**
 * How long an eviction guard may sit before it is presumed left by a crashed
 * evictor. Eviction is a read and an unlink, so a live one is done in ms.
 */
const EVICTION_GUARD_STALE_MS = 5_000;

/**
 * Remove an abandoned lease so the next `tryCreateExclusive` can decide the new
 * owner — by exactly one waiter.
 *
 * A bare `unlink` is a compare-and-set against nothing: it removes whatever sits
 * at the path *now*, while the decision was taken from a marker read earlier.
 * Waiters A and B read the same abandoned lease, A removes it and creates its
 * own, and B's unlink then deletes A's fresh lease — both run. Moving the lease
 * aside with `rename` and restoring it when it was not the one judged does not
 * close that either: the path is empty in between, a third waiter creates a
 * lease there and the restore loses.
 *
 * So eviction is serialised by a guard file (`<lock>.evict`, created
 * exclusively, held for the length of a read and an unlink). Only its holder
 * removes a lease, and it removes it only after reading it *again* and finding
 * the same lease instance still expired. While the guard is held every other
 * waiter returns and retries: the stale lease still occupies the lock path, so
 * none of them can create a lease in the meantime. A holder that renewed
 * between the two reads is not evicted. A guard left by an evictor that crashed
 * is removed once it is older than {@link EVICTION_GUARD_STALE_MS}; that is the
 * only unserialised step and needs a crash inside a millisecond window.
 *
 * @param {string} lockPath
 * @param {string} owner - This waiter's token
 * @param {{data: Object|null, mtimeMs: number}} expected - The lease judged expired
 * @param {number} ttlMs - TTL applied to a lease that does not state its own
 * @param {string} name - For the log message
 * @param {string} [component]
 */
export async function evictExpiredLease(
  lockPath,
  owner,
  expected,
  ttlMs,
  name,
  component = COMPONENT
) {
  const guard = `${lockPath}.evict`;
  if (!(await tryCreateExclusive(guard, JSON.stringify({ owner })))) {
    const held = await readJsonMarker(guard);
    if (held && Date.now() - held.mtimeMs > EVICTION_GUARD_STALE_MS) {
      logger.warn('Removing an abandoned lease eviction guard', { component, name: short(name) });
      await removeIfExists(guard);
    }
    return;
  }
  try {
    const current = await readJsonMarker(lockPath);
    if (
      current &&
      leaseIdentity(current) === leaseIdentity(expected) &&
      isExpiredLease(current, ttlMs)
    ) {
      await removeIfExists(lockPath);
    }
  } finally {
    await releaseLease(guard, owner, name, component);
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
  const payload = JSON.stringify({
    owner,
    pid: process.pid,
    at: new Date().toISOString(),
    ttlMs
  });
  const timedOut = () =>
    new LockTimeoutError(`Timed out after ${waitMs}ms waiting for lock "${short(name)}"`);
  // At least one attempt even with a zero budget; every path that retries
  // without sleeping found the lease gone or removed an expired one.
  let attempted = false;
  for (;;) {
    if (attempted && Date.now() >= deadline) throw timedOut();
    attempted = true;
    if (await tryCreateExclusive(lockPath, payload)) return;

    const existing = await readJsonMarker(lockPath);
    if (!existing) continue; // released between the two calls — retry at once
    if (isExpiredLease(existing, ttlMs)) {
      logger.warn('Taking over an expired lease', {
        component,
        pid: existing.data?.pid,
        name: short(name)
      });
      await evictExpiredLease(lockPath, owner, existing, ttlMs, name, component);
      // Try at once: eviction costs round-trips, and with a short budget the
      // caller that cleared the dead lease must not be the one that gives up.
      if (await tryCreateExclusive(lockPath, payload)) return;
      continue;
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
 * never briefly empty.
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
    const payload = JSON.stringify({
      owner,
      pid: process.pid,
      at: new Date().toISOString(),
      ttlMs,
      ...(token === undefined ? {} : { token })
    });
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
 * taken over must not delete the new owner's. Never throws: the section already
 * ran, and the TTL makes a leftover lease recoverable.
 */
export async function releaseLease(lockPath, owner, name, component = COMPONENT) {
  try {
    const existing = await readJsonMarker(lockPath);
    if (!existing) return;
    if (existing.data?.owner !== owner) {
      logger.warn('Lease was taken over before release', { component, name: short(name) });
      return;
    }
    await removeIfExists(lockPath);
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
  evictExpiredLease,
  isExpiredLease,
  leaseIdentity
};
