/**
 * Per-account lockout for local sign-in (`platform.localAuth.lockout`).
 *
 * After `maxAttempts` failed sign-ins within `durationMinutes`, the account is
 * locked for `durationMinutes`: sign-ins are refused without checking the
 * password, and a successful sign-in clears the count.
 *
 * Every attempt reserves a slot before its password is checked and settles it
 * afterwards, as a failure or a success. Reserving is one synchronous step, so
 * attempts sent in parallel cannot all pass the check while the slow password
 * comparison runs: once failures plus attempts still in flight reach the
 * limit, further attempts are refused.
 *
 * Counts are kept per account (the matched user id) or, when no account
 * matches, per name as typed, so a locked name behaves the same whether or not
 * an account exists. They live in memory, in one table per server: in cluster
 * mode the primary process holds it and workers ask it over the cluster bus,
 * which keeps a reservation atomic across workers. If the primary does not
 * answer in time, a worker falls back to a table of its own. A restart clears
 * the counts.
 *
 * @module utils/loginLockout
 */
import cluster from 'node:cluster';
import { isClusterBusActive, request, respondInPrimary } from '../clusterBus.js';
import logger from './logger.js';

/** Defaults for `platform.localAuth.lockout`. */
export const LOCKOUT_DEFAULTS = Object.freeze({
  enabled: true,
  maxAttempts: 5,
  durationMinutes: 15
});

/** Upper bound on tracked names, so failed sign-ins for random names cannot grow memory. */
const MAX_ENTRIES = 10000;

/** A reservation nobody settled (the worker went away) stops counting after this. */
const RESERVATION_TTL_MS = 30 * 1000;

/** How long a worker waits for the primary before using its own table. */
const BUS_TIMEOUT_MS = 1000;

/** Cluster bus channels, answered by the primary. */
const RESERVE_CHANNEL = 'loginLockout:reserve';
const SETTLE_CHANNEL = 'loginLockout:settle';
const CLEAR_CHANNEL = 'loginLockout:clear';

/** key -> { failures, windowStart, lockedUntil, reservations: expiry times } */
const entries = new Map();

