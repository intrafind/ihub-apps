// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import bcrypt from 'bcryptjs';
import { atomicWriteJSON } from './atomicWrite.js';
import { withFileLock } from './fileLock.js';
import logger from './logger.js';
import { getContentsPath } from './contentsPath.js';

/**
 * File-backed refresh token store for OAuth 2.0 token rotation.
 *
 * Security design:
 * - Tokens are indexed by SHA-256 hash (fast O(1) lookup, no secret in index keys).
 * - The token value is stored only as its SHA-256 (`sha256`), checked with a
 *   constant-time compare. Tokens are 256 random bits, so a fast hash is enough
 *   to keep a leaked file from yielding usable tokens; bcrypt cost ~100 ms of
 *   event-loop CPU per refresh for no added protection. Entries written before
 *   carry `bcryptHash` and are still verified with bcryptjs; they disappear as
 *   they rotate (the new token is stored as SHA-256) or expire.
 * - Each token is single-use (RFC 6749 section 10.4 token rotation). A second
 *   redemption attempt receives `invalid_grant`.
 * - Expired tokens are cleaned up lazily on every write to keep the file small.
 *
 * Persistence:
 * - Stored at `contents/data/oauth-refresh-tokens.json` so it survives server
 *   restarts (unlike in-memory auth code store). This file must be excluded from
 *   version control and treated as sensitive data.
 *
 * @module refreshTokenStore
 */

const STORE_PATH = getContentsPath('data', 'oauth-refresh-tokens.json');

/**
 * Every change is a read-modify-write of the whole file, and cluster workers
 * make them concurrently: without a lock two rotations overwrote each other —
 * a freshly issued token vanished (the client's next refresh failed with
 * `invalid_grant`) or a consumed one came back — and two workers could both
 * redeem the same token. Changes run under this lock file, on a fresh read;
 * hash work stays outside it.
 */
const LOCK_PATH = `${STORE_PATH}.lock`;

async function withStoreLock(fn) {
  await fs.promises.mkdir(path.dirname(STORE_PATH), { recursive: true });
  return withFileLock(LOCK_PATH, fn, { component: 'RefreshTokenStore' });
}

/** Default refresh token lifetime in days. */
const TOKEN_TTL_DAYS = 30;

/**
 * Load the token store from disk.
 *
 * Returns an empty store structure on first call or if the file is missing /
 * corrupt. Errors are absorbed silently so the server does not crash on a
 * bad JSON file – the next write will overwrite the broken file.
 *
 * @returns {Promise<{ tokens: Object.<string, Object> }>}
 */
