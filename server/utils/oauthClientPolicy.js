/**
 * One place where "what is this client allowed to do" is decided.
 *
 * Three paths need the answer and they must not disagree:
 *
 *   - `oauthAuthorize.js` — before issuing an authorization code,
 *   - `oauth.js` — on every refresh-token rotation,
 *   - `mcpAuth.js` — on every single gateway request.
 *
 * Before this module the group check lived in the authorize endpoint alone,
 * which is why removing a user from a group did not end their MCP access: the
 * refresh grant re-stamped the group snapshot frozen at first authorization,
 * and the gateway never looked at `allowedGroups` at all.
 *
 * The other half is the layering. A CIMD client's policy comes from two
 * places — the `platform.oauth.cimd` defaults that apply to every metadata
 * document client, and the per-client record an administrator may have saved —
 * and it is layered **field by field**, not object by object, so narrowing one
 * client's groups does not silently discard the global apps list on it.
 *
 * @module utils/oauthClientPolicy
 */

import { isHostAllowed, isHostBlocked } from './clientIdMetadata.js';

/**
 * Is the authenticated user allowed to use this client?
 *
 * An empty or missing allowlist, and the `['*']` wildcard, mean unrestricted;
 * otherwise the user must be in at least one listed group.
 *
 * @param {Object} client - Resolved OAuth client
 * @param {Object} user - Something carrying a `groups` array: a decoded JWT, a
 *   refresh-token entry's user snapshot, or a `req.user`
 * @returns {boolean} True when the user passes the group check
 */
export function isUserAllowedByGroups(client, user) {
  const allowed = Array.isArray(client?.allowedGroups) ? client.allowedGroups : [];
  if (allowed.length === 0 || allowed.includes('*')) return true;
  const userGroups = Array.isArray(user?.groups) ? user.groups : [];
  return userGroups.some(group => allowed.includes(group));
}

/**
 * Pick the record's value for a field, falling back to the global default.
 *
 * `undefined` means "not set on this client" and inherits; every other value,
 * an empty array included, is a decision an administrator made and is kept.
 *
 * @param {Object|null} record - Stored CIMD policy record, if any
 * @param {Object} defaults - Normalized `platform.oauth.cimd` policy
 * @param {string} field - Field name on the record
 * @param {string} [defaultField=field] - Field name on the defaults object
 * @returns {*} The effective value
 */
export function effectiveField(record, defaults, field, defaultField = field) {
  const value = record?.[field];
  return value === undefined || value === null ? defaults[defaultField] : value;
}

/** Approval states a record may carry. */
export const CIMD_APPROVAL_STATES = Object.freeze(['pending', 'approved', 'auto']);

/**
 * Does the record satisfy the server's approval mode?
 *
 * Under `auto` the question is not asked — the host allowlist is the whole
 * decision, which is how iHub behaved before client governance. Under
 * `approval` a client must carry a record that an administrator approved, or
 * one stamped `auto` by an installation that was running in `auto` mode when
 * the client first connected. That second case is the same grandfathering the
 * upgrade migration performs: switching the mode on must not disconnect the
 * clients people are already using, only stop new ones.
 *
 * @param {Object|null} record - Stored CIMD policy record, if any
 * @param {string} approvalMode - `'approval'` or `'auto'`
 * @returns {boolean} True when the client may proceed
 */
export function approvalSatisfied(record, approvalMode) {
  if (approvalMode !== 'approval') return true;
  if (!record) return false;
  return record.approvalState === 'approved' || record.approvalState === 'auto';
}

/**
 * The conditions that can be decided **without** the metadata document.
 *
 * Split out from the approval check for one reason: none of these may cause a
 * network call, so they are evaluated before the document is fetched. A
 * blocked host or a blocked client therefore never makes the server issue an
 * outbound request on a caller-supplied URL.
 *
 * @param {string} clientId - CIMD client identifier (the document URL)
 * @param {Object} cimdConfig - Normalized policy from `getCimdConfig`
 * @param {Object|null} record - Stored policy record, if any
 * @returns {{active: boolean, code?: string, reason?: string}}
 */
export function evaluateCimdAccess(clientId, cimdConfig, record) {
  if (!cimdConfig.enabled) {
    return {
      active: false,
      code: 'cimd_disabled',
      reason: 'client metadata documents are not enabled on this server'
    };
  }

  // Blocking is checked before the allowlist so a blocked vendor is cut off
  // without having to edit the allowlist an operator wants to keep.
  if (isHostBlocked(clientId, cimdConfig.blockedClientHosts)) {
    return {
      active: false,
      code: 'host_blocked',
      reason: 'client host is blocked on this server'
    };
  }

  if (!isHostAllowed(clientId, cimdConfig.allowedClientHosts)) {
    return {
      active: false,
      code: 'host_not_allowed',
      reason: 'client host is not allowed on this server'
    };
  }

  // Before the block check, because a pending record carries `active: false`
  // and "waiting for approval" is a different thing to tell a user than
  // "an administrator blocked this". It also means a client that keeps
  // retrying while it waits never causes a document fetch.
  if (record?.approvalState === 'pending') {
    return {
      active: false,
      code: 'approval_pending',
      reason: 'this client has not been approved by an administrator'
    };
  }

  if (record && record.active === false) {
    return {
      active: false,
      code: 'client_blocked',
      reason: 'this client has been blocked by an administrator'
    };
  }

  return { active: true };
}

/**
 * Evaluate all five independently revocable conditions that make a CIMD client
 * usable, and say which one failed.
 *
 * Every one of them is re-read on every request, which is what makes each a
 * kill switch rather than a gate only new connections pass:
 *
 * ```
 * active = cimd.enabled && !hostBlocked && hostAllowed
 *       && record.active !== false && approvalSatisfied
 * ```
 *
 * @param {string} clientId - CIMD client identifier (the document URL)
 * @param {Object} cimdConfig - Normalized policy from `getCimdConfig`
 * @param {Object|null} record - Stored policy record, if any
 * @returns {{active: boolean, code?: string, reason?: string}}
 */
export function evaluateCimdActivation(clientId, cimdConfig, record) {
  const access = evaluateCimdAccess(clientId, cimdConfig, record);
  if (!access.active) return access;

  if (!approvalSatisfied(record, cimdConfig.approvalMode)) {
    return {
      active: false,
      code: 'approval_pending',
      reason: 'this client has not been approved by an administrator'
    };
  }

  return { active: true };
}

/**
 * Narrow a set of already-granted scopes to what a client may still be granted.
 *
 * Used on refresh so that narrowing a client's grantable scopes narrows live
 * connections rather than only future ones. An empty grantable list is treated
 * as "no restriction recorded", matching how `allowedScopes` is normalized.
 *
 * @param {Array<string>} granted - Scopes on the refresh-token entry
 * @param {Array<string>} grantable - The client's current scopes
 * @returns {Array<string>} The surviving scopes, in their granted order
 */
export function intersectScopes(granted, grantable) {
  const held = Array.isArray(granted) ? granted : [];
  if (!Array.isArray(grantable) || grantable.length === 0) return [...held];
  return held.filter(scope => grantable.includes(scope));
}
