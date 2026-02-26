import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import { atomicWriteJSON } from './atomicWrite.js';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * File-backed refresh token store for OAuth 2.0 token rotation.
 *
 * Security design:
 * - Tokens are indexed by SHA-256 hash (fast O(1) lookup, no secret in index keys).
 * - The actual token value is stored as a bcrypt hash for defense-in-depth: even if
 *   the file is read by an attacker they cannot reconstruct the token.
 * - Each token is single-use (RFC 6749 section 10.4 token rotation). A second
 *   redemption attempt receives `invalid_grant`.
 * - Expired tokens are cleaned up lazily on every write to keep the file small.
 *
 * Persistence:
 * - Stored at `contents/config/oauth-refresh-tokens.json` so it survives server
 *   restarts (unlike in-memory auth code store). This file must be excluded from
 *   version control and treated as sensitive data.
 *
 * @module refreshTokenStore
 */

const STORE_PATH = path.join(__dirname, '../../contents/config/oauth-refresh-tokens.json');

/** Default refresh token lifetime in days. */
const TOKEN_TTL_DAYS = 30;

/**
 * Load the token store from disk.
 *
 * Returns an empty store structure on first call or if the file is missing /
 * corrupt. Errors are absorbed silently so the server does not crash on a
 * bad JSON file – the next write will overwrite the broken file.
 *
 * @returns {{ tokens: Object.<string, Object> }}
 */
function loadStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) {
      return { tokens: {} };
    }
    const data = fs.readFileSync(STORE_PATH, 'utf8');
    return JSON.parse(data);
  } catch {
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
    await atomicWriteJSON(STORE_PATH, store);
  } catch (error) {
    logger.error('[RefreshTokenStore] Failed to save:', error.message);
    throw error;
  }
}

/**
 * Compute a SHA-256 hex digest of a token value.
 *
 * Used as the map key so the plaintext token is never stored unprotected in the
 * store index.
 *
 * @param {string} token - Plaintext refresh token.
 * @returns {string} 64-char lowercase hex string.
 */
function sha256(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

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
 * The plaintext token is hashed with bcrypt before storage so that a file
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
  const store = loadStore();
  const tokenHash = sha256(token);
  const bcryptHash = await bcrypt.hash(token, 10);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();

  store.tokens[tokenHash] = {
    bcryptHash,
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
  logger.info(
    `[RefreshTokenStore] Stored refresh token | client=${data.clientId} | user=${data.userId}`
  );
}

/**
 * Verify and consume a refresh token (single-use rotation).
 *
 * Performs three security checks in order:
 * 1. Token exists in the store (unknown token → `invalid_grant`).
 * 2. Token has not passed its `expiresAt` timestamp.
 * 3. bcrypt verification confirms the plaintext token matches the stored hash.
 *
 * On success the token entry is deleted immediately so that a second call with
 * the same value returns null (replay protection). The caller is responsible for
 * issuing and storing a new refresh token before responding to the client.
 *
 * @param {string} token - Plaintext refresh token from the client request.
 * @returns {Promise<Object|null>} The stored context data if the token is valid,
 *   or null if the token is unknown, expired, or the bcrypt check fails.
 */
export async function consumeRefreshToken(token) {
  const store = loadStore();
  const tokenHash = sha256(token);
  const entry = store.tokens[tokenHash];

  if (!entry) {
    logger.warn('[RefreshTokenStore] Token not found');
    return null;
  }

  // Check expiry before bcrypt to short-circuit the (expensive) hash comparison.
  if (new Date(entry.expiresAt).getTime() < Date.now()) {
    logger.warn('[RefreshTokenStore] Token expired');
    delete store.tokens[tokenHash];
    await saveStore(store);
    return null;
  }

  // Verify the bcrypt hash – this is the authoritative check.
  const valid = await bcrypt.compare(token, entry.bcryptHash);
  if (!valid) {
    logger.warn('[RefreshTokenStore] Token hash mismatch');
    return null;
  }

  // Delete the entry (single-use rotation).
  delete store.tokens[tokenHash];
  await saveStore(store);

  // Strip the internal bcrypt hash before returning to callers.
  const { bcryptHash: _, ...data } = entry;
  return data;
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
  const store = loadStore();
  const tokenHash = sha256(token);

  if (!store.tokens[tokenHash]) {
    return false;
  }

  delete store.tokens[tokenHash];
  await saveStore(store);
  logger.info('[RefreshTokenStore] Token revoked');
  return true;
}
