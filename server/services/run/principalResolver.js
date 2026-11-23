// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Who a run acts as: the one place a run's principal is resolved.
 *
 * Three sources, one result:
 *
 * - `{ kind: 'user', user }`: the principal of a request (`req.user`, after
 *   `enhanceUserWithPermissions`): a person in a session, or a program acting
 *   for one (an OAuth client, a personal API key). It is taken as it is; one
 *   without resolved permissions is refused (`PRINCIPAL_UNRESOLVED`). Nothing
 *   is assumed for a principal that carries none: no run acts on a guess.
 * - `{ kind: 'owner', task }`: the owner of a scheduled task, rebuilt from the
 *   snapshot the task stores and resolved against today's groups
 *   (`scheduler/tasks/ownerPrincipal.js`, whose rules apply unchanged: a deleted
 *   or deactivated owner is refused with the action the scheduler takes).
 * - `{ kind: 'service', account: { id, name?, groups } }`: a service account an
 *   admin chose for an agent, with the groups the admin gave it. It is resolved
 *   like a user of those groups and is never an administrator.
 *
 * Admin rights are for a person who is there. For every origin other than
 * `person`, and for a service account, the resolved principal loses them:
 * `isAdmin` and `isContentAdmin` are false and its permissions grant neither
 * `adminAccess` nor `contentAdmin`. Inbound `/v1`, MCP and A2A requests have the
 * origin `person` and keep the flags they have today (delegated tokens and
 * OAuth clients never had them, see `utils/authorization.js`).
 *
 * The legacy Agent Factory principal (`isAgent` with a profile id) is not
 * resolved: no run carries one since the Agent Factory was removed, and one
 * that turns up carries no permissions and is refused like any other.
 *
 * @module services/run/principalResolver
 */

import configCache from '../../configCache.js';
import { enhanceUserWithPermissions } from '../../utils/authorization.js';
import { PRINCIPAL_TYPES, SERVICE_AUTH_MODE, principalTypeOf } from './principalTypes.js';
import { createRunContext } from './RunContext.js';

export { PRINCIPAL_TYPES, SERVICE_AUTH_MODE, principalTypeOf };

/** Codes of a principal that could not be resolved. */
export const PRINCIPAL_ERROR_CODES = Object.freeze({
  /** The principal carries no resolved permissions (a bare object, or none at all). */
  UNRESOLVED: 'PRINCIPAL_UNRESOLVED',
  /** The source names no kind this resolver knows. */
  UNKNOWN_SOURCE: 'PRINCIPAL_SOURCE_UNKNOWN',
  /** The permissions of a service account could not be resolved. */
  PERMISSIONS_UNAVAILABLE: 'PERMISSIONS_UNAVAILABLE'
});

/**
 * The principal without admin rights: a copy, the original is left as it is
 * (a request's `req.user` is shared with the rest of the request).
 *
 * @param {Object} principal
 * @returns {Object}
 */
export function withoutAdminRights(principal) {
  const permissions = principal.permissions
    ? { ...principal.permissions, adminAccess: false, contentAdmin: false }
    : principal.permissions;
  return { ...principal, isAdmin: false, isContentAdmin: false, permissions };
}

const refused = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });

/**
 * A service account's principal, resolved against the groups the admin gave it.
 *
 * @param {Object} account
 * @param {Object} platform
 */
function servicePrincipal(account, platform) {
  if (!account?.id || !Array.isArray(account.groups)) {
    return refused(
      PRINCIPAL_ERROR_CODES.UNRESOLVED,
      'A service account needs an id and the groups an admin gave it'
    );
  }
  const user = {
    id: String(account.id),
    username: String(account.username || account.id),
    name: String(account.name || account.id),
    email: '',
    groups: account.groups.map(String),
    authMode: SERVICE_AUTH_MODE,
    timestamp: Date.now()
  };
  try {
    enhanceUserWithPermissions(user, platform.auth || {}, platform);
  } catch (error) {
    return refused(
      PRINCIPAL_ERROR_CODES.PERMISSIONS_UNAVAILABLE,
      `The service account's permissions could not be resolved: ${error.message}`,
      { action: 'retry' }
    );
  }
  return { ok: true, principal: user };
}

