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
import { writeInDirectory } from './atomicWrite.js';
import { LockTimeoutError } from '../storage/errors.js';
import { lockPrefix, lockStats, recordLockHold } from '../telemetry/waitDiagnostics.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Create `filePath` with `content` unless it already exists.
 * @returns {Promise<boolean>} true when this call created the file
 */
export async function tryCreateExclusive(filePath, content) {
  try {
    await writeInDirectory(path.dirname(filePath), () =>
      fs.writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' })
    );
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
    // One positional read sized by that stat (`readFile` would fstat again);
    // the extra byte notices a lease that grew meanwhile, which is read whole.
    const buffer = Buffer.allocUnsafe(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text =
      bytesRead > stat.size ? await handle.readFile('utf8') : buffer.toString('utf8', 0, bytesRead);
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
 * Put a lease on the path unless one is there.
 *
 * `O_EXCL` is the election: exactly one caller creates the file. The content
 * follows on the same handle, so for a moment the lease is an empty file; a
 * reader that catches it finds an unparseable lease written just now, which
 * counts as held (see {@link isExpiredLease}), so nobody takes it over. That
 * is three syscalls (open,
 * write, close); writing a scratch file and hard-linking it onto the path took
 * five, plus a `mkdir` every time. The directory is created only when the
 * first attempt reports it missing.
 *
 * A failed write removes the file again: it was created by this call a moment
 * ago and is nobody else's lease.
 *
 * @returns {Promise<boolean>} True when this call created the lease
 */
export async function publishLease(lockPath, content) {
  let handle;
  try {
    handle = await fs.open(lockPath, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    if (err.code !== 'ENOENT') throw err;
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    try {
      handle = await fs.open(lockPath, 'wx');
    } catch (retryErr) {
      if (retryErr.code === 'EEXIST') return false;
      throw retryErr;
    }
  }
  try {
    await handle.writeFile(content, 'utf8');
    await handle.close();
  } catch (err) {
    await handle.close().catch(() => {});
    await removeIfExists(lockPath).catch(() => {});
    throw err;
  }
  return true;
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
 * ways: a new one is published, which `O_EXCL` allows only while the path is
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
 * @returns {Promise<number>} `performance.now()` taken right before the write
 *   that published the lease began (see {@link releaseLease})
 * @throws {LockTimeoutError} When the budget ran out
 */
export async function acquireLease(lockPath, owner, opts) {
  // Wait time, timeouts and current waiters per lock prefix, for the
  // `diagnostics` of `GET /api/admin/system/resources`.
  const diag = lockStats(lockPrefix(opts.name, opts.component ?? COMPONENT));
  const startedAt = performance.now();
  diag.waiters += 1;
  try {
    const writtenAt = await acquireLeaseUntimed(lockPath, owner, opts);
    diag.acquisitions += 1;
    diag.wait.record(performance.now() - startedAt);
    return writtenAt;
  } catch (error) {
    if (error instanceof LockTimeoutError) diag.timeouts += 1;
    throw error;
  } finally {
    diag.waiters -= 1;
  }
}

/** Longest pause between two looks at a held lease, as a multiple of `pollMs`. */
const MAX_POLL_FACTOR = 8;

async function acquireLeaseUntimed(
  lockPath,
  owner,
  { ttlMs, waitMs, pollMs, name, component = COMPONENT, politeUntil = 0 }
) {
  const deadline = Date.now() + waitMs;
  // Whether this waiter created the want marker (see `signalWant`); it removes
  // it again once it has the lease or gives up. Asked again on every round: a
  // holder that gave way removed it, and another process may have got in first.
  let wanted = false;
  try {
    const writtenAt = await waitForLease(lockPath, owner, {
      ttlMs,
      waitMs,
      pollMs,
      name,
      component,
      politeUntil,
      deadline,
      onWait: async () => {
        if (await signalWant(lockPath)) wanted = true;
      }
    });
    return writtenAt;
  } finally {
    if (wanted) await removeIfExists(wantPath(lockPath)).catch(() => {});
  }
}

async function waitForLease(
  lockPath,
  owner,
  { ttlMs, waitMs, pollMs, name, component, politeUntil, deadline, onWait }
) {
  // Stamped per attempt, not once up front: a lease that recorded when its
  // waiter *started* waiting looked abandoned the moment it appeared whenever
  // the wait had outlasted the TTL.
  let writtenAt;
  const publish = async () => {
    const at = performance.now();
    if (!(await publishLease(lockPath, leasePayload(owner, ttlMs)))) return false;
    writtenAt = at;
    return true;
  };
  const timedOut = () =>
    new LockTimeoutError(`Timed out after ${waitMs}ms waiting for lock "${short(name)}"`);
  // A process that has just stepped back for another one's waiter (see
  // `passTurn`) leaves the free path to it for a moment and only takes it when
  // nobody else did; once it finds a lease there, it waits as usual.
  const polite = () => Date.now() < Math.min(politeUntil, deadline);
  // At least one attempt even with a zero budget.
  if (!polite() && (await publish())) return writtenAt;
  // A waiter only reads the lease (open, fstat, read, close) and publishes
  // once it is gone; publishing on every round cost a create attempt on top.
  // The pause doubles from `pollMs` up to MAX_POLL_FACTOR times it, jittered so
  // waiters in different workers do not poll in step.
  let pause = pollMs;
  for (;;) {
    const existing = await readLease(lockPath);
    if (!existing) {
      if (polite()) {
        await sleep(pollMs);
        continue;
      }
      if (await publish()) return writtenAt;
      continue; // someone else published first — read theirs
    }
    politeUntil = 0;
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
        if (await publish()) return writtenAt;
        continue;
      }
      // 'changed' (another lease is there now, or this one was refreshed) or
      // 'busy' (another worker is removing it): wait as for any lease.
    }
    const left = deadline - Date.now();
    if (left <= 0) throw timedOut();
    await onWait();
    await sleep(Math.min(left, pause * (0.5 + Math.random() / 2)));
    pause = Math.min(pause * 2, pollMs * MAX_POLL_FACTOR);
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
 * @param {{writtenAt: number}} [clock] - Set to `performance.now()` taken
 *   before a refresh that was written (see {@link releaseLease})
 * @returns {Promise<boolean>} False once the lease is no longer ours
 */
export async function touchLease(
  lockPath,
  owner,
  ttlMs,
  name,
  token,
  component = COMPONENT,
  clock
) {
  const startedAt = performance.now();
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
    // The read stays outside the parse guard: a failed read says nothing about
    // who owns the lease, so it must reach the transient-error handler below
    // (keep renewing). Treating it as "not ours" would stop the heartbeat for
    // good while the section is still running.
    const current = await handle.readFile('utf8');
    let parsed = null;
    try {
      parsed = JSON.parse(current);
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
    if (clock) clock.writtenAt = startedAt;
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
 * @param {() => void} [onLost] - Called once the lease is found to be no longer ours
 * @param {{writtenAt: number}} [clock] - Kept up to date by every refresh
 *   written (see {@link touchLease})
 * @returns {() => void} Stops the renewal; safe to call more than once
 */
export function startLeaseRenewal(
  lockPath,
  owner,
  ttlMs,
  renewMs,
  name,
  token,
  component = COMPONENT,
  onLost,
  clock
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
    void touchLease(lockPath, owner, ttlMs, name, token, component, clock)
      .then(kept => {
        if (!kept) {
          stop();
          onLost?.();
        }
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
 * the taker publishes next. The holder knows its lease's identity (its owner
 * token), so the lease is read once, under the claim, not before it as well.
 * Never throws: the section already ran, and the TTL makes a leftover lease
 * recoverable.
 *
 * Fast path: with a `clock` whose last publish or refresh *started* less than
 * a third of the lease's TTL ago, the lease is removed with one `unlink` — no
 * claim, no read-back. Nobody can judge a lease that young expired
 * ({@link isExpiredLease} needs it older than its TTL), and only an expired
 * lease is ever claimed or replaced by someone else, so the file at the path
 * is still ours. The other two thirds of the TTL are the margin for a coarse
 * mtime and for the time between this check and the unlink running.
 * ponytail: the margin assumes the unlink runs within ~2/3 TTL of the check
 * (10 s at 15 s); a thread pool stalled longer than that could remove a lease
 * taken over meanwhile. Shorten the window if such stalls are ever seen.
 *
 * @param {{writtenAt: number, ttlMs: number}} [clock] - When this holder last
 *   wrote the lease (`performance.now()` before the write) and its TTL
 */
export async function releaseLease(lockPath, owner, name, component = COMPONENT, clock) {
  try {
    if (clock && performance.now() - clock.writtenAt < clock.ttlMs / 3) {
      await removeIfExists(lockPath);
      return;
    }
    const outcome = await removeLease(lockPath, { data: { owner } }, () => true);
    if (outcome === 'changed') {
      logger.warn('Lease was taken over before release', { component, name: short(name) });
    }
  } catch (error) {
    logger.error('Failed to release lease', { component, name: short(name), error });
  }
}

/**
 * Fair turns between processes. Callers of one process line up in memory (see
 * `localLines`) and a holder hands its lease straight to the next local
 * caller. Without a bound one busy process kept a hot lease for good: the
 * other processes' waiters sleep between looks at it (up to `MAX_POLL_FACTOR`
 * times `pollMs`) and never found the path free.
 *
 * So a waiter that finds the lease held puts a *want* marker beside it
 * (`<lease>.want`, see {@link signalWant}). A holder that has handed its lease
 * on for {@link MAX_HANDOFF_HOLD_MS} or {@link MAX_HANDOFFS} turns, whichever
 * comes first, and finds the marker, removes it and releases the lease; its
 * next local caller then leaves the free path to the other process for one
 * poll pause before it takes it itself. With no marker the lease is kept: no
 * other process is waiting, and releasing would only cost a re-acquire.
 */
const MAX_HANDOFFS = 8;
const MAX_HANDOFF_HOLD_MS = 75;

/** The marker a waiter of another process leaves beside a held lease. */
const wantPath = lockPath => `${lockPath}.want`;

/**
 * Say that a waiter wants the lease at `lockPath`.
 * @returns {Promise<boolean>} True when this call created the marker
 */
async function signalWant(lockPath) {
  try {
    const handle = await fs.open(wantPath(lockPath), 'wx');
    await handle.close();
    return true;
  } catch {
    // EEXIST: somebody already asked. Anything else: no signal, the bounded
    // hand-off is the only thing lost.
    return false;
  }
}

/**
 * This process's holders and waiters per lock path. Callers of `withFileLock`
 * and of `FilesystemLockManager.withLock` in one process line up here, in
 * memory, in front of the lease file: only the head of the line touches the
 * file, and a holder passes its lease straight to the next local waiter instead
 * of releasing and re-creating it (see `MAX_HANDOFFS` for the bound).
 *
 * @type {Map<string, {waiters: Array<() => void>, lease: Object|null, handoffs: number, heldSince: number, politeUntil: number}>}
 */
const localLines = new Map();

/** Wait for this process's turn at `line`, or throw once `deadline` passes. */
function waitLocalTurn(line, deadline, waitMs, name) {
  return new Promise((resolve, reject) => {
    const turn = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(
      () => {
        const at = line.waiters.indexOf(turn);
        if (at >= 0) line.waiters.splice(at, 1);
        reject(
          new LockTimeoutError(`Timed out after ${waitMs}ms waiting for lock "${short(name)}"`)
        );
      },
      Math.max(0, deadline - Date.now())
    );
    line.waiters.push(turn);
  });
}

/** Stop renewing the line's lease and remove it, while it is still ours. */
async function releaseLineLease(lockPath, line, name, component) {
  const lease = line.lease;
  line.lease = null;
  line.handoffs = 0;
  lease.stopRenewal?.();
  lease.onRelease?.();
  await releaseLease(lockPath, lease.owner, name, component, lease.lost ? undefined : lease.clock);
}

/**
 * End a turn at `line`: hand the lease to the next local waiter while it is
 * renewed, still ours and may be handed on, unless the run of hand-offs is
 * long and another process wants the lease; else release it. Then wake the
 * next waiter, or forget the line.
 */
async function passTurn(lockPath, line, name, component, pollMs) {
  const lease = line.lease;
  let handOff =
    lease && lease.stopRenewal && !lease.lost && !lease.noHandOff && line.waiters.length > 0;
  if (
    handOff &&
    (line.handoffs >= MAX_HANDOFFS || performance.now() - line.heldSince >= MAX_HANDOFF_HOLD_MS)
  ) {
    if (await removeIfExists(wantPath(lockPath)).catch(() => false)) {
      handOff = false;
      // Longer than another process's longest pause between looks.
      line.politeUntil = Date.now() + pollMs * (MAX_POLL_FACTOR + 1);
    } else {
      // Nobody else waits: look again after the next run, not on every turn.
      line.handoffs = 0;
      line.heldSince = performance.now();
    }
  }
  if (handOff) {
    line.handoffs += 1;
  } else if (lease) {
    await releaseLineLease(lockPath, line, name, component);
  }
  const next = line.waiters.shift();
  if (next) next();
  else if (localLines.get(lockPath) === line) localLines.delete(lockPath);
}

/**
 * Run `fn` holding the lease at `lockPath`, in this process's line for it:
 * what `withFileLock` and `FilesystemLockManager.withLock` share.
 *
 * @param {string} lockPath
 * @param {(lease: Object) => Promise<T>} fn - Gets the line's lease; may set
 *   `lost` (do not hand it on, release through the claim) or `noHandOff`
 * @param {Object} opts
 * @param {string} opts.name - Lock name for messages and diagnostics
 * @param {string} opts.component
 * @param {number} opts.timeoutMs - Budget, local wait included
 * @param {number} opts.pollMs
 * @param {(waitMs: number, politeUntil: number) => Promise<Object>} opts.acquire -
 *   Publishes a lease and returns `{ owner, clock, stopRenewal, lost }`, plus
 *   optionally `onRelease`
 * @param {(lease: Object) => boolean} [opts.reusable] - Whether a lease handed
 *   on suits this caller; one that does not is released and acquired anew
 * @param {boolean} [opts.lined=true] - False keeps the caller out of the line:
 *   for a lease that is not renewed, or not often enough to stay young (more
 *   rarely than every half TTL). It may age out under its holder, and then
 *   any caller, of this process too, must be able to take it over, not wait
 *   behind it in memory.
 * @returns {Promise<T>}
 * @template T
 */
export async function withLeaseLine(
  lockPath,
  fn,
  { name, component, timeoutMs, pollMs, acquire, reusable = () => true, lined = true }
) {
  const diag = lockStats(lockPrefix(name, component));
  const startedAt = performance.now();
  const deadline = Date.now() + timeoutMs;

  let line = lined ? localLines.get(lockPath) : null;
  if (line) {
    diag.waiters += 1;
    try {
      await waitLocalTurn(line, deadline, timeoutMs, name);
    } catch (error) {
      diag.timeouts += 1;
      throw error;
    } finally {
      diag.waiters -= 1;
    }
  } else {
    line = { waiters: [], lease: null, handoffs: 0, heldSince: 0, politeUntil: 0 };
    if (lined) localLines.set(lockPath, line);
  }

  // This call holds the turn from here on and must pass it on, whatever happens.
  try {
    if (line.lease && !reusable(line.lease)) {
      await releaseLineLease(lockPath, line, name, component);
    }
    if (!line.lease) {
      const politeUntil = line.politeUntil;
      line.politeUntil = 0;
      line.lease = await acquire(Math.max(0, deadline - Date.now()), politeUntil);
      line.heldSince = performance.now();
    } else {
      diag.acquisitions += 1;
      diag.wait.record(performance.now() - startedAt);
    }
  } catch (error) {
    await passTurn(lockPath, line, name, component, pollMs);
    throw error;
  }

  const acquiredAt = performance.now();
  try {
    return await fn(line.lease);
  } finally {
    await passTurn(lockPath, line, name, component, pollMs);
    recordLockHold(lockPrefix(name, component), acquiredAt);
  }
}

/**
 * Run `fn` while holding the lock file at `lockPath`.
 *
 * Waits up to `timeoutMs` for a lock held elsewhere, then throws
 * {@link LockTimeoutError} (503) — `fn` **never** runs without the lock. A
 * lease nobody renewed for `staleMs` is presumed abandoned and taken over; a
 * live holder renews every `staleMs / 3`, so it is never preempted however long
 * `fn` takes. Release only removes a lease that is still this holder's.
 *
 * Callers in one process queue in memory first (see `localLines`): the next
 * local caller inherits a held, renewed lease without touching the file, so
 * the file is contended only between processes. A long run of local hand-offs
 * gives way to a waiting process (see `MAX_HANDOFFS`).
 *
 * Not reentrant: a nested call on the same path waits for its own caller's
 * lease and times out.
 *
 * @param {string} lockPath
 * @param {() => Promise<T>} fn
 * @param {Object} [opts]
 * @param {number} [opts.staleMs=15000] - Age at which an unrenewed lease is taken over
 * @param {number} [opts.timeoutMs=5000] - Acquisition budget, local wait included
 * @param {number} [opts.pollMs=20] - First pause between looks at a lease held
 *   by another process; doubles up to 8x
 * @param {number} [opts.renewMs] - Renewal interval; default `staleMs / 3`, 0
 *   disables (and so does one above `staleMs / 2`: the lease may age out, so a
 *   caller of this process must be able to take it over, not wait behind it)
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
  const name = path.basename(lockPath);
  const renew = renewMs ?? Math.max(1, Math.floor(staleMs / 3));
  return withLeaseLine(lockPath, () => fn(), {
    name,
    component,
    timeoutMs,
    pollMs,
    lined: renew > 0 && renew <= staleMs / 2,
    acquire: async (waitMs, politeUntil) => {
      const owner = crypto.randomUUID();
      const writtenAt = await acquireLease(lockPath, owner, {
        ttlMs: staleMs,
        waitMs,
        pollMs,
        name,
        component,
        politeUntil
      });
      const lease = {
        owner,
        stopRenewal: null,
        lost: false,
        clock: { writtenAt, ttlMs: staleMs }
      };
      if (renew > 0) {
        lease.stopRenewal = startLeaseRenewal(
          lockPath,
          owner,
          staleMs,
          renew,
          name,
          undefined,
          component,
          () => (lease.lost = true),
          lease.clock
        );
      }
      return lease;
    }
  });
}

export default {
  withFileLock,
  withLeaseLine,
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
