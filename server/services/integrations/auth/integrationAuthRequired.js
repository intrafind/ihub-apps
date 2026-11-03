// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The one "connect first" contract of every integration that signs users in
 * (Jira, the cloud storage providers, per-user MCP servers).
 *
 * A tool that cannot run because the caller (or, in a headless run, the
 * owner) has no usable connection returns — never throws — a structured
 * result, **before** it calls the vendor:
 *
 * ```json
 * { "error": "INTEGRATION_AUTH_REQUIRED", "integration": "jira",
 *   "reason": "not_connected", "message": "…",
 *   "connectUrl": "/api/integrations/jira/connect" }
 * ```
 *
 * `reason` is one of {@link INTEGRATION_AUTH_REASONS}:
 *   - `not_connected` — the principal never connected (or disconnected);
 *   - `expired` — the connection exists but cannot be used any more (refresh
 *     token refused, endpoint changed, revoked): connect again;
 *   - `insufficient_scope` — connected, but without a scope the call needs.
 *     The result then also carries `scopes` (what the re-authorization asks
 *     for) and `connectUrl` names the reconnect route.
 *
 * `connectUrl` is the same-origin API route that starts the one connect flow
 * (`POST`, answers `{ url }`; see `routes/integrations/userIntegrations.js`).
 * The chat renders one Connect card for this result (`chatSeams.authRequiredOf`).
 *
 * @module services/integrations/auth/integrationAuthRequired
 */
import { buildServerPath } from '../../../utils/basePath.js';

/** The error code of every "connect first" condition. */
export const INTEGRATION_AUTH_REQUIRED = 'INTEGRATION_AUTH_REQUIRED';

/** Why a connection is required. */
export const INTEGRATION_AUTH_REASONS = Object.freeze({
  NOT_CONNECTED: 'not_connected',
  EXPIRED: 'expired',
  INSUFFICIENT_SCOPE: 'insufficient_scope'
});

const REASONS = new Set(Object.values(INTEGRATION_AUTH_REASONS));

/** Longest scope list carried on a result (a step-up asks for a handful). */
const MAX_SCOPES = 50;

/**
 * The route that starts a sign-in for an installation (`POST`, answers `{ url }`).
 *
 * @param {string} installationId
 * @returns {string} e.g. `/api/integrations/jira/connect` (with the base path)
 */
export function integrationConnectPath(installationId) {
  return buildServerPath(`/api/integrations/${encodeURIComponent(installationId)}/connect`);
}

/**
 * The route that starts a new sign-in for an installation the user is
 * already connected to, optionally asking for more scopes (`POST`, `{ url }`).
 *
 * @param {string} installationId
 * @returns {string} e.g. `/api/integrations/okta/reconnect` (with the base path)
 */
export function integrationReconnectPath(installationId) {
  return buildServerPath(`/api/integrations/${encodeURIComponent(installationId)}/reconnect`);
}

/** Scopes as a bounded list of non-empty strings, or undefined. */
function normalizeScopes(scopes) {
  if (!Array.isArray(scopes)) return undefined;
  const list = scopes.filter(scope => typeof scope === 'string' && scope).slice(0, MAX_SCOPES);
  return list.length > 0 ? list : undefined;
}

/** The connect route a reason sends the user to. */
function defaultConnectUrl(integration, reason) {
  if (!integration) return null;
  return reason === INTEGRATION_AUTH_REASONS.INSUFFICIENT_SCOPE
    ? integrationReconnectPath(integration)
    : integrationConnectPath(integration);
}

/** Thrown inside services; adapters turn it into {@link integrationAuthRequiredResult}. */
export class IntegrationAuthRequiredError extends Error {
  /**
   * @param {Object} params
   * @param {string} params.integration - Installation id
   * @param {string} [params.reason='not_connected'] - One of INTEGRATION_AUTH_REASONS
   * @param {string} [params.message] - For the user / model; never upstream text
   * @param {string} [params.connectUrl] - Same-origin route that starts the connect flow
   *   (defaults to the installation's connect or, for `insufficient_scope`, reconnect route)
   * @param {string[]} [params.scopes] - Step-up: the scopes a reconnect asks for
   */
  constructor({ integration, reason = 'not_connected', message, connectUrl, scopes } = {}) {
    super(message || `Connect ${integration || 'the integration'} to continue`);
    this.name = 'IntegrationAuthRequiredError';
    this.code = INTEGRATION_AUTH_REQUIRED;
    this.integration = integration || null;
    this.reason = REASONS.has(reason) ? reason : INTEGRATION_AUTH_REASONS.NOT_CONNECTED;
    // Undefined: the installation's connect (or reconnect) route. Null: none
    // (the installation is not available to connect at all).
    this.connectUrl =
      connectUrl === undefined
        ? defaultConnectUrl(this.integration, this.reason)
        : connectUrl || null;
    this.scopes = normalizeScopes(scopes) || null;
  }
}

/**
 * Whether an error (or a tool result) is the "connect first" condition.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isIntegrationAuthRequired(value) {
  if (!value || typeof value !== 'object') return false;
  return value.code === INTEGRATION_AUTH_REQUIRED || value.error === INTEGRATION_AUTH_REQUIRED;
}

/**
 * The structured tool result for a missing or unusable connection.
 *
 * @param {Object} params
 * @param {string} params.integration - Installation id
 * @param {string} [params.reason='not_connected']
 * @param {string} params.message
 * @param {string} [params.connectUrl] - Defaults to the connect (or reconnect) route
 * @param {string[]} [params.scopes] - Step-up: the scopes a reconnect asks for
 * @param {Object} [params.extra] - Additional fields
 * @returns {{error: string, integration: string, reason: string, message: string, connectUrl: string, scopes?: string[]}}
 *
 * @example
 *   integrationAuthRequiredResult({ integration: 'jira', reason: 'expired',
 *     message: 'JIRA authentication expired. Please reconnect your account.' });
 *   // → { error: 'INTEGRATION_AUTH_REQUIRED', integration: 'jira', reason: 'expired',
 *   //     message: '…', connectUrl: '/api/integrations/jira/connect' }
 */
export function integrationAuthRequiredResult({
  integration,
  reason = INTEGRATION_AUTH_REASONS.NOT_CONNECTED,
  message,
  connectUrl,
  scopes,
  extra = {}
}) {
  const knownReason = REASONS.has(reason) ? reason : INTEGRATION_AUTH_REASONS.NOT_CONNECTED;
  const url = connectUrl || defaultConnectUrl(integration, knownReason);
  const stepUp = normalizeScopes(scopes);
  return {
    error: INTEGRATION_AUTH_REQUIRED,
    integration,
    reason: knownReason,
    message,
    ...(url ? { connectUrl: url } : {}),
    ...(stepUp ? { scopes: stepUp } : {}),
    ...extra
  };
}