/** Raised by `loginUser` while an account is locked. */
export class LoginLockedError extends Error {
  /**
   * @param {number} retryAfterSeconds - Seconds until sign-in is possible again
   */
  constructor(retryAfterSeconds) {
    super('Too many failed sign-in attempts');
    this.name = 'LoginLockedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * The effective lockout settings: `localAuth.lockout` over the defaults.
 *
 * @param {object} [localAuthConfig] - `platform.localAuth`
 * @returns {{enabled: boolean, maxAttempts: number, durationMs: number}}
 */
export function resolveLockoutConfig(localAuthConfig = {}) {
  const configured = localAuthConfig?.lockout || {};
  const positive = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback);
  return {
    enabled: configured.enabled !== false,
    maxAttempts: positive(configured.maxAttempts, LOCKOUT_DEFAULTS.maxAttempts),
    durationMs: positive(configured.durationMinutes, LOCKOUT_DEFAULTS.durationMinutes) * 60 * 1000
  };
}

/**
 * The key a sign-in attempt is counted under.
 *
 * @param {{id: string}|undefined} user - The matched account, if any
 * @param {string} [typedName] - Username or email as entered
 * @returns {string}
 */
export function lockoutKey(user, typedName) {
  return user ? `user:${user.id}` : `name:${String(typedName).toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// The table. Each operation is synchronous, so it is atomic in the process
// that holds the table.
// ---------------------------------------------------------------------------

/**
 * The live entry for `key`, with expired locks, windows and reservations dropped.
 *
 * @param {string} key
 * @param {{durationMs: number}} config
 * @param {number} now
 * @returns {object} The entry (created when missing)
 */
function liveEntry(key, config, now) {
  let entry = entries.get(key);
  if (!entry) {
    entry = { failures: 0, windowStart: now, lockedUntil: 0, reservations: [] };
  }
  entry.reservations = entry.reservations.filter(expiresAt => expiresAt > now);
  if (entry.lockedUntil && entry.lockedUntil <= now) {
    entry.lockedUntil = 0;
    entry.failures = 0;
    entry.windowStart = now;
  }
  if (!entry.lockedUntil && now - entry.windowStart > config.durationMs) {
    entry.failures = 0;
    entry.windowStart = now;
  }
  // Re-insert so the Map's order is least recently used first.
  entries.delete(key);
  entries.set(key, entry);
  return entry;
}

/**
 * Reserve an attempt for `key`.
 *
 * @param {string} key
 * @param {{maxAttempts: number, durationMs: number}} config
 * @param {number} now
 * @returns {number} 0 when reserved; otherwise milliseconds to wait
 */
function reserveInTable(key, config, now) {
  const entry = liveEntry(key, config, now);
  if (entry.lockedUntil > now) return entry.lockedUntil - now;
  // Every attempt still allowed is already in flight; one of them may lock the key.
  if (entry.failures + entry.reservations.length >= config.maxAttempts) return config.durationMs;
  entry.reservations.push(now + RESERVATION_TTL_MS);
  evictIfFull(now);
  return 0;
}

/**
 * Settle one reservation for `key` as a failure or a success.
 *
 * @param {string} key
 * @param {{maxAttempts: number, durationMs: number}} config
 * @param {boolean} succeeded
 * @param {number} now
 */
function settleInTable(key, config, succeeded, now) {
  const entry = liveEntry(key, config, now);
  entry.reservations.shift();
  if (succeeded) {
    // Whoever sent this attempt knows the password; start counting afresh.
    // Reservations of other attempts still in flight stay.
    entry.failures = 0;
    entry.windowStart = now;
  } else if (!entry.lockedUntil) {
    entry.failures += 1;
    if (entry.failures >= config.maxAttempts) {
      entry.lockedUntil = now + config.durationMs;
      entry.failures = 0;
      entry.windowStart = now;
    }
  }
  if (!entry.failures && !entry.lockedUntil && entry.reservations.length === 0) {
    entries.delete(key);
  }
}

/**
 * Keep the table bounded: drop entries that are not locked, then the least
 * recently used.
 *
 * @param {number} now
 */
function evictIfFull(now) {
  if (entries.size <= MAX_ENTRIES) return;
  for (const [key, entry] of entries) {
    if (entry.lockedUntil <= now) entries.delete(key);
    if (entries.size <= MAX_ENTRIES) return;
  }
  for (const key of entries.keys()) {
    entries.delete(key);
    if (entries.size <= MAX_ENTRIES) return;
  }
}

// ---------------------------------------------------------------------------
// The API, which reaches the server's table wherever it lives.
// ---------------------------------------------------------------------------

/**
 * Ask the primary, which holds the table in cluster mode.
 *
 * @param {string} channel
 * @param {object} payload
 * @returns {Promise<object|null>} The reply, or null when there is no cluster
 *   or the primary did not answer in time
 */
async function askPrimary(channel, payload) {
  if (cluster.isPrimary || !isClusterBusActive()) return null;
  const reply = await request(channel, payload, { timeoutMs: BUS_TIMEOUT_MS });
  if (reply === null) {
    logger.warn('Login lockout: no answer from the primary process; using this worker only', {
      component: 'LoginLockout',
      channel
    });
  }
  return reply;
}

/**
 * Reserve a sign-in attempt for `key` before its password is checked.
 *
 * @param {string} key - From `lockoutKey`
 * @param {{maxAttempts: number, durationMs: number}} config - From `resolveLockoutConfig`
 * @param {number} [now=Date.now()] - Only used by this process's own table
 * @returns {Promise<{waitMs: number, shared: boolean}>} `waitMs` is 0 when the
 *   attempt may go ahead; `shared` says which table holds the reservation, to
 *   pass back to `settleLoginAttempt`.
 */
export async function reserveLoginAttempt(key, config, now = Date.now()) {
  const { maxAttempts, durationMs } = config;
  const reply = await askPrimary(RESERVE_CHANNEL, { key, maxAttempts, durationMs });
  if (reply && Number.isFinite(reply.waitMs)) return { waitMs: reply.waitMs, shared: true };
  return { waitMs: reserveInTable(key, config, now), shared: false };
}

/**
 * Settle a reservation once the password was checked.
 *
 * @param {string} key
 * @param {{maxAttempts: number, durationMs: number}} config
 * @param {boolean} succeeded - Whether the password was right
 * @param {boolean} shared - `shared` from `reserveLoginAttempt`
 * @param {number} [now=Date.now()]
 */
export async function settleLoginAttempt(key, config, succeeded, shared, now = Date.now()) {
  if (shared) {
    const { maxAttempts, durationMs } = config;
    await askPrimary(SETTLE_CHANNEL, { key, maxAttempts, durationMs, succeeded });
    return;
  }
  settleInTable(key, config, succeeded, now);
}

/**
 * Forget the failures for `key`, e.g. after an admin set a new password.
 *
 * @param {string} key
 */
export async function clearFailedLogins(key) {
  entries.delete(key);
  await askPrimary(CLEAR_CHANNEL, { key });
}

if (cluster.isPrimary) {
  respondInPrimary(RESERVE_CHANNEL, ({ key, maxAttempts, durationMs }) => ({
    waitMs: reserveInTable(key, { maxAttempts, durationMs }, Date.now())
  }));
  respondInPrimary(SETTLE_CHANNEL, ({ key, maxAttempts, durationMs, succeeded }) => {
    settleInTable(key, { maxAttempts, durationMs }, succeeded === true, Date.now());
    return { settled: true };
  });
  respondInPrimary(CLEAR_CHANNEL, ({ key }) => {
    entries.delete(key);
    return { cleared: true };
  });
}

/** Test helper: forget every count. */
export function resetLoginLockouts() {
  entries.clear();
}