/** The principal of a request, before the origin rule. */
function requestPrincipal(user) {
  if (!user || typeof user !== 'object' || !user.permissions) {
    return refused(
      PRINCIPAL_ERROR_CODES.UNRESOLVED,
      'The caller has no resolved permissions; nothing runs on its behalf'
    );
  }
  return { ok: true, principal: user };
}

/**
 * The principal of the source, before the origin rule. The owner of a task is
 * loaded on demand: its rules read the user records, which a request does not need.
 *
 * @param {Object} source
 * @param {Object} platform
 * @param {Function} lookupUser
 */
async function principalOf(source, platform, lookupUser) {
  switch (source?.kind) {
    case 'user':
      return requestPrincipal(source.user);
    case 'owner': {
      const { resolveOwnerPrincipal } = await import('../scheduler/tasks/ownerPrincipal.js');
      const resolved = resolveOwnerPrincipal(source.task, {
        platform,
        ...(lookupUser ? { lookupUser } : {})
      });
      return resolved.ok ? { ok: true, principal: resolved.user } : resolved;
    }
    case 'service':
      return servicePrincipal(source.account, platform);
    default:
      return refused(PRINCIPAL_ERROR_CODES.UNKNOWN_SOURCE, 'Unknown principal source');
  }
}

/** The origin rule: admin rights only for a person who is there, never for a service account. */
function withOrigin(principal, principalType, origin) {
  const keepsAdmin = origin === 'person' && principalType !== 'service';
  return {
    ok: true,
    principal: keepsAdmin ? principal : withoutAdminRights(principal),
    principalType
  };
}

/**
 * Resolve the principal a run acts as.
 *
 * @param {{kind: 'user', user: Object} | {kind: 'owner', task: Object} |
 *   {kind: 'service', account: {id: string, name?: string, groups: string[]}}} source
 * @param {Object} [options]
 * @param {'person'|'schedule'} [options.origin='person'] - what starts the run
 * @param {Object} [options.platform] - platform configuration (default: the cached one)
 * @param {Function} [options.lookupUser] - the user record lookup of a task owner, for tests
 * @returns {Promise<{ok: true, principal: Object, principalType: 'user'|'client'|'service'} |
 *   {ok: false, code: string, message: string, action?: string}>}
 */
export async function resolvePrincipal(source, { origin = 'person', platform, lookupUser } = {}) {
  const platformConfig = platform || configCache.getPlatform?.() || {};
  const resolved = await principalOf(source, platformConfig, lookupUser);
  if (!resolved.ok) return resolved;
  const principalType = source.kind === 'service' ? 'service' : principalTypeOf(resolved.principal);
  return withOrigin(resolved.principal, principalType, origin);
}

/**
 * The principal of a request (`req.user`), synchronously: the `user` source of
 * {@link resolvePrincipal}.
 *
 * @param {Object|null|undefined} user
 * @param {Object} [options]
 * @param {'person'|'schedule'} [options.origin='person']
 * @returns {{ok: true, principal: Object, principalType: 'user'|'client'} |
 *   {ok: false, code: string, message: string}}
 */
export function resolveRequestPrincipal(user, { origin = 'person' } = {}) {
  const resolved = requestPrincipal(user);
  if (!resolved.ok) return resolved;
  return withOrigin(resolved.principal, principalTypeOf(resolved.principal), origin);
}

/**
 * The run context of an inbound request (the MCP gateway, an A2A task): the
 * request's principal, resolved with its permissions, with the origin `person`
 * (the request comes from a person or from a program acting for one, which
 * keeps the flags it has on the request).
 *
 * @param {Object} user - the authenticated caller (`req.user`)
 * @param {Object} [options]
 * @param {Iterable<string>|null} [options.toolGrant] - the tools the request may run
 * @param {string|null} [options.parentRunId] - the caller's run id
 * @param {Object} [options.budget]
 * @returns {{ok: true, context: Readonly<Object>} | {ok: false, code: string, message: string}}
 */
export function requestRunContext(
  user,
  { toolGrant = null, parentRunId = null, budget = {} } = {}
) {
  const resolved = resolveRequestPrincipal(user, { origin: 'person' });
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    context: createRunContext({
      principal: resolved.principal,
      principalType: resolved.principalType,
      origin: 'person',
      toolGrant,
      parentRunId,
      budget
    })
  };
}

export default resolvePrincipal;
