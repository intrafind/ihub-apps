/**
 * Per-account lockout for local sign-in (`platform.localAuth.lockout`).
 *
 * After `maxAttempts` failed sign-ins within `durationMinutes`, the account is
 * locked for `durationMinutes`: sign-ins are refused without checking the
 * password, and a successful sign-in clears the count.
 *
 * Counts are kept per account (the matched user id) or, when no account
 * matches, per name as typed, so a locked name behaves the same whether or not
 * an account exists. Counts live in memory. In cluster mode every failure and
 * every reset is passed to the other workers over the cluster bus, so the
 * limit holds for the whole server rather than per worker; a restart clears
 * them.
 *
 * @module utils/loginLockout
 */
import { publish, subscribe } from '../clusterBus.js';

/** Defaults for `platform.localAuth.lockout`. */
export const LOCKOUT_DEFAULTS = Object.freeze({
  enabled: true,
  maxAttempts: 5,
  durationMinutes: 15
});

/** Upper bound on tracked names, so failed sign-ins for random names cannot grow memory. */
const MAX_ENTRIES = 10000;

/** Cluster bus channels: a failure or a reset on another worker. */
const FAILURE_CHANNEL = 'loginLockout:failure';
const CLEAR_CHANNEL = 'loginLockout:clear';

/** key -> { failures, windowStart, lockedUntil } */
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
 * @param {string} typedName - Username or email as entered
 * @returns {string}
 */
export function lockoutKey(user, typedName) {
  return user ? `user:${user.id}` : `name:${String(typedName).toLowerCase()}`;
}

/**
 * Milliseconds until `key` may sign in again; 0 when it is not locked.
 *
 * @param {string} key
 * @param {number} [now=Date.now()]
 * @returns {number}
 */
export function lockedForMs(key, now = Date.now()) {
  const entry = entries.get(key);
  if (!entry?.lockedUntil) return 0;
  if (entry.lockedUntil > now) return entry.lockedUntil - now;
  entries.delete(key);
  return 0;
}

/**
 * Count a failed sign-in for `key`; locks it once the limit is reached.
 *
 * @param {string} key
 * @param {{maxAttempts: number, durationMs: number}} config - From `resolveLockoutConfig`
 * @param {number} [now=Date.now()]
 * @returns {boolean} Whether this failure locked the key
 */
export function recordFailedLogin(key, config, now = Date.now()) {
  const locked = countFailure(key, config, now);
  publish(FAILURE_CHANNEL, {
    key,
    now,
    maxAttempts: config.maxAttempts,
    durationMs: config.durationMs
  });
  return locked;
}

/**
 * Count one failure in this process.
 *
 * @param {string} key
 * @param {{maxAttempts: number, durationMs: number}} config
 * @param {number} now
 * @returns {boolean} Whether `key` is locked afterwards
 */
function countFailure(key, config, now) {
  let entry = entries.get(key);
  if (!entry || now - entry.windowStart > config.durationMs) {
    entry = { failures: 0, windowStart: now, lockedUntil: 0 };
  }
  entry.failures += 1;
  // Re-insert so the Map's order is least recently failed first.
  entries.delete(key);
  entries.set(key, entry);
  if (entry.failures >= config.maxAttempts) {
    entry.lockedUntil = now + config.durationMs;
    entry.failures = 0;
    entry.windowStart = now;
  }
  evictIfFull(now);
  return entry.lockedUntil > now;
}

/**
 * Forget the failures for `key` (after a successful sign-in or a password change).
 *
 * @param {string} key
 */
export function clearFailedLogins(key) {
  entries.delete(key);
  publish(CLEAR_CHANNEL, { key });
}

subscribe(FAILURE_CHANNEL, ({ key, now, maxAttempts, durationMs }) => {
  countFailure(key, { maxAttempts, durationMs }, now);
});
subscribe(CLEAR_CHANNEL, ({ key }) => {
  entries.delete(key);
});

/**
 * Keep the table bounded: drop entries that are not locked, then the least
 * recently failed.
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

/** Test helper: forget every count. */
export function resetLoginLockouts() {
  entries.clear();
}
