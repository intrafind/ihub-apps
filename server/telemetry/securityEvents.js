// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Which audit entries are security events, for `ihub.security.events`.
 *
 * Every security-relevant action already writes an audit entry (who, what,
 * when). The counter adds the rate, so a SIEM or an alert can see a burst of
 * failed logins or a sudden run of permission changes without reading the
 * audit log; the detail stays in the audit log, never on the metric.
 *
 * @module telemetry/securityEvents
 */

/** Audit resources whose changes alter who may do what. */
const PERMISSION_RESOURCES = new Set(['group', 'credential']);
/** Audit resources of OAuth clients (iHub as authorization server). */
const OAUTH_CLIENT_RESOURCES = new Set(['oauthClient', 'oauthCimdClient', 'oauthCimd']);
/** Audit resources of sharing something with others. */
const SHARE_RESOURCES = new Set([
  'chatShare',
  'projectShare',
  'userAppShare',
  'userPromptShare',
  'userSkillShare'
]);

/**
 * The security event an audit entry stands for, or null.
 *
 * @param {{action: string, resource: string, result?: string}} entry
 * @returns {string|null} One of `SECURITY_EVENTS` (`metrics.js`)
 */
export function securityEventOfAudit({ action, resource, result } = {}) {
  if (action === 'login' && result === 'failure') return 'login_failure';
  if (result === 'failure') return null;
  if (resource === 'telemetryContentCapture') return 'content_capture_change';
  if (resource === 'platform' && action === 'update') return 'admin_config_change';
  if (PERMISSION_RESOURCES.has(resource)) return 'permission_change';
  if (resource === 'user') return 'user_change';
  // An admin-issued static key for an OAuth client is a key like a personal one.
  if (resource === 'personalApiKey' || resource === 'oauthToken') return 'api_key_change';
  if (OAUTH_CLIENT_RESOURCES.has(resource)) return 'oauth_client_change';
  // A user consenting to a client (`/oauth/authorize`) writes the connection.
  if (resource === 'oauthConnection' && action === 'create') return 'oauth_grant';
  if (resource === 'oauthConnection' && (action === 'delete' || action === 'revoke')) {
    return 'oauth_revoke';
  }
  if (action === 'export') return 'bulk_export';
  if (SHARE_RESOURCES.has(resource) && action !== 'delete') return 'share_created';
  return null;
}
