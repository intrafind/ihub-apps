// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Refusals that keep an installation administrable.
 *
 * Every writer of `platform.json`, `users.json` and `groups.json` that can
 * take an administrator's access away calls one of these inside its
 * `updateJson` mutator, on the body it read under the lock, before returning
 * the new body:
 *
 * - {@link assertPlatformChangeKeepsAccess}: the platform save (`POST
 *   /api/admin/configs/platform`, and any later scoped PATCH) and the platform
 *   rollback. 409 `AUTH_LOCKOUT`.
 * - {@link assertUserChangeKeepsAdmin}: user update and delete. 409
 *   `SELF_LOCKOUT` / `LAST_ADMIN` (delete keeps its 403 `FORBIDDEN`).
 * - {@link assertGroupChangeKeepsAdmin}: group update and rollback. 409
 *   `LAST_ADMIN`.
 * - {@link assertGroupsResolvable} / {@link assertGroupNotInherited}: every
 *   groups.json writer; group delete. 400 / 409 `GROUP_IN_USE`.
 *
 * There is no override. Why: the admin rescue (`ensureFirstUserIsAdmin`)
 * makes the next person who signs in an administrator once no admin can sign
 * in, so a lockout is also a privilege escalation. Recovery is out of band
 * (edit platform.json on disk or set `IHUB_PLATFORM__LOCAL_AUTH__ENABLED=true`,
 * then restart; see docs/AUTHENTICATION_QUICK_START.md).
 *
 * The rules themselves are pure and live in `authInvariants.js`. Anything
 * that goes wrong while evaluating them refuses the change with 503
 * `ADMIN_CHECK_FAILED`; it never lets it through.
 *
 * @module server/utils/adminGuards
 */

import configStore from '../services/config/ConfigStore.js';
import { resolveGroupInheritance } from './authorization.js';
import {
  adminGroupIds,
  authConfigChanged,
  countUsableAdmins,
  dependantsOf,
  effectivePlatformConfig,
  groupsResolutionError,
  isUsableAdmin,
  KNOWN_SIGN_IN_MODES,
  routeSurvives,
  signInRouteOf
} from './authInvariants.js';
import { ServiceError } from './ServiceError.js';
import logger from './logger.js';

const USERS_FILE = 'config/users.json';
const GROUPS_FILE = 'config/groups.json';
const PLATFORM_FILE = 'config/platform.json';

/** The safe path, repeated in every lockout refusal. */
const SAFE_SWITCH_HINT =
  'To switch sign-in methods: enable the new method and save, sign in with it as an administrator, then turn off the old one.';

/**
 * Run `check`, turning any failure that is not already a refusal into
 * `ADMIN_CHECK_FAILED`. The change is never let through on an error.
 *
 * @template T
 * @param {string} what - For the log
 * @param {() => Promise<T>} check
 * @returns {Promise<T>}
 */
async function failClosed(what, check) {
  try {
    return await check();
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    logger.error('Admin access check failed; the change was refused', {
      component: 'AdminGuards',
      check: what,
      error
    });
    throw new ServiceError(
      'ADMIN_CHECK_FAILED',
      'Could not verify that an administrator keeps access, so nothing was changed. Try again; if this persists, check that users.json, groups.json and platform.json are readable.',
      { cause: error }
    );
  }
}

/**
 * Read a stored body fresh from the configuration store (never the cache).
 * A missing file is `null`; a present but unreadable one throws.
 *
 * @param {string} relPath
 * @returns {Promise<Object|null>}
 */
async function readStored(relPath) {
  return configStore.readJsonStrict(relPath);
}

/**
 * Resolve group inheritance; a missing groups file is no groups.
 *
 * @param {Object|null} groupsData - groups.json
 * @returns {Object} `{ groups }` with permissions merged from parents
 */
function resolveGroups(groupsData) {
  return resolveGroupInheritance(groupsData?.groups ? groupsData : { groups: {} });
}

/**
 * Refuse a platform change that locks the caller or every administrator out.
 *
 * Call it inside the `updatePlatform` mutator with the stored body and the
 * body about to be stored. It only evaluates when an auth block changes.
 *
 * 1. The caller's own sign-in route (method and provider) must survive, if it
 *    survived before. A human caller with an unknown route is refused. Machine
 *    principals (OAuth clients, API keys) have no session to keep and skip it.
 * 2. Some administrator must still be able to sign in, if one could before.
 *
 * Both are evaluated on the effective configuration (`IHUB_PLATFORM__*`
 * overrides applied), against users.json and groups.json read fresh.
 *
 * @param {Object|null|undefined} user - `req.user`
 * @param {Object|null} storedBefore - platform.json as stored now
 * @param {Object} next - The platform.json about to be stored
 * @param {Object} [options]
 * @param {Object<string, string|undefined>} [options.env=process.env] - For the overrides
 * @returns {Promise<void>}
 * @throws {ServiceError} 409 `AUTH_LOCKOUT`, or 503 `ADMIN_CHECK_FAILED`
 *
 * @example
 * await updatePlatform(async stored => {
 *   const next = { ...stored, localAuth: { enabled: false } };
 *   await assertPlatformChangeKeepsAccess(req.user, stored, next);
 *   return next;
 * });
 */
