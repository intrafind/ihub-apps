/**
 * Cross-process scheduler lock for workflow schedule triggers.
 *
 * Problem: every iHub instance (multiple workers, multiple replicas, or a
 * stray dev server) registers the same cron schedules from the workflow JSON
 * files. Without coordination, a workflow scheduled for "every morning" would
 * fire once per running instance. This lock ensures **only one instance** —
 * the lock owner — actually fires scheduled triggers. Manual and webhook
 * triggers are unaffected (they are user/HTTP-initiated, not duplicated).
 *
 * Modeled on Claude Code's `cronScheduler.ts` lock: a single lock file with a
 * TTL and PID-liveness check. If the owner dies, another instance takes over
 * after the TTL lapses (or immediately if the owning PID is gone on the same
 * host). The owner refreshes the lock on a heartbeat.
 *
 * @module services/workflow/triggers/schedulerLock
 */

import { existsSync, readFileSync, rmSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { getRootDir } from '../../../pathUtils.js';
import config from '../../../config.js';
import logger from '../../../utils/logger.js';

const LOCK_TTL_MS = 30_000;
const HEARTBEAT_MS = 10_000;

const IDENTITY = randomUUID();
const HOSTNAME = os.hostname();

let heartbeatTimer = null;
let owner = false;

function defaultLockPath() {
  return path.join(getRootDir(), config.CONTENTS_DIR, 'data', 'agent-scheduler.lock');
}

function isProcessAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it — still alive.
    return err.code === 'EPERM';
  }
}

function readLock(lockPath) {
  try {
    if (!existsSync(lockPath)) return null;
    return JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return null; // unreadable / corrupt → treat as no lock
  }
}

/**
 * Attempt to acquire (or refresh) the scheduler lock. Returns true if this
 * process owns the lock after the call.
 *
 * @param {Object} [opts]
 * @param {string} [opts.lockPath] - Override the lock file path (tests)
 * @param {number} [opts.now] - Override current time in ms (tests)
 * @returns {boolean} whether this process owns the lock
 */
export function tryAcquireSchedulerLock(opts = {}) {
  const lockPath = opts.lockPath || defaultLockPath();
  const now = opts.now ?? Date.now();
  const current = readLock(lockPath);

  const canTake =
    !current ||
    current.identity === IDENTITY ||
    now - (current.lockTime || 0) > LOCK_TTL_MS ||
    (current.hostname === HOSTNAME && !isProcessAlive(current.pid));

  if (!canTake) {
    owner = false;
    return false;
  }

  try {
    const payload = JSON.stringify({
      identity: IDENTITY,
      pid: process.pid,
      hostname: HOSTNAME,
      lockTime: now
    });
    mkdirSync(path.dirname(lockPath), { recursive: true });

    if (!current) {
      // FRESH acquisition (no lock file yet). Use an exclusive create
      // (O_CREAT|O_EXCL) so that among processes booting simultaneously with no
      // pre-existing lock, exactly ONE wins. A temp-write + rename would let
      // every racer's rename succeed and every racer set owner=true — multiple
      // owners, which then fire every scheduled trigger N times (the exact
      // duplication this lock exists to prevent).
      try {
        writeFileSync(lockPath, payload, { encoding: 'utf8', flag: 'wx' });
        owner = true;
        return true;
      } catch (err) {
        if (err.code === 'EEXIST') {
          // Another process created the lock between our read and our write —
          // we lost the race and are not the owner. A later heartbeat re-runs
          // this (and the TTL / dead-PID paths take over if that owner dies).
          owner = false;
          return false;
        }
        throw err;
      }
    }

    // Refresh our own lock, or take over a stale / dead-owner lock. We are
    // entitled to replace the existing file, so an atomic temp-write + rename
    // (overwrite) is correct here. Clean up the temp file if the rename fails
    // so a transient FS error doesn't leave a stray PID-keyed temp behind.
    const tmp = `${lockPath}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, payload, 'utf8');
      renameSync(tmp, lockPath);
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      throw err;
    }
    owner = true;
    return true;
  } catch (err) {
    logger.warn({
      component: 'schedulerLock',
      message: `Failed to write scheduler lock: ${err.message}`
    });
    owner = false;
    return false;
  }
}

/**
 * Whether this process currently believes it owns the scheduler lock.
 * @returns {boolean}
 */
export function isSchedulerOwner() {
  return owner;
}

/**
 * Release the lock if we own it (best-effort).
 * @param {Object} [opts]
 * @param {string} [opts.lockPath]
 */
export function releaseSchedulerLock(opts = {}) {
  const lockPath = opts.lockPath || defaultLockPath();
  const current = readLock(lockPath);
  if (current && current.identity === IDENTITY) {
    try {
      rmSync(lockPath, { force: true });
    } catch {
      /* ignore */
    }
  }
  owner = false;
}

/**
 * Start the lock heartbeat: acquire immediately, then re-acquire/refresh on an
 * interval so ownership transfers if the current owner dies. Idempotent.
 *
 * @param {Object} [opts]
 * @param {number} [opts.intervalMs]
 */
export function startSchedulerLockHeartbeat(opts = {}) {
  tryAcquireSchedulerLock();
  if (heartbeatTimer) return;
  const intervalMs = opts.intervalMs || HEARTBEAT_MS;
  heartbeatTimer = setInterval(() => {
    try {
      tryAcquireSchedulerLock();
    } catch (err) {
      logger.debug({
        component: 'schedulerLock',
        message: `Heartbeat acquire failed: ${err.message}`
      });
    }
  }, intervalMs);
  heartbeatTimer.unref?.();
}

/**
 * Stop the heartbeat and release the lock. Call on shutdown.
 */
export function stopSchedulerLockHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  releaseSchedulerLock();
}

/** Test-only reset of in-memory ownership state. */
export function _resetForTest() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  owner = false;
}

/** Test-only accessor for this process's lock identity. */
export function _identity() {
  return IDENTITY;
}
