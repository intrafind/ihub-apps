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
import { enhanceUserGroups, enhanceUserWithPermissions } from '../../../utils/authorization.js';
import { localUsersFile } from '../../../utils/contentsPath.js';
import { isUserActive, loadUsers } from '../../../utils/userManager.js';
import logger from '../../../utils/logger.js';

const COMPONENT = 'ScheduledTaskOwner';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The owner snapshot stored on a task.
 *
 * `recorded` says whether `users.json` held the owner when the task was saved.
 * An external identity may sign in without a record (one is written on first
 * sign-in only when the provider is set up to), so a missing record says
 * nothing about such an owner — unless there was one before: then it was
 * deleted, and the task stops with it.
 *
 * @param {Object} user - `req.user` of the owner.
 * @param {string} identityMode - Ledger identity mode the task's chats are owned in.
 * @param {Object} [options]
 * @param {Object} [options.platform] - Platform config (defaults to the cached one).
 * @param {Function} [options.lookupUser] - {@link findUserRecord}, injectable for tests.
 * @returns {Object}
 */
export function ownerSnapshot(user, identityMode, { platform, lookupUser = findUserRecord } = {}) {
  const userId = String(user.id);
  const lookup = lookupUser(userId, platform || configCache.getPlatform() || {});
  return {
    userId,
    username: String(user.username || user.id),
    name: String(user.name || user.username || user.id),
    email: user.email ? String(user.email) : null,
    groups: Array.isArray(user.groups) ? user.groups.map(String) : [],
    authMode: user.authMode ? String(user.authMode) : null,
    provider: user.provider ? String(user.provider) : null,
    identityMode: identityMode || 'default',
    recorded: lookup.found === true
  };
}

/**
 * The owner's record in `users.json`.
 *
 * `loadUsers` does not throw on a read or parse failure: it logs and answers
 * an empty user map with `metadata.error`. That is reported as a lookup error
 * here, so a local owner is retried rather than taken for deleted.
 *
 * @param {string} userId
 * @param {Object} platform
 * @param {Object} [options]
 * @param {Function} [options.load] - `loadUsers`, injectable for tests.
 * @returns {{found: boolean, record?: Object, error?: Error}}
 */
export function findUserRecord(userId, platform, { load = loadUsers } = {}) {
  if (!userId || DANGEROUS_KEYS.has(userId)) return { found: false };
  try {
    const usersConfig = load(localUsersFile(platform?.localAuth));
    if (usersConfig?.metadata?.error) {
      logger.warn('Could not read users.json while resolving a task owner', {
        component: COMPONENT,
        error: String(usersConfig.metadata.error)
      });
      return { found: false, error: new Error(String(usersConfig.metadata.error)) };
    }
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
 * The groups a run acts with.
 *
 * A local owner's memberships live in `users.json`, so they are read from
 * there on every run exactly as a local login derives them — removing the
 * owner from a group takes effect on the next run, not only after their next
 * sign-in. An external identity's groups come from its identity provider,
 * which cannot be asked without a sign-in; those keep the snapshot taken when
 * the task was last saved.
 *
 * @param {Object} owner - The task's owner snapshot.
 * @param {{found: boolean, record?: Object}} lookup
 * @param {Object} platformConfig
 * @returns {string[]}
 */
function currentGroups(owner, lookup, platformConfig) {
  if (owner.authMode === 'local' && lookup.found) {
    const internal = lookup.record?.internalGroups;
    const groups = Array.isArray(internal) ? internal.map(String) : ['users'];
    return enhanceUserGroups({ id: owner.userId, groups }, platformConfig.auth || {}).groups;
  }
  return Array.isArray(owner.groups) ? [...owner.groups] : [];
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
  // A local account always has a record; an external one only if it had one
  // when the task was saved (see ownerSnapshot).
  const expectsRecord = owner.authMode === 'local' || owner.recorded === true;
  if (lookup.error && expectsRecord) {
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
  if (!lookup.found && expectsRecord) {
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
    groups: currentGroups(owner, lookup, platformConfig),
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
