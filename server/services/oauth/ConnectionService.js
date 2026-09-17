/**
 * OAuth connections — "who is connected to what".
 *
 * A **connection** is a grant: user U allowed client C scopes S on date D.
 * That, not the client record, is the unit an administrator and a user
 * actually need. A client record answers "what software exists"; it cannot
 * answer "who gave it access", and since CIMD clients have no record at all it
 * never will.
 *
 * Nothing new is stored. The data is already in two places and this service is
 * the read model over them:
 *
 *   - `contents/data/oauth-consent.json` — one entry per `clientId:userId`,
 *     carrying scopes, grant date and (since the connections work) display
 *     snapshots of the client and the user.
 *   - `contents/data/oauth-refresh-tokens.json` — the live credentials for the
 *     same pair.
 *
 * Revoking a connection therefore means both: delete the consent entry so the
 * next authorization asks again, and revoke the refresh tokens so the client
 * cannot keep minting access tokens in the meantime.
 *
 * @module services/oauth/ConnectionService
 */
import { listConsents, revokeConsent } from '../../utils/consentStore.js';
import { revokeRefreshTokensFor } from '../../utils/refreshTokenStore.js';
import logger from '../../utils/logger.js';

/**
 * Shape one consent entry as a connection for the API and the UI.
 *
 * @param {Object} entry - Consent store entry
 * @returns {Object} Connection record
 */
function toConnection(entry) {
  return {
    clientId: entry.clientId,
    userId: entry.userId,
    clientName: entry.clientName || entry.clientId,
    clientHost: entry.clientHost || '',
    clientKind: entry.clientKind || 'stored',
    userName: entry.userName || entry.userId,
    userEmail: entry.userEmail || '',
    scopes: Array.isArray(entry.scopes) ? entry.scopes : [],
    grantedAt: entry.grantedAt || null,
    expiresAt: entry.expiresAt || null,
    lastUsedAt: entry.lastUsedAt || null
  };
}

/**
 * Every connection belonging to one user.
 *
 * @param {string} userId - User subject identifier
 * @returns {Array<Object>} The user's connections, newest grant first
 */
export function listConnectionsForUser(userId) {
  if (!userId) return [];
  return listConsents({ userId }).map(toConnection);
}

/**
 * Connections across all users, filtered and paged.
 *
 * Paging happens in memory: the consent store is a single JSON file holding
 * one entry per live grant, so it is already fully read to answer any query.
 *
 * @param {Object} [options]
 * @param {string} [options.clientId] - Only this client
 * @param {string} [options.userId] - Only this user
 * @param {string} [options.host] - Only clients seen on this hostname
 * @param {number} [options.page=1] - 1-based page number
 * @param {number} [options.pageSize=50] - Entries per page
 * @returns {{connections: Array<Object>, total: number, page: number, pageSize: number}}
 */
export function listConnections({ clientId, userId, host, page = 1, pageSize = 50 } = {}) {
  const all = listConsents({ clientId, userId, host }).map(toConnection);
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.min(Math.max(1, Number(pageSize) || 50), 500);
  const start = (safePage - 1) * safePageSize;

  return {
    connections: all.slice(start, start + safePageSize),
    total: all.length,
    page: safePage,
    pageSize: safePageSize
  };
}

/**
 * How many connections each client has, keyed by client ID.
 *
 * @returns {Record<string, number>} Connection count per client
 */
export function countByClient() {
  const counts = {};
  for (const entry of listConsents()) {
    counts[entry.clientId] = (counts[entry.clientId] || 0) + 1;
  }
  return counts;
}

/**
 * The CIMD clients that have actually been connected to, one row per host.
 *
 * A CIMD client is not stored anywhere, so the admin client list would show
 * nothing at all for the clients most users are connected through. Deriving
 * the rows from the connections is what puts them back on the page — as
 * read-only entries, because there is nothing to edit.
 *
 * @returns {Array<{clientId: string, host: string, name: string, connectionCount: number,
 *   lastUsedAt: string|null}>} One entry per distinct CIMD client
 */
export function listSeenCimdClients() {
  const byClient = new Map();

  for (const entry of listConsents()) {
    if (entry.clientKind !== 'cimd') continue;

    const existing = byClient.get(entry.clientId);
    if (existing) {
      existing.connectionCount += 1;
      if (entry.lastUsedAt && (!existing.lastUsedAt || entry.lastUsedAt > existing.lastUsedAt)) {
        existing.lastUsedAt = entry.lastUsedAt;
      }
      continue;
    }

    byClient.set(entry.clientId, {
      clientId: entry.clientId,
      host: entry.clientHost || '',
      name: entry.clientName || entry.clientId,
      connectionCount: 1,
      lastUsedAt: entry.lastUsedAt || null
    });
  }

  return [...byClient.values()].sort((a, b) => b.connectionCount - a.connectionCount);
}

/**
 * Disconnect one client from one user.
 *
 * Both halves matter. Deleting the consent alone only restores the consent
 * screen on the *next* authorization, while the client's refresh token would
 * go on minting access tokens for up to `refreshTokenExpirationDays`. Access
 * tokens already issued are stateless and cannot be recalled — they expire
 * within the client's `tokenExpirationMinutes`, which is what the UI tells the
 * user.
 *
 * @param {string} clientId - OAuth client identifier
 * @param {string} userId - User subject identifier
 * @returns {Promise<{revoked: boolean, refreshTokensRevoked: number}>}
 */
export async function revokeConnection(clientId, userId) {
  const consentRevoked = await revokeConsent(clientId, userId);
  const refreshTokensRevoked = await revokeRefreshTokensFor(clientId, userId);

  logger.info('[OAuth] Connection revoked', {
    component: 'ConnectionService',
    clientId,
    userId,
    consentRevoked,
    refreshTokensRevoked
  });

  // A connection whose consent had already lapsed but whose refresh token was
  // still live is still a connection that was revoked.
  return { revoked: consentRevoked || refreshTokensRevoked > 0, refreshTokensRevoked };
}