export async function assertPlatformChangeKeepsAccess(
  user,
  storedBefore,
  next,
  { env = process.env } = {}
) {
  if (!authConfigChanged(storedBefore, next)) return;

  await failClosed('platform', async () => {
    const [usersData, groupsData] = await Promise.all([
      readStored(USERS_FILE),
      readStored(GROUPS_FILE)
    ]);
    const resolvedGroups = resolveGroups(groupsData);
    const before = effectivePlatformConfig(storedBefore, env);
    const after = effectivePlatformConfig(next, env);
    const route = signInRouteOf(user);

    if (!route.machine) {
      const users = usersData?.users || {};
      const record = user?.id && Object.hasOwn(users, user.id) ? users[user.id] : undefined;
      const known = KNOWN_SIGN_IN_MODES.includes(route.mode);
      const losesRoute =
        !known || (routeSurvives(route, before, record) && !routeSurvives(route, after, record));
      if (losesRoute) {
        throw new ServiceError(
          'AUTH_LOCKOUT',
          `This change would turn off the sign-in method you are using (${route.mode || 'unknown'}${
            route.provider ? `: ${route.provider}` : ''
          }), and you would lose access to administration. Nothing was changed. ${SAFE_SWITCH_HINT}`,
          {
            details: {
              reason: 'callerLosesSignIn',
              authMode: route.mode || 'unknown',
              authProvider: route.provider || ''
            }
          }
        );
      }
    }

    const adminsBefore = countUsableAdmins(usersData, resolvedGroups, before);
    const adminsAfter = countUsableAdmins(usersData, resolvedGroups, after);
    if (adminsAfter === 0 && adminsBefore > 0) {
      throw new ServiceError(
        'AUTH_LOCKOUT',
        `After this change no active administrator could sign in, and the next person to sign in would be made an administrator. Nothing was changed. Keep the sign-in method of at least one administrator enabled. ${SAFE_SWITCH_HINT}`,
        {
          details: {
            reason: 'noAdminSignIn',
            authMode: route.mode || 'unknown',
            authProvider: route.provider || ''
          }
        }
      );
    }
  });
}

/**
 * Whether a user update can change who is an administrator: it touches
 * `active`, `internalGroups`, `authMethods` or the password hash.
 *
 * @param {Object|undefined} before
 * @param {Object|undefined} after
 * @returns {boolean}
 */
function adminRelevantChange(before, after) {
  if (!before || !after) return true;
  return ['active', 'internalGroups', 'authMethods', 'passwordHash'].some(
    key => JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)
  );
}

/**
 * Refuse a user update or delete that locks the caller out or leaves no
 * administrator who can sign in.
 *
 * Call it inside the users.json mutator, with a copy of the body as read and
 * the body about to be stored.
 *
 * - Deleting or deactivating your own account: 409 `SELF_LOCKOUT`, always.
 * - Leaving no usable administrator (active, sign-in method enabled, admin
 *   through a resolved group): 409 `LAST_ADMIN` on update; on delete the
 *   existing 403 `FORBIDDEN`. Demoting yourself is allowed while another
 *   usable administrator remains.
 *
 * @param {Object|null|undefined} user - `req.user`
 * @param {Object} usersBefore - users.json as read under the lock (unchanged copy)
 * @param {Object} usersAfter - users.json about to be stored
 * @param {Object} change
 * @param {string} change.userId - The user being changed
 * @param {'update'|'delete'} change.action
 * @param {Object<string, string|undefined>} [change.env=process.env]
 * @returns {Promise<void>}
 * @throws {ServiceError}
 */
