import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { atomicWriteJSON } from './atomicWrite.js';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STORE_PATH = path.join(__dirname, '../../contents/config/oauth-consent.json');

/**
 * Load the consent store from disk.
 * Returns an empty store structure if the file does not exist or is corrupt.
 *
 * @returns {{ consents: Record<string, ConsentEntry> }} The parsed store.
 */
function loadStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) {
      return { consents: {} };
    }
    const data = fs.readFileSync(STORE_PATH, 'utf8');
    return JSON.parse(data);
  } catch {
    return { consents: {} };
  }
}

/**
 * Persist the consent store to disk atomically.
 * Uses a temp-file-and-rename strategy to avoid partial writes.
 *
 * @param {{ consents: Record<string, ConsentEntry> }} store - Store to persist.
 * @returns {Promise<void>}
 */
async function saveStore(store) {
  try {
    await atomicWriteJSON(STORE_PATH, store);
  } catch (error) {
    logger.error('[ConsentStore] Failed to save:', error.message);
    throw error;
  }
}

/**
 * Build a namespaced lookup key from a client ID and a user subject ID.
 * The colon separator is safe because OAuth client IDs and JWT subjects
 * are URI-safe strings that do not contain colons by convention.
 *
 * @param {string} clientId - OAuth client identifier.
 * @param {string} userId - User subject identifier from the JWT.
 * @returns {string} Composite key in the form "<clientId>:<userId>".
 */
function consentKey(clientId, userId) {
  return `${clientId}:${userId}`;
}

/**
 * @typedef {Object} ConsentEntry
 * @property {string} clientId - OAuth client identifier.
 * @property {string} userId - User subject identifier.
 * @property {Array<string>} scopes - Scopes that were granted.
 * @property {string} grantedAt - ISO-8601 timestamp of initial grant.
 * @property {string} expiresAt - ISO-8601 timestamp when the consent expires.
 */

/**
 * Check whether a user has previously granted consent to a client for all
 * of the requested scopes and the stored record has not yet expired.
 *
 * The check performs a strict superset comparison: every scope in `scopes`
 * must be present in the persisted grant.  Extra scopes in the grant are
 * acceptable — they allow a previously broader consent to satisfy a narrower
 * follow-up request without prompting the user again.
 *
 * @param {string} clientId - OAuth client identifier.
 * @param {string} userId - User subject identifier from the JWT.
 * @param {Array<string>} scopes - Scopes requested in the current flow.
 * @param {number} [_ttlDays=90] - Reserved for future use; the stored `expiresAt`
 *   timestamp governs expiry.  Pass the same value used when granting consent
 *   to keep call-site behaviour self-documenting.
 * @returns {boolean} `true` if a valid, non-expired, fully-covering consent exists.
 *
 * @example
 * if (hasConsent('my-app', 'user-123', ['openid', 'email'])) {
 *   // skip consent screen
 * }
 */
export function hasConsent(clientId, userId, scopes, _ttlDays = 90) {
  const store = loadStore();
  const key = consentKey(clientId, userId);
  const entry = store.consents[key];

  if (!entry) return false;

  // Check expiry — wall-clock time takes precedence over ttlDays here
  if (new Date(entry.expiresAt).getTime() < Date.now()) {
    return false;
  }

  // Every requested scope must be covered by the stored grant
  const grantedScopes = new Set(entry.scopes || []);
  return scopes.every(scope => grantedScopes.has(scope));
}

/**
 * Persist a user's consent decision for a client and scope set.
 *
 * If a record already exists for this client–user pair it is overwritten,
 * effectively resetting the TTL clock.  Expired entries across the entire
 * store are pruned on each write to keep the file small.
 *
 * @param {string} clientId - OAuth client identifier.
 * @param {string} userId - User subject identifier from the JWT.
 * @param {Array<string>} scopes - Scopes that were granted by the user.
 * @param {number} [ttlDays=90] - How many days this consent record is valid.
 * @returns {Promise<void>}
 *
 * @example
 * await grantConsent('my-app', 'user-123', ['openid', 'email'], 90);
 */
export async function grantConsent(clientId, userId, scopes, ttlDays = 90) {
  const store = loadStore();
  const key = consentKey(clientId, userId);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();

  store.consents[key] = {
    clientId,
    userId,
    scopes,
    grantedAt: new Date().toISOString(),
    expiresAt
  };

  // Prune expired entries on every write to keep the file compact
  const now = Date.now();
  for (const [k, v] of Object.entries(store.consents)) {
    if (new Date(v.expiresAt).getTime() < now) {
      delete store.consents[k];
    }
  }

  await saveStore(store);
  logger.info(
    `[ConsentStore] Consent granted | client=${clientId} | user=${userId} | scopes=${scopes.join(',')}`
  );
}

/**
 * Remove the stored consent for a specific client–user pair.
 * The next authorization request for this combination will trigger the
 * consent screen again regardless of `ttlDays`.
 *
 * @param {string} clientId - OAuth client identifier.
 * @param {string} userId - User subject identifier from the JWT.
 * @returns {Promise<boolean>} `true` if a record existed and was deleted,
 *   `false` if no matching record was found.
 *
 * @example
 * const revoked = await revokeConsent('my-app', 'user-123');
 * if (revoked) { ... }
 */
export async function revokeConsent(clientId, userId) {
  const store = loadStore();
  const key = consentKey(clientId, userId);

  if (store.consents[key]) {
    delete store.consents[key];
    await saveStore(store);
    logger.info(`[ConsentStore] Consent revoked | client=${clientId} | user=${userId}`);
    return true;
  }
  return false;
}
