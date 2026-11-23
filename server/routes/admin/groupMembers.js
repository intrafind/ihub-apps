// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configStore from '../../services/config/ConfigStore.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { assertValidId } from '../../utils/pathSecurity.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { sendCreated, segment } from '../../utils/created.js';
import { assertUserChangeKeepsAdmin } from '../../utils/adminGuards.js';
import { withAdminInvariantLock } from '../../utils/adminInvariantLock.js';
import { logAudit } from '../../services/AuditLogService.js';
import logger from '../../utils/logger.js';

const GROUPS_FILE = 'config/groups.json';
const USERS_FILE = 'config/users.json';

/** Most users one request may add to a group. */
const MAX_USERS_PER_REQUEST = 500;

/**
 * The member summary an admin sees: who the user is, never a credential.
 *
 * @param {string} id - Key of the user in users.json
 * @param {Object} user - The stored user
 * @returns {{id: string, username: string, name?: string, email?: string, active: boolean, authMethods: string[]}}
 */
function toMember(id, user) {
  return {
    id,
    username: user.username,
    ...(user.name ? { name: user.name } : {}),
    ...(user.email ? { email: user.email } : {}),
    active: user.active !== false,
    authMethods: Array.isArray(user.authMethods) ? user.authMethods : ['local']
  };
}

/** Whether a stored user lists `groupId` directly in its `internalGroups`. */
function isMember(user, groupId) {
  return Array.isArray(user?.internalGroups) && user.internalGroups.includes(groupId);
}

/**
 * Refuse a group that does not exist. Read strictly so an unreadable
 * `groups.json` is an error, not "no such group".
 *
 * @param {string} groupId
 * @throws {ServiceError} `NOT_FOUND`
 */
async function assertGroupExists(groupId) {
  const groupsData = await configStore.readJsonStrict(GROUPS_FILE);
  // Own-property check so names inherited from Object.prototype are not groups.
  if (!groupsData?.groups || !Object.hasOwn(groupsData.groups, groupId)) {
    throw new ServiceError('NOT_FOUND', 'Group not found');
  }
}

/**
 * Read `userIds` from a request body: a non-empty list of distinct user ids.
 *
 * @param {*} body
 * @returns {string[]}
 * @throws {ServiceError} `BAD_REQUEST`
 */
function parseUserIds(body) {
  const userIds = body?.userIds;
  if (!Array.isArray(userIds) || userIds.length === 0) {
    throw new ServiceError('BAD_REQUEST', 'userIds must be a non-empty list of user IDs');
  }
  if (userIds.length > MAX_USERS_PER_REQUEST) {
    throw new ServiceError(
      'BAD_REQUEST',
      `At most ${MAX_USERS_PER_REQUEST} users can be added in one request`
    );
  }
  for (const userId of userIds) {
    if (typeof userId !== 'string' || !userId) {
      throw new ServiceError('BAD_REQUEST', 'userIds must be a list of user IDs');
    }
    assertValidId(userId, 'user');
  }
  return [...new Set(userIds)];
}

/**
 * Admin routes for the members of a group.
 *
 * A local user belongs to a group through `internalGroups` in `users.json`.
 * These routes work on that list from the group's side, so an administrator
 * does not have to open every user. Members that sign in through an external
 * provider (OIDC, LDAP, proxy, …) can be listed too once they have a user
 * record; groups they get from the provider's own group claims, through
 * `mappings`, are not stored and not listed here.
 */
