// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The one "connect first" contract of every integration that signs users in
 * (Jira, the cloud storage providers, per-user MCP servers).
 *
 * A tool that cannot run because the caller (or, in a headless run, the
 * owner) has no usable connection returns — never throws — a structured
 * result:
 *
 * ```json
 * { "error": "INTEGRATION_AUTH_REQUIRED", "integration": "jira",
 *   "reason": "not_connected", "message": "…", "connectUrl": "/…" }
 * ```
 *
 * `reason` is one of {@link INTEGRATION_AUTH_REASONS}:
 *   - `not_connected` — the principal never connected (or disconnected);
 *   - `expired` — the connection exists but cannot be used any more (refresh
 *     token refused, endpoint changed, revoked): connect again;
 *   - `insufficient_scope` — connected, but without a scope the call needs.
 *
 * It replaces the per-integration codes `JIRA_AUTH_REQUIRED` and
 * `MCP_AUTH_REQUIRED` at the adapter boundary.
 *
 * @module services/integrations/auth/integrationAuthRequired
 */

/** The error code of every "connect first" condition. */
export const INTEGRATION_AUTH_REQUIRED = 'INTEGRATION_AUTH_REQUIRED';

/** Why a connection is required. */
export const INTEGRATION_AUTH_REASONS = Object.freeze({
  NOT_CONNECTED: 'not_connected',
  EXPIRED: 'expired',
  INSUFFICIENT_SCOPE: 'insufficient_scope'
});

const REASONS = new Set(Object.values(INTEGRATION_AUTH_REASONS));

/** Thrown inside services; adapters turn it into {@link integrationAuthRequiredResult}. */
export class IntegrationAuthRequiredError extends Error {
  /**
   * @param {Object} params
   * @param {string} params.integration - Installation id
   * @param {string} [params.reason='not_connected'] - One of INTEGRATION_AUTH_REASONS
   * @param {string} [params.message] - For the user / model; never upstream text
   * @param {string} [params.connectUrl] - Same-origin path that starts the connect flow
   */
  constructor({ integration, reason = 'not_connected', message, connectUrl } = {}) {
    super(message || `Connect ${integration || 'the integration'} to continue`);
    this.name = 'IntegrationAuthRequiredError';
    this.code = INTEGRATION_AUTH_REQUIRED;
    this.integration = integration || null;
    this.reason = REASONS.has(reason) ? reason : INTEGRATION_AUTH_REASONS.NOT_CONNECTED;
    this.connectUrl = connectUrl || null;
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
 * @param {string} [params.connectUrl]
 * @param {Object} [params.extra] - Additional fields (e.g. the chat card's `authRequired` marker)
 * @returns {{error: string, integration: string, reason: string, message: string, connectUrl?: string}}
 *
 * @example
 *   integrationAuthRequiredResult({ integration: 'jira', reason: 'expired',
 *     message: 'JIRA authentication expired. Please reconnect your account.' });
 */
export function integrationAuthRequiredResult({
  integration,
  reason = INTEGRATION_AUTH_REASONS.NOT_CONNECTED,
  message,
  connectUrl,
  extra = {}
}) {
  return {
    error: INTEGRATION_AUTH_REQUIRED,
    integration,
    reason: REASONS.has(reason) ? reason : INTEGRATION_AUTH_REASONS.NOT_CONNECTED,
    message,
    ...(connectUrl ? { connectUrl } : {}),
    ...extra
  };
}
