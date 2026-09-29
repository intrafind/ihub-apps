/**
 * The principal a scheduled run acts as.
 *
 * A task stores a snapshot of its owner — id, name, groups, auth mode — taken
 * whenever the owner saves it, the way a personal API key stores its owner.
 * Every run rebuilds the principal from that snapshot and re-resolves the
 * permissions against the *current* group configuration
 * (`enhanceUserWithPermissions`), so an admin who takes an app away from a
 * group takes it away from that group's scheduled tasks too.
 *
 * An owner who can be looked up — a local account, or an external account
 * persisted in `users.json` — is looked up: a deleted or deactivated account
 * disables the task. Group membership itself comes from the snapshot, exactly
 * as it comes from the token on an interactive request: for an OIDC or proxy
 * user the identity provider is the authority, and it is only consulted at
 * sign-in.
 *
 * @module services/scheduler/tasks/ownerPrincipal
 */
import configCache from '../../../configCache.js';
import { enhanceUserWithPermissions } from '../../../utils/authorization.js';
import { localUsersFile } from '../../../utils/contentsPath.js';
import { isUserActive, loadUsers } from '../../../utils/userManager.js';
import logger from '../../../utils/logger.js';

const COMPONENT = 'ScheduledTaskOwner';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The owner snapshot stored on a task.
 *
 * @param {Object} user - `req.user` of the owner.
 * @param {string} identityMode - Ledger identity mode the task's chats are owned in.
 * @returns {Object}
 */
export function ownerSnapshot(user, identityMode) {
  return {
    userId: String(user.id),
    username: String(user.username || user.id),
    name: String(user.name || user.username || user.id),
    email: user.email ? String(user.email) : null,
    groups: Array.isArray(user.groups) ? user.groups.map(String) : [],
    authMode: user.authMode ? String(user.authMode) : null,
    provider: user.provider ? String(user.provider) : null,
    identityMode: identityMode || 'default'
  };
}

function findUserRecord(userId, platform) {
  if (!userId || DANGEROUS_KEYS.has(userId)) return { found: false };
  try {
    const usersConfig = loadUsers(localUsersFile(platform.localAuth));
    const users = usersConfig?.users || {};
    if (Object.hasOwn(users, userId)) return { found: true, record: users[userId] };
    return { found: false };
  } catch (error) {
    logger.warn('Could not read users.json while resolving a task owner', {
      component: COMPONENT,
      error: error.message
    });
    return { found: false, error };
  }
}

/**
 * Rebuild a task owner's principal.
 *
 * @param {Object} task
 * @param {Object} [options]
 * @param {Object} [options.platform] - Platform config (defaults to the cached one).
 * @param {(userId: string, platform: Object) => {found: boolean, record?: Object, error?: Error}}
 *   [options.lookupUser] - Injectable for tests.
 * @returns {{ok: true, user: Object} | {ok: false, code: string, message: string,
 *   action: 'disable'|'pause'|'retry'}}
 */
export function resolveOwnerPrincipal(task, { platform, lookupUser = findUserRecord } = {}) {
  const owner = task?.owner;
  if (!owner?.userId) {
    return {
      ok: false,
      code: 'OWNER_MISSING',
      message: 'The task has no owner',
      action: 'disable'
    };
  }
  const platformConfig = platform || configCache.getPlatform() || {};
  const lookup = lookupUser(owner.userId, platformConfig);
  if (lookup.error && owner.authMode === 'local') {
    // Cannot tell whether the account still exists: try again next run
    // rather than acting on a guess in either direction.
    return {
      ok: false,
      code: 'OWNER_LOOKUP_FAILED',
      message: 'The owner account could not be checked',
      action: 'retry'
    };
  }
  if (lookup.found && !isUserActive(lookup.record)) {
    return {
      ok: false,
      code: 'OWNER_DEACTIVATED',
      message: 'The owner account has been deactivated',
      action: 'disable'
    };
  }
  if (!lookup.found && owner.authMode === 'local') {
    return {
      ok: false,
      code: 'OWNER_DELETED',
      message: 'The owner account no longer exists',
      action: 'disable'
    };
  }
  const user = {
    id: owner.userId,
    username: owner.username || owner.userId,
    name: owner.name || owner.username || owner.userId,
    email: owner.email || '',
    groups: Array.isArray(owner.groups) ? [...owner.groups] : [],
    ...(owner.authMode ? { authMode: owner.authMode } : {}),
    ...(owner.provider ? { provider: owner.provider } : {}),
    timestamp: Date.now()
  };
  try {
    enhanceUserWithPermissions(user, platformConfig.auth || {}, platformConfig);
  } catch (error) {
    return {
      ok: false,
      code: 'PERMISSIONS_UNAVAILABLE',
      message: `The owner's permissions could not be resolved: ${error.message}`,
      action: 'retry'
    };
  }
  return { ok: true, user };
}

export default resolveOwnerPrincipal;
