import crypto from 'crypto';
import logger from './logger.js';

/**
 * In-memory store for OAuth authorization codes.
 *
 * Authorization codes are short-lived (10 minutes) and single-use by
 * design (RFC 6749 section 4.1.2). Consuming a code removes it from the
 * store immediately, so a second use attempt always returns null.
 *
 * The store uses a plain Map – no persistence across restarts. That is
 * intentional: a restarted server is a clean slate, and codes issued
 * before the restart simply expire as if they were never issued.
 *
 * @module authorizationCodeStore
 */

/** @type {Map<string, { data: Object, expiresAt: number, used: boolean }>} */
const codeStore = new Map();

/** Authorization codes expire after 10 minutes (RFC 6749 recommendation). */
const CODE_TTL_MS = 10 * 60 * 1000;

/** Periodic cleanup runs every 5 minutes to remove stale entries. */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Store an authorization code with its associated request data.
 *
 * The data object should contain everything needed to validate a subsequent
 * token request: clientId, redirectUri, userId, scopes, codeChallenge,
 * codeChallengeMethod, and nonce.
 *
 * @param {string} code - The authorization code (random hex string).
 * @param {Object} data - Payload bound to this code.
 * @param {string} data.clientId - OAuth client that requested the code.
 * @param {string} data.redirectUri - Redirect URI from the authorization request.
 * @param {string} data.userId - Authenticated user identifier.
 * @param {string[]} data.scopes - Granted scopes.
 * @param {string} [data.codeChallenge] - PKCE code challenge (S256).
 * @param {string} [data.codeChallengeMethod] - PKCE method, must be 'S256'.
 * @param {string} [data.nonce] - Nonce for ID token binding.
 * @returns {void}
 */
export function storeCode(code, data) {
  codeStore.set(code, {
    data,
    expiresAt: Date.now() + CODE_TTL_MS,
    used: false
  });
}

/**
 * Retrieve and consume an authorization code (single-use).
 *
 * On success the entry is deleted from the store immediately so that
 * any second call with the same code returns null (replay protection).
 * A detected replay (code exists but is already marked used) also
 * deletes the entry and logs a warning.
 *
 * @param {string} code - The authorization code to consume.
 * @returns {Object|null} The data payload that was stored with the code,
 *   or null if the code is unknown, already used, or expired.
 */
export function consumeCode(code) {
  const entry = codeStore.get(code);

  if (!entry) {
    logger.warn('[AuthCodeStore] Code not found');
    return null;
  }

  if (entry.used) {
    logger.warn('[AuthCodeStore] Code already used - possible replay attack');
    codeStore.delete(code);
    return null;
  }

  if (Date.now() > entry.expiresAt) {
    logger.warn('[AuthCodeStore] Code expired');
    codeStore.delete(code);
    return null;
  }

  codeStore.delete(code);
  return entry.data;
}

/**
 * Generate a cryptographically random authorization code.
 *
 * Returns a 64-character lowercase hex string (256 bits of entropy),
 * which satisfies the RFC 6749 requirement for unpredictable codes.
 *
 * @returns {string} 32-byte random value encoded as hex.
 */
export function generateCode() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Remove all expired entries from the in-memory store.
 *
 * Called automatically by the cleanup interval. Exposed here only to
 * make it easy to trigger from tests without waiting for the timer.
 *
 * @returns {void}
 */
export function cleanup() {
  const now = Date.now();
  for (const [code, entry] of codeStore.entries()) {
    if (now > entry.expiresAt) {
      codeStore.delete(code);
    }
  }
}

// Periodic cleanup – runs in the background and does not prevent the
// Node.js process from exiting (unref) so tests finish cleanly.
const cleanupInterval = setInterval(cleanup, CLEANUP_INTERVAL_MS);

if (cleanupInterval.unref) {
  cleanupInterval.unref();
}