export default function registerAdminGroupMemberRoutes(app) {
  const membersPath = groupId => `/api/admin/groups/${segment(groupId)}/members`;

  /**
   * @swagger
   * /api/admin/groups/{groupId}/members:
   *   get:
   *     summary: List the users that are members of a group
   *     description: |
   *       Lists the users whose `internalGroups` contain the group, sorted by display name.
   *       Groups a user gets through external mappings or inheritance are not included.
   *     tags:
   *       - Admin
   *       - Groups
   *     security:
   *       - adminAuth: []
   *     parameters:
   *       - in: path
   *         name: groupId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The members, as `{ items }`
   *       404:
   *         description: Group not found
   */
  app.get(buildServerPath('/api/admin/groups/:groupId/members'), adminAuth, async (req, res) => {
    const { groupId } = req.params;
    assertValidId(groupId, 'group');
    await assertGroupExists(groupId);

    const usersData = await configStore.readJson(USERS_FILE);
    const items = Object.entries(usersData?.users || {})
      .filter(([, user]) => isMember(user, groupId))
      .map(([id, user]) => toMember(id, user))
      .sort((a, b) =>
        (a.name || a.username || a.id).localeCompare(b.name || b.username || b.id, undefined, {
          sensitivity: 'base'
        })
      );

    res.json({ items });
  });

  /**
   * @swagger
   * /api/admin/groups/{groupId}/members:
   *   post:
   *     summary: Add users to a group
   *     description: |
   *       Adds the users to the group (their `internalGroups`). Users that already are members
   *       are left alone. All users are checked first: if one does not exist, none is added.
   *     tags:
   *       - Admin
   *       - Groups
   *     security:
   *       - adminAuth: []
   *     parameters:
   *       - in: path
   *         name: groupId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [userIds]
   *             properties:
   *               userIds:
   *                 type: array
   *                 items:
   *                   type: string
   *     responses:
   *       201:
   *         description: The users that were added, as `{ items }`; `Location` is the member list
   *       400:
   *         description: `userIds` missing, empty or malformed
   *       404:
   *         description: The group, or one of the users, does not exist
   */
  app.post(buildServerPath('/api/admin/groups/:groupId/members'), adminAuth, async (req, res) => {
    const { groupId } = req.params;
    assertValidId(groupId, 'group');
    const userIds = parseUserIds(req.body);
    await assertGroupExists(groupId);

    const added = [];
    await configStore.updateJson(USERS_FILE, usersData => {
      const users = usersData?.users || {};
      const missing = userIds.filter(id => !Object.hasOwn(users, id));
      if (missing.length > 0) {
        throw new ServiceError('NOT_FOUND', `User not found: ${missing.join(', ')}`, {
          details: { userIds: missing }
        });
      }

      const now = new Date().toISOString();
      for (const id of userIds) {
        const user = users[id];
        if (isMember(user, groupId)) continue;
        user.internalGroups = [
          ...(Array.isArray(user.internalGroups) ? user.internalGroups : []),
          groupId
        ];
        user.updatedAt = now;
        added.push(toMember(id, user));
      }
      if (added.length === 0) return usersData;

      if (!usersData.metadata) usersData.metadata = { version: '2.0.0' };
      usersData.metadata.lastUpdated = now;
      return usersData;
    });

    if (added.length > 0) {
      await configCache.refreshCacheEntry(USERS_FILE);
      logger.info('Added users to group', {
        component: 'AdminGroups',
        groupId,
        count: added.length
      });
      await logAudit({
        req,
        action: 'update',
        resource: 'group',
        resourceId: groupId,
        summary: `Added ${added.length} user(s) to group ${groupId}: ${added
          .map(member => member.username)
          .join(', ')}`
      });
    }

    sendCreated(res, membersPath(groupId), { items: added });
  });

  /**
   * @swagger
   * /api/admin/groups/{groupId}/members/{userId}:
   *   delete:
   *     summary: Remove a user from a group
   *     description: |
   *       Removes the group from the user's `internalGroups`. Refused with 409 `LAST_ADMIN` or
   *       `SELF_LOCKOUT` when that would leave no administrator who can sign in.
   *     tags:
   *       - Admin
   *       - Groups
   *     security:
   *       - adminAuth: []
   *     parameters:
   *       - in: path
   *         name: groupId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: userId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       204:
   *         description: The user is no longer a member
   *       404:
   *         description: The group does not exist, or the user is not a member of it
   *       409:
   *         description: Refused with `LAST_ADMIN`
   */
  app.delete(
    buildServerPath('/api/admin/groups/:groupId/members/:userId'),
    adminAuth,
    async (req, res) => {
      const { groupId, userId } = req.params;
      assertValidId(groupId, 'group');
      assertValidId(userId, 'user');
      await assertGroupExists(groupId);

      let username;
      await withAdminInvariantLock(() =>
        configStore.updateJson(USERS_FILE, async usersData => {
          if (!usersData?.users || !Object.hasOwn(usersData.users, userId)) {
            throw new ServiceError('NOT_FOUND', 'User not found');
          }
          const target = usersData.users[userId];
          if (!isMember(target, groupId)) {
            throw new ServiceError('NOT_FOUND', 'The user is not a member of this group');
          }

          const usersBefore = structuredClone(usersData);
          target.internalGroups = target.internalGroups.filter(id => id !== groupId);
          username = target.username;

          // Removing the group that made someone an administrator must not leave
          // the platform without one: 409 LAST_ADMIN.
          await assertUserChangeKeepsAdmin(req.user, usersBefore, usersData, {
            userId,
            action: 'update'
          });

          target.updatedAt = new Date().toISOString();
          if (!usersData.metadata) usersData.metadata = { version: '2.0.0' };
          usersData.metadata.lastUpdated = target.updatedAt;
          return usersData;
        })
      );

      await configCache.refreshCacheEntry(USERS_FILE);
      logger.info('Removed user from group', { component: 'AdminGroups', groupId, userId });
      await logAudit({
        req,
        action: 'update',
        resource: 'group',
        resourceId: groupId,
        summary: `Removed user "${username}" from group ${groupId}`
      });

      res.status(204).end();
    }
  );
}