export async function assertUserChangeKeepsAdmin(
  user,
  usersBefore,
  usersAfter,
  { userId, action, env = process.env }
) {
  const before = usersBefore?.users?.[userId];
  const after = action === 'delete' ? undefined : usersAfter?.users?.[userId];
  const isSelf = Boolean(user?.id) && user.id === userId;

  if (isSelf && action === 'delete') {
    throw new ServiceError(
      'SELF_LOCKOUT',
      'You cannot delete your own account. Ask another administrator to do it.',
      { details: { reason: 'selfDelete' } }
    );
  }
  if (isSelf && after?.active === false && before?.active !== false) {
    throw new ServiceError(
      'SELF_LOCKOUT',
      'You cannot deactivate your own account. Ask another administrator to do it.',
      { details: { reason: 'selfDeactivate' } }
    );
  }

  if (action !== 'delete' && !adminRelevantChange(before, after)) return;
  // Without groups a record cannot be an administrator; nothing to read.
  if (!Array.isArray(before?.internalGroups) || before.internalGroups.length === 0) return;

  await failClosed('user', async () => {
    const [groupsData, storedPlatform] = await Promise.all([
      readStored(GROUPS_FILE),
      readStored(PLATFORM_FILE)
    ]);
    const resolvedGroups = resolveGroups(groupsData);
    const platform = effectivePlatformConfig(storedPlatform, env);

    if (!isUsableAdmin(before, resolvedGroups, platform)) return;
    if (after && isUsableAdmin(after, resolvedGroups, platform)) return;
    if (countUsableAdmins(usersAfter, resolvedGroups, platform) > 0) return;

    if (action === 'delete') {
      // The status and code this refusal has always had (403 FORBIDDEN).
      throw new ServiceError(
        'FORBIDDEN',
        'Cannot delete the last admin user. At least one admin user must exist in the system. Please assign admin rights to another user before deleting this account.'
      );
    }
    throw new ServiceError(
      'LAST_ADMIN',
      'This change would leave no active administrator who can sign in, and the next person to sign in would be made an administrator. Nothing was changed. Give another active user administrator rights first.',
      { details: { userId } }
    );
  });
}

/**
 * Refuse a groups.json change that leaves no administrator who can sign in
 * (for example removing `adminAccess` from, or the `inherits` link to, the
 * group every admin gets it through). 409 `LAST_ADMIN`.
 *
 * Only evaluated when a group that granted admin access (after resolution)
 * no longer does. Call it with a body that resolves
 * ({@link assertGroupsResolvable} first).
 *
 * @param {Object} groupsBefore - groups.json as read under the lock (unchanged copy)
 * @param {Object} groupsAfter - groups.json about to be stored
 * @param {Object} [options]
 * @param {string} [options.groupId] - The group being changed, for the message
 * @param {Object<string, string|undefined>} [options.env=process.env]
 * @returns {Promise<void>}
 * @throws {ServiceError}
 */
export async function assertGroupChangeKeepsAdmin(
  groupsBefore,
  groupsAfter,
  { groupId, env = process.env } = {}
) {
  await failClosed('group', async () => {
    const resolvedBefore = resolveGroups(groupsBefore);
    const resolvedAfter = resolveGroups(groupsAfter);
    const adminAfter = adminGroupIds(resolvedAfter);
    const lost = [...adminGroupIds(resolvedBefore)].filter(id => !adminAfter.has(id));
    if (lost.length === 0) return;

    const [usersData, storedPlatform] = await Promise.all([
      readStored(USERS_FILE),
      readStored(PLATFORM_FILE)
    ]);
    const platform = effectivePlatformConfig(storedPlatform, env);
    const before = countUsableAdmins(usersData, resolvedBefore, platform);
    const after = countUsableAdmins(usersData, resolvedAfter, platform);
    if (after === 0 && before > 0) {
      throw new ServiceError(
        'LAST_ADMIN',
        `This change to group '${groupId ?? lost[0]}' would leave no active administrator who can sign in, and the next person to sign in would be made an administrator. Nothing was changed. Give another active user administrator rights first.`,
        { details: { groupId: groupId ?? lost[0] } }
      );
    }
  });
}

/**
 * Refuse a groups.json body whose inheritance does not resolve (a missing
 * parent, a cycle). 400 `BAD_REQUEST`.
 *
 * @param {Object} groupsData - groups.json about to be stored
 * @returns {void}
 * @throws {ServiceError}
 */
export function assertGroupsResolvable(groupsData) {
  const problem = groupsResolutionError(groupsData);
  if (problem) {
    throw new ServiceError(
      'BAD_REQUEST',
      `The group configuration would not resolve: ${problem}. Nothing was changed.`
    );
  }
}

/**
 * Refuse deleting a group that other groups inherit from. 409 `GROUP_IN_USE`
 * with `details.dependants` (the direct inheritors, to change first).
 *
 * @param {Object} groupsData - groups.json as read under the lock
 * @param {string} groupId - The group to delete
 * @returns {void}
 * @throws {ServiceError}
 */
export function assertGroupNotInherited(groupsData, groupId) {
  const dependants = dependantsOf(groupsData?.groups, groupId);
  if (dependants.length > 0) {
    throw new ServiceError(
      'GROUP_IN_USE',
      `Cannot delete group '${groupId}': ${dependants.join(', ')} inherit${
        dependants.length === 1 ? 's' : ''
      } from it. Remove it from their inherited groups first.`,
      { details: { groupId, dependants } }
    );
  }
}