async function loadStore() {
  let raw;
  try {
    raw = await fs.promises.readFile(STORE_PATH, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { tokens: {} };
    // Unreadable (EIO, EACCES, ...) is not empty: the caller's next write would
    // replace a store that is still there with one holding a single token.
    logger.error('Refresh token store could not be read', {
      component: 'RefreshTokenStore',
      error: error.message
    });
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    // Malformed: keep the bytes aside before the next write replaces them, so
    // a bad write or a hand edit can be recovered rather than silently lost.
    const backup = `${STORE_PATH}.corrupt-${Date.now()}`;
    try {
      await fs.promises.writeFile(backup, raw, { mode: 0o600 });
    } catch {
      /* best effort */
    }
    logger.error('Refresh token store is malformed; starting empty', {
      component: 'RefreshTokenStore',
      backup,
      error: error.message
    });
    return { tokens: {} };
  }
}

/**
 * Persist the token store to disk atomically.
 *
 * Uses `atomicWriteJSON` (write-to-temp then rename) to prevent partial writes
 * from corrupting the store if the server crashes mid-write.
 *
 * @param {{ tokens: Object.<string, Object> }} store - Store object to persist.
 * @returns {Promise<void>}
 */
async function saveStore(store) {
  try {
    await fs.promises.mkdir(path.dirname(STORE_PATH), { recursive: true });
    await atomicWriteJSON(STORE_PATH, store, { mode: 0o600 });
  } catch (error) {
    logger.error('Failed to save refresh token store', { component: 'RefreshTokenStore', error });
    throw error;
  }
}

/**
 * Compute a SHA-256 index key for a plaintext refresh token.
 * Used only as a store lookup key — NOT as a password hash.
 *
 * @param {string} token - Plaintext refresh token.
 * @returns {string} 64-char lowercase hex string.
 */
function tokenIndexKey(token) {
  return crypto.createHash('sha256').update(token).digest('hex'); // lgtm[js/insufficient-password-hash] -- index key, not a stored password
}

/**
 * The stored verifier for a new token: its SHA-256 hex. Equal to the index
 * key; kept as its own field so verification does not depend on how the map
 * is keyed.
 *
 * @param {string} token - Plaintext refresh token.
 * @returns {{ sha256: string }}
 */
function tokenVerifier(token) {
  return { sha256: tokenIndexKey(token) }; // lgtm[js/insufficient-password-hash] -- 256-bit random token, not a password
}

/**
 * Whether a plaintext token matches a stored entry: constant-time SHA-256
 * compare, or bcryptjs for an entry stored before the switch.
 *
 * @param {string} token - Plaintext refresh token.
 * @param {Object} entry - Stored entry.
 * @returns {Promise<boolean>}
 */
async function verifyToken(token, entry) {
  if (typeof entry.sha256 === 'string') {
    const expected = Buffer.from(entry.sha256, 'hex');
    const actual = crypto.createHash('sha256').update(token).digest();
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }
  if (typeof entry.bcryptHash === 'string') return bcrypt.compare(token, entry.bcryptHash);
  return false;
}

/** Identity of an entry's verifier, to tell whether it was replaced meanwhile. */
const verifierOf = entry => entry?.sha256 ?? entry?.bcryptHash;

/**
 * Generate a cryptographically random refresh token.
 *
 * Returns a 64-character hex string (256 bits of entropy), which is well above
 * the RFC 6749 recommendation for refresh tokens.
 *
 * @returns {string} 64-char lowercase hex string.
 *
 * @example
 * const token = generateRefreshToken();
 * // token === 'a3f9e...' (64 hex chars)
 */
export function generateRefreshToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Persist a new refresh token with its associated user and client context.
 *
 * The plaintext token is hashed with SHA-256 before storage so that a file
 * compromise does not expose usable tokens. The SHA-256 of the token is used
 * as the map key for O(1) lookup.
 *
 * Expired tokens are pruned from the store on every write to prevent unbounded
 * file growth.
 *
 * @param {string} token - Plaintext refresh token (result of `generateRefreshToken()`).
 * @param {Object} data - Context bound to this token.
 * @param {string} data.clientId - OAuth client that issued this token.
 * @param {string} data.userId - Subject user identifier.
 * @param {string} [data.userEmail] - User email address (optional, for userinfo).
 * @param {string} [data.userName] - Display name (optional, for userinfo).
 * @param {string[]} [data.userGroups] - Group memberships to carry into the refreshed token.
 * @param {string[]} [data.scopes] - Granted scopes.
 * @param {number} [ttlDays=30] - Token lifetime in days.
 * @returns {Promise<void>}
 */
export async function storeRefreshToken(token, data, ttlDays = TOKEN_TTL_DAYS) {
  const tokenHash = tokenIndexKey(token);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();

  await withStoreLock(async () => {
    const store = await loadStore();
    store.tokens[tokenHash] = {
      ...tokenVerifier(token),
      expiresAt,
      ...data,
      createdAt: new Date().toISOString()
    };

    // Lazy cleanup: remove expired entries while the store is open to prevent
    // unbounded file growth on high-volume deployments.
    const now = Date.now();
    for (const [key, entry] of Object.entries(store.tokens)) {
      if (new Date(entry.expiresAt).getTime() < now) {
        delete store.tokens[key];
      }
    }

    await saveStore(store);
  });
  logger.info('Refresh token stored', {
    component: 'RefreshTokenStore',
    clientId: data.clientId,
    userId: data.userId
  });
}

/**
 * Verify and consume a refresh token (single-use rotation).
 *
 * Performs three security checks in order:
 * 1. Token exists in the store (unknown token → `invalid_grant`).
 * 2. Token has not passed its `expiresAt` timestamp.
 * 3. The plaintext token matches the stored hash (SHA-256, or bcrypt for old entries).
 *
 * On success the token entry is deleted immediately so that a second call with
 * the same value returns null (replay protection). The caller is responsible for
 * issuing and storing a new refresh token before responding to the client.
 *
 * @param {string} token - Plaintext refresh token from the client request.
 * @returns {Promise<Object|null>} The stored context data if the token is valid,
 *   or null if the token is unknown, expired, or the hash check fails.
 */
export async function consumeRefreshToken(token) {
  const result = await redeem(token, false);
  return result ? result.data : null;
}

/**
 * How long a rotation in progress holds its token. The rotation path does user
 * and client lookups, signs a JWT and hashes the new token between redeeming
 * the old token and storing the new one; this is the budget for that. A
 * rotation that is neither completed nor aborted within it (a crash, a hung
 * lookup) is treated as abandoned and the old token becomes redeemable again,
 * so a crash in the gap no longer loses the grant.
 */
const ROTATION_LEASE_MS = 2 * 60 * 1000;

const rotationLive = entry =>
  Boolean(entry?.rotation) && Date.now() - Number(entry.rotation.startedAt) < ROTATION_LEASE_MS;

/**
 * Verify a token and either delete it (`keep` false) or mark it as being
 * rotated (`keep` true). The marked entry stays in the store with its client and
 * user, so a revoke of that connection, user or client finds and deletes it
 * while the rotation is still in flight.
 *
 * @returns {Promise<{data: Object, rotationId: string|null}|null>}
 */
async function redeem(token, keep) {
  const store = await loadStore();
  const tokenHash = tokenIndexKey(token);
  const entry = store.tokens[tokenHash];

  if (!entry) {
    logger.warn('Token not found', { component: 'RefreshTokenStore' });
    return null;
  }

  // Being rotated right now: it was already redeemed.
  if (rotationLive(entry)) {
    logger.warn('Token already redeemed', { component: 'RefreshTokenStore' });
    return null;
  }

  // Check expiry before the hash comparison (bcrypt for old entries is expensive).
  if (new Date(entry.expiresAt).getTime() < Date.now()) {
    logger.warn('Token expired', { component: 'RefreshTokenStore' });
    await withStoreLock(async () => {
      const current = await loadStore();
      if (!current.tokens[tokenHash]) return;
      delete current.tokens[tokenHash];
      await saveStore(current);
    });
    return null;
  }

  // Verify the stored hash – this is the authoritative check.
  const valid = await verifyToken(token, entry);
  if (!valid) {
    logger.warn('Token hash mismatch', { component: 'RefreshTokenStore' });
    return null;
  }

  // Delete or mark the entry (single-use rotation). Under the lock and only if
  // it is still the entry just verified and not being rotated: of two concurrent
  // redemptions, on this worker or another, exactly one finds it.
  const rotationId = keep ? crypto.randomUUID() : null;
  const consumed = await withStoreLock(async () => {
    const current = await loadStore();
    const now = current.tokens[tokenHash];
    if (verifierOf(now) !== verifierOf(entry) || rotationLive(now)) return false;
    if (keep) now.rotation = { id: rotationId, startedAt: Date.now() };
    else delete current.tokens[tokenHash];
    await saveStore(current);
    return true;
  });
  if (!consumed) {
    logger.warn('Token already redeemed', { component: 'RefreshTokenStore' });
    return null;
  }

  // Strip the internal fields before returning to callers.
  const { sha256: _, bcryptHash: __, rotation: ___, ...data } = entry;
  return { data, rotationId };
}

/**
 * Redeem a refresh token for rotation, keeping its entry as a placeholder until
 * the rotation is finished with {@link completeRefreshRotation} or
 * {@link abortRefreshRotation}.
 *
 * Between redeeming the old token and storing the new one the caller does work
 * that takes time, and a revoke arriving then (disconnect, user deletion,
 * client revoke) used to find nothing to delete — the rotation then stored a
 * fresh token and undid the revoke. With the placeholder the revoke deletes it,
 * and `completeRefreshRotation` sees that and stores nothing.
 *
 * @param {string} token - Plaintext refresh token from the client request.
 * @returns {Promise<{data: Object, rotationId: string}|null>} The token's context,
 *   or null when unknown, expired, invalid or already redeemed.
 */
export async function beginRefreshRotation(token) {
  return redeem(token, true);
}

/**
 * Finish a rotation: replace the placeholder with the new token, in one locked
 * step. Stores nothing and returns false when the placeholder is gone (the
 * grant was revoked meanwhile).
 *
 * @param {string} oldToken - The token passed to {@link beginRefreshRotation}.
 * @param {string} rotationId - Its `rotationId`.
 * @param {string} newToken - Plaintext new refresh token.
 * @param {Object} data - Context for the new token (as for {@link storeRefreshToken}).
 * @param {number} [ttlDays=30]
 * @returns {Promise<boolean>} True when the new token was stored.
 */
export async function completeRefreshRotation(
  oldToken,
  rotationId,
  newToken,
  data,
  ttlDays = TOKEN_TTL_DAYS
) {
  const oldHash = tokenIndexKey(oldToken);
  const newHash = tokenIndexKey(newToken);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();

  const stored = await withStoreLock(async () => {
    const store = await loadStore();
    if (store.tokens[oldHash]?.rotation?.id !== rotationId) return false;
    delete store.tokens[oldHash];
    store.tokens[newHash] = {
      ...tokenVerifier(newToken),
      expiresAt,
      ...data,
      createdAt: new Date().toISOString()
    };
    const now = Date.now();
    for (const [key, entry] of Object.entries(store.tokens)) {
      if (new Date(entry.expiresAt).getTime() < now) delete store.tokens[key];
    }
    await saveStore(store);
    return true;
  });
  if (stored) {
    logger.info('Refresh token stored', {
      component: 'RefreshTokenStore',
      clientId: data.clientId,
      userId: data.userId
    });
  } else {
    logger.info('Refresh token rotation dropped: the grant was revoked meanwhile', {
      component: 'RefreshTokenStore',
      clientId: data.clientId,
      userId: data.userId
    });
  }
  return stored;
}

/**
 * End a rotation without a new token. By default the old token is deleted (the
 * grant ends, as when a rotation used to be refused after the token was
 * consumed); with `restore` it becomes redeemable again, for a refusal that
 * says nothing about the grant (the user store could not be read).
 *
 * @param {string} oldToken
 * @param {string} rotationId
 * @param {{restore?: boolean}} [options]
 * @returns {Promise<void>}
 */
export async function abortRefreshRotation(oldToken, rotationId, { restore = false } = {}) {
  const oldHash = tokenIndexKey(oldToken);
  await withStoreLock(async () => {
    const store = await loadStore();
    const entry = store.tokens[oldHash];
    if (entry?.rotation?.id !== rotationId) return;
    if (restore) delete entry.rotation;
    else delete store.tokens[oldHash];
    await saveStore(store);
  });
}

/**
 * Revoke a refresh token by its plaintext value.
 *
 * Implements RFC 7009 semantics: silently succeeds if the token is not found
 * (the token is already gone, so the outcome is the same).
 *
 * @param {string} token - Plaintext refresh token to revoke.
 * @returns {Promise<boolean>} True if the token was found and deleted, false if
 *   the token was not present in the store.
 */
export async function revokeRefreshToken(token) {
  const tokenHash = tokenIndexKey(token);
  if (!(await loadStore()).tokens[tokenHash]) {
    return false;
  }

  const revoked = await withStoreLock(async () => {
    const store = await loadStore();
    if (!store.tokens[tokenHash]) return false;
    delete store.tokens[tokenHash];
    await saveStore(store);
    return true;
  });
  if (revoked) logger.info('Token revoked', { component: 'RefreshTokenStore' });
  return revoked;
}

/**
 * Revoke every refresh token issued to one client for one user.
 *
 * This is the other half of disconnecting a connection: deleting the consent
 * entry alone only means the next authorization shows the consent screen
 * again, while the client's existing refresh token would keep minting access
 * tokens for another 30 days. Outstanding *access* tokens are stateless and
 * live out their (much shorter) lifetime — which is why the UI says so.
 *
 * The store is scanned rather than indexed: it holds one entry per live
 * connection, and a second index keyed by `clientId:userId` would be one more
 * thing to keep consistent with the rotation path.
 *
 * @param {string} clientId - OAuth client identifier.
 * @param {string} userId - User subject identifier.
 * @returns {Promise<number>} How many tokens were revoked.
 */
export async function revokeRefreshTokensFor(clientId, userId) {
  if (!clientId || !userId) return 0;

  const doomedIn = store =>
    Object.entries(store.tokens || {})
      .filter(([, entry]) => entry?.clientId === clientId && entry?.userId === userId)
      .map(([key]) => key);

  if (doomedIn(await loadStore()).length === 0) return 0;

  const doomed = await withStoreLock(async () => {
    const store = await loadStore();
    const keys = doomedIn(store);
    if (keys.length === 0) return keys;
    for (const key of keys) {
      delete store.tokens[key];
    }
    await saveStore(store);
    return keys;
  });
  if (doomed.length === 0) return 0;

  logger.info('Refresh tokens revoked for connection', {
    component: 'RefreshTokenStore',
    clientId,
    userId,
    count: doomed.length
  });
  return doomed.length;
}

/**
 * Revoke every refresh token a user holds, for every client.
 *
 * What deleting a user needs: their connections end with them, so no client may
 * keep minting access tokens on their behalf. Scanned rather than indexed, like
 * {@link revokeRefreshTokensFor}.
 *
 * @param {string} userId - User subject identifier.
 * @returns {Promise<number>} How many tokens were revoked.
 */
export async function revokeRefreshTokensForUser(userId) {
  if (!userId) return 0;

  const doomedIn = store =>
    Object.entries(store.tokens || {})
      .filter(([, entry]) => entry?.userId === userId)
      .map(([key]) => key);

  if (doomedIn(await loadStore()).length === 0) return 0;

  const doomed = await withStoreLock(async () => {
    const store = await loadStore();
    const keys = doomedIn(store);
    if (keys.length > 0) {
      for (const key of keys) {
        delete store.tokens[key];
      }
      await saveStore(store);
    }
    return keys;
  });

  if (doomed.length > 0) {
    logger.info('Refresh tokens revoked for user', {
      component: 'RefreshTokenStore',
      userId,
      count: doomed.length
    });
  }
  return doomed.length;
}

/**
 * Every user who still holds a live refresh token for one client.
 *
 * Revoking a whole client cannot be driven from the consent store alone: a
 * grant whose consent entry has expired (or was deleted) can still have a live
 * refresh token behind it, and that token is what keeps minting access tokens.
 * This is how the bulk revoke finds those users too.
 *
 * @param {string} clientId - OAuth client identifier.
 * @returns {Promise<Array<string>>} Distinct user IDs, in no particular order.
 */
export async function listRefreshTokenUserIds(clientId) {
  if (!clientId) return [];

  const store = await loadStore();
  const userIds = new Set();
  for (const entry of Object.values(store.tokens || {})) {
    if (entry?.clientId === clientId && entry.userId) userIds.add(entry.userId);
  }
  return [...userIds];
}
