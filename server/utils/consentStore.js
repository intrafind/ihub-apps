import path from 'path';
import fs from 'fs';
import { atomicWriteJSON } from './atomicWrite.js';
import logger from './logger.js';
import { getRootDir } from '../pathUtils.js';
import config from '../config.js';

const STORE_PATH = path.join(getRootDir(), config.CONTENTS_DIR, 'data', 'oauth-consent.json');

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
    await fs.promises.mkdir(path.dirname(STORE_PATH), { recursive: true });
    await atomicWriteJSON(STORE_PATH, store);
  } catch (error) {
    logger.error('Failed to save consent store', { component: 'ConsentStore', error });
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
 * @property {string} [clientName] - Display snapshot of the client's name.
 * @property {string} [clientHost] - Hostname for a CIMD client, '' otherwise.
 * @property {string} [clientKind] - 'stored' or 'cimd' at the time of grant.
 * @property {string} [userName] - Display snapshot of the user's name.
 * @property {string} [userEmail] - Display snapshot of the user's email.
 * @property {string} [lastUsedAt] - ISO-8601 timestamp of the last refresh.
 *
 * The display snapshots exist so listing connections needs no join against the
 * user store: OIDC and proxy users have no local record to join to, and a CIMD
 * client has no stored record at all. Entries written before these fields
 * existed are read as-is — every consumer treats them as optional.
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
 * @param {Object} [snapshot] - Display details to store alongside the grant so
 *   the connections list can be rendered without joining anything: the client
 *   may have no stored record (CIMD) and the user may have no local account
 *   (OIDC, proxy).
 * @param {string} [snapshot.clientName] - Client display name.
 * @param {string} [snapshot.clientHost] - Client hostname, for CIMD clients.
 * @param {string} [snapshot.clientKind] - 'stored' or 'cimd'.
 * @param {string} [snapshot.userName] - User display name.
 * @param {string} [snapshot.userEmail] - User email address.
 * @returns {Promise<void>}
 *
 * @example
 * await grantConsent('my-app', 'user-123', ['openid', 'email'], 90);
 */
export async function grantConsent(clientId, userId, scopes, ttlDays = 90, snapshot = {}) {
  const store = loadStore();
  const key = consentKey(clientId, userId);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  const previous = store.consents[key];

  store.consents[key] = {
    clientId,
    userId,
    scopes,
    grantedAt: new Date().toISOString(),
    expiresAt,
    clientName: snapshot.clientName || previous?.clientName || '',
    clientHost: snapshot.clientHost || previous?.clientHost || '',
    clientKind: snapshot.clientKind || previous?.clientKind || 'stored',
    userName: snapshot.userName || previous?.userName || '',
    userEmail: snapshot.userEmail || previous?.userEmail || '',
    // Re-consenting is not using the connection; leave the usage clock alone.
    lastUsedAt: previous?.lastUsedAt || null
  };

  // Prune expired entries on every write to keep the file compact
  const now = Date.now();
  for (const [k, v] of Object.entries(store.consents)) {
    if (new Date(v.expiresAt).getTime() < now) {
      delete store.consents[k];
    }
  }

  await saveStore(store);
  logger.info('Consent granted', {
    component: 'ConsentStore',
    clientId,
    userId,
    scopes: scopes.join(',')
  });
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
    logger.info('Consent revoked', { component: 'ConsentStore', clientId, userId });
    return true;
  }
  return false;
}

/**
 * Record that a connection was used, throttled to one write a minute.
 *
 * Called on refresh-token rotation, which is the one moment the server sees a
 * long-lived connection still being exercised — an access token is verified
 * statelessly and leaves no trace here. Throttled for the same reason
 * `updateClientLastUsed` is: a busy client would otherwise rewrite the store on
 * every rotation.
 *
 * @param {string} clientId - OAuth client identifier.
 * @param {string} userId - User subject identifier.
 * @returns {Promise<void>}
 */
export async function touchConsentLastUsed(clientId, userId) {
  try {
    const store = loadStore();
    const key = consentKey(clientId, userId);
    const entry = store.consents[key];
    if (!entry) return;

    const now = Date.now();
    if (entry.lastUsedAt && now - new Date(entry.lastUsedAt).getTime() < 60000) return;

    entry.lastUsedAt = new Date(now).toISOString();
    await saveStore(store);
  } catch (error) {
    logger.warn('Failed to record consent usage', { component: 'ConsentStore', error });
    // Non-critical: this is display bookkeeping, not authorization state.
  }
}

/**
 * List stored consent entries, newest grant first.
 *
 * Expired entries are filtered out rather than deleted — pruning is the write
 * path's job, and a read that mutates the store would make listing a page
 * race with every other worker.
 *
 * @param {Object} [filter]
 * @param {string} [filter.clientId] - Only this client.
 * @param {string} [filter.userId] - Only this user.
 * @param {string} [filter.host] - Only clients seen on this hostname.
 * @returns {Array<ConsentEntry>} Matching, unexpired entries.
 */
export function listConsents(filter = {}) {
  const store = loadStore();
  const now = Date.now();

  return Object.values(store.consents || {})
    .filter(entry => {
      if (!entry || !entry.clientId || !entry.userId) return false;
      if (entry.expiresAt && new Date(entry.expiresAt).getTime() < now) return false;
      if (filter.clientId && entry.clientId !== filter.clientId) return false;
      if (filter.userId && entry.userId !== filter.userId) return false;
      if (filter.host && (entry.clientHost || '') !== filter.host) return false;
      return true;
    })
    .sort((a, b) => String(b.grantedAt || '').localeCompare(String(a.grantedAt || '')));
}
