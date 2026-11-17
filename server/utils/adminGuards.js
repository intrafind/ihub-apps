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
 * - {@link assertGroupChangeKeepsAdmin}: group update, delete and rollback. 409
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
 * A stored groups.json that does not resolve (a cycle or a missing parent,
 * from a hand edit) is not "unevaluable": the runtime keeps enforcing the last
 * groups that did resolve (`configCache`), so the guards evaluate against
 * those ({@link resolveGroupsAsEnforced}). Without that, every platform auth
 * save, every edit of an admin user and the group PUT that would repair the
 * cycle answered 503, and the only way out was a disk edit. Only when there is
 * no last good copy either (nothing resolved since start) does it stay 503.
 *
 * The writers that call these guards run under {@link withAdminInvariantLock}
 * (see `adminInvariantLock.js`), so a platform save and a user or group edit
 * in the same process cannot each pass on the other's old file.
 *
 * @module server/utils/adminGuards
 */

import fs from 'fs/promises';
import configStore from '../services/config/ConfigStore.js';
import configCache from '../configCache.js';
import { resolveGroupInheritance } from './authorization.js';
import { locateConfigFile } from './configFileLocation.js';
import { localUsersFile } from './contentsPath.js';
import {
  adminGroupIds,
  authConfigChanged,
  callerRecordId,
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

const GROUPS_FILE = 'config/groups.json';
const PLATFORM_FILE = 'config/platform.json';

/** The safe path, repeated in every lockout refusal. */
const SAFE_SWITCH_HINT =
  'To switch sign-in methods: enable the new method and save, sign in with it as an administrator, then turn off the old one.';

/**
 * What is missing when no administrator would remain: the usual case is an
 * administrator who gets admin rights only from an identity-provider group
 * mapping, which is not counted (the admin rescue does not count it either).
 */
const ADMIN_GROUP_HINT =
  'An administrator counts only when their user record has an administrator group: on the Users page, give your own account (or another user who signs in with a method that stays enabled) an administrator group such as "admins", then make this change again. A group mapping from the identity provider alone is not enough.';

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
 * Read the users file that sign-in and the admin rescue read:
 * `localAuth.usersFile` when it is set, `config/users.json` otherwise. A file
 * inside the contents directory goes through the store; one outside it is
 * read from disk. Missing is `null`; present but unreadable throws.
 *
 * @param {Object} platform - Effective platform configuration
 * @returns {Promise<Object|null>}
 */
async function readUsersFor(platform) {
  const { relPath, fullPath } = locateConfigFile(localUsersFile(platform?.localAuth));
  if (relPath) return readStored(relPath);
  let text;
  try {
    text = await fs.readFile(fullPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  return JSON.parse(text);
}

/**
 * Resolve group inheritance; a missing groups file is no groups.
 *
 * @param {Object|null} groupsData - groups.json
 * @returns {Object} `{ groups }` with permissions merged from parents
 * @throws {Error} When the inheritance does not resolve
 */
function resolveGroups(groupsData) {
  return resolveGroupInheritance(groupsData?.groups ? groupsData : { groups: {} });
}

/**
 * The groups the runtime enforces for a stored groups.json: the body itself,
 * resolved, or, when it does not resolve, the last groups that did (the cache
 * keeps serving those after a failed reload). Throws only when there is no
 * last good copy, which the caller turns into 503.
 *
 * @param {Object|null} groupsData - groups.json as stored
 * @param {string} what - For the log
 * @returns {Object} Resolved groups
 * @throws {Error} When neither the body nor a cached copy resolves
 */
function resolveGroupsAsEnforced(groupsData, what) {
  try {
    return resolveGroups(groupsData);
  } catch (error) {
    const lastGood = configCache.getGroups?.()?.data;
    if (!lastGood?.groups) throw error;
    logger.warn(
      'Stored groups.json does not resolve; checking admin access against the groups in force',
      { component: 'AdminGuards', check: what, error: error?.message }
    );
    return lastGood;
  }
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
    const before = effectivePlatformConfig(storedBefore, env);
    const after = effectivePlatformConfig(next, env);
    // Each side reads the users file it names (`localAuth.usersFile`), the one
    // sign-in and the rescue read; usually both are the same file.
    const sameUsersFile = localUsersFile(before.localAuth) === localUsersFile(after.localAuth);
    const [usersBefore, usersAfterRead, groupsData] = await Promise.all([
      readUsersFor(before),
      sameUsersFile ? null : readUsersFor(after),
      readStored(GROUPS_FILE)
    ]);
    const usersAfter = sameUsersFile ? usersBefore : usersAfterRead;
    const resolvedGroups = resolveGroupsAsEnforced(groupsData, 'platform');
    const route = signInRouteOf(user);

    if (!route.machine) {
      const recordIn = usersData => {
        const id = callerRecordId(usersData, user);
        return id === undefined ? undefined : usersData.users[id];
      };
      const known = KNOWN_SIGN_IN_MODES.includes(route.mode);
      const losesRoute =
        !known ||
        (routeSurvives(route, before, recordIn(usersBefore)) &&
          !routeSurvives(route, after, recordIn(usersAfter)));
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

    const adminsBefore = countUsableAdmins(usersBefore, resolvedGroups, before);
    const adminsAfter = countUsableAdmins(usersAfter, resolvedGroups, after);
    if (adminsAfter === 0 && adminsBefore > 0) {
      throw new ServiceError(
        'AUTH_LOCKOUT',
        `After this change no active administrator could sign in, and the next person to sign in would be made an administrator. Nothing was changed. ${ADMIN_GROUP_HINT}`,
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
  // Also a legacy provider token whose id is the IdP subject, not the key.
  const isSelf =
    Boolean(user?.id) && (user.id === userId || callerRecordId(usersBefore, user) === userId);

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
    const resolvedGroups = resolveGroupsAsEnforced(groupsData, 'user');
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
 * ({@link assertGroupsResolvable} first). A `groupsBefore` that does not
 * resolve is compared as the groups in force (the cache's last good copy), so
 * the edit that repairs a broken file is evaluated, not refused. Group update,
 * delete and rollback call it.
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
    const resolvedBefore = resolveGroupsAsEnforced(groupsBefore, 'group');
    const resolvedAfter = resolveGroups(groupsAfter);
    const adminAfter = adminGroupIds(resolvedAfter);
    const lost = [...adminGroupIds(resolvedBefore)].filter(id => !adminAfter.has(id));
    if (lost.length === 0) return;

    const storedPlatform = await readStored(PLATFORM_FILE);
    const platform = effectivePlatformConfig(storedPlatform, env);
    const usersData = await readUsersFor(platform);
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
 * Pass the body as read (`groupsBefore`) so the message can say when the
 * stored file was already broken before this change (a hand edit): the admin's
 * own edit is then not the cause, and the message says to repair the stored
 * problem first. A write whose result resolves is never refused here, even
 * when the stored body did not resolve; that is how a broken file is repaired.
 *
 * @param {Object} groupsData - groups.json about to be stored
 * @param {Object|null} [groupsBefore] - groups.json as read under the lock (unchanged copy)
 * @returns {void}
 * @throws {ServiceError}
 */
export function assertGroupsResolvable(groupsData, groupsBefore) {
  const problem = groupsResolutionError(groupsData);
  if (!problem) return;
  const storedProblem = groupsBefore ? groupsResolutionError(groupsBefore) : null;
  if (storedProblem) {
    throw new ServiceError(
      'BAD_REQUEST',
      `The stored group configuration already does not resolve: ${storedProblem}. Nothing was changed. Fix that first (edit the inherited groups of the groups named there), then make this change.`
    );
  }
  throw new ServiceError(
    'BAD_REQUEST',
    `The group configuration would not resolve: ${problem}. Nothing was changed.`
  );
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
