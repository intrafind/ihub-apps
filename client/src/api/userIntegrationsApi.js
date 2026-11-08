// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { apiClient } from './client';

/**
 * The signed-in user's integrations and the one connect flow of every
 * protocol (Jira, cloud storage, per-user MCP, …).
 * Server: `server/routes/integrations/userIntegrations.js`.
 *
 * An integration entry:
 * ```
 * { id, definition, type, protocol, name, description, icon, categories, capabilities,
 *   actions: [{ name, title, description, sideEffect }], effects,
 *   apps: [{ id, name }],                       // the user's apps that use it
 *   connection: { mode, status, reason, account, scopes, connectedAt, expiresAt,
 *                 lastUsedAt, signInHost, connectable,
 *                 renewable,                     // connected: renewed without the user
 *                 sharedWith: [{ id, name }] } } // service account / shared key: the user's granting groups
 * ```
 *
 * `connection.status` is `connected`, `not_connected`, `needs_reconnect`
 * (personal), the mode itself (`sso`, `service_account`, `shared_key`,
 * `none`), or `unavailable` with `reason` `unreachable`,
 * `credential_rejected`, `credential_missing` or `not_configured`.
 *
 * @module api/userIntegrationsApi
 */

/** A 401 here means "not signed in", not an expired session: no session-expired dialog. */
const QUIET = { _suppressAuthExpired: true };

const path = id => `/integrations/${encodeURIComponent(id)}`;

/**
 * Every integration the user's groups allow.
 * @returns {Promise<Object[]>}
 */
export async function fetchUserIntegrations() {
  const { data } = await apiClient.get('/integrations', QUIET);
  return Array.isArray(data?.integrations) ? data.integrations : [];
}

/**
 * One integration, or null when the user may not use it (404).
 * @param {string} id - Installation id
 * @returns {Promise<Object|null>}
 */
export async function fetchUserIntegration(id) {
  try {
    const { data } = await apiClient.get(path(id), QUIET);
    return data?.integration || null;
  } catch (error) {
    if (error?.response?.status === 404) return null;
    throw error;
  }
}

/**
 * Start the sign-in: the server answers the vendor's authorization URL.
 *
 * @param {string} id - Installation id
 * @param {Object} [options]
 * @param {string} [options.returnUrl] - Where the browser comes back to (same origin)
 * @param {boolean} [options.reconnect=false] - Sign in again (keeps the connection id)
 * @param {string[]} [options.scopes] - Reconnect: the additional scopes to ask for
 * @returns {Promise<string>} The authorization URL
 */
export async function requestConnectUrl(id, { returnUrl, reconnect = false, scopes } = {}) {
  const body = {
    ...(returnUrl ? { returnUrl } : {}),
    ...(reconnect && Array.isArray(scopes) && scopes.length ? { scopes } : {})
  };
  const { data } = await apiClient.post(
    `${path(id)}/_${reconnect ? 'reconnect' : 'connect'}`,
    body,
    QUIET
  );
  if (typeof data?.url !== 'string' || !/^https?:\/\//i.test(data.url)) {
    throw new Error('The server did not answer a sign-in URL');
  }
  return data.url;
}

/**
 * Disconnect the user from an integration (revokes at the vendor where supported).
 * @param {string} id - Installation id
 * @returns {Promise<{removed: boolean, revoked: boolean}>}
 */
export async function disconnectUserIntegration(id) {
  const { data } = await apiClient.post(`${path(id)}/_disconnect`, {}, QUIET);
  return data;
}

/**
 * The catalog integrations the user can request ("Not available yet"),
 * each with the user's own request or null.
 * Server: `server/routes/integrations/integrationRequests.js`.
 *
 * ```
 * { definition, name, description, icon, publisher, categories, capabilities,
 *   actionCount, effects,
 *   request: { id, status, reason, createdAt, decidedAt, note } | null }
 * ```
 * `request.status` is `open`, `approved`, `declined` or `fulfilled`.
 *
 * @returns {Promise<Object[]>}
 */
export async function fetchRequestableIntegrations() {
  const { data } = await apiClient.get('/integrations/requests', QUIET);
  return Array.isArray(data?.items) ? data.items : [];
}

/**
 * Ask an admin to make a catalog integration available.
 *
 * @param {string} definition - The definition id
 * @param {string} [reason] - Why (at most 500 characters)
 * @returns {Promise<Object>} The request
 */
export async function requestIntegration(definition, reason) {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  const { data } = await apiClient.post(
    '/integrations/requests',
    { definition, ...(trimmed ? { reason: trimmed } : {}) },
    QUIET
  );
  return data?.request || null;
}
