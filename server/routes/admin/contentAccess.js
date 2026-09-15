import configStore from '../../services/config/ConfigStore.js';
import configCache from '../../configCache.js';
import { contentAdminAuth } from '../../middleware/contentAdminAuth.js';
import { isAdminAuthRequired } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { validateIdForPath, isValidId } from '../../utils/pathSecurity.js';
import { findByIdCaseInsensitive } from '../../utils/resourceLookup.js';
import logger from '../../utils/logger.js';
import {
  sendInternalError,
  sendNotFound,
  sendBadRequest,
  sendErrorResponse
} from '../../utils/responseHelpers.js';
import { logAudit } from '../../services/AuditLogService.js';
import { saveSnapshot } from '../../services/ChangeHistoryService.js';
import {
  CONTENT_ACCESS_TYPES,
  ContentAccessError,
  applyContentAccessChanges,
  describeContentAccess,
  isContentAccessType,
  resolveManageableGroups
} from '../../utils/contentAccess.js';

/** The group configuration, as a path relative to `contents/`. */
const GROUPS_FILE = 'config/groups.json';

/**
 * Find the configured content behind `type`/`id`, so the route can refuse an
 * id nobody configured and write the id exactly as it is configured (the lists
 * are matched case-insensitively at runtime, but the file should still read
 * the way the admin spelled it).
 *
 * Skills have no `id`; their permission entry is the skill `name`, which is
 * also what `getSkillsForUser` filters on.
 *
 * @param {string} type - One of CONTENT_ACCESS_TYPES
 * @param {string} id - Requested id, any casing
 * @returns {{ id: string } | undefined}
 */
function findContent(type, id) {
  switch (type) {
    case 'apps':
      return findByIdCaseInsensitive(configCache.getApps(true)?.data, id);
    case 'prompts':
      return findByIdCaseInsensitive(configCache.getPrompts(true)?.data, id);
    case 'workflows':
      return findByIdCaseInsensitive(configCache.getWorkflows(true)?.data, id);
    case 'tools':
      return findByIdCaseInsensitive(configCache.getTools(true)?.data, id);
    case 'skills': {
      const target = id.toLowerCase();
      const skill = (configCache.getSkills()?.data || []).find(
        entry => typeof entry?.name === 'string' && entry.name.toLowerCase() === target
      );
      return skill ? { id: skill.name } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Validate `:type` and `:id` and resolve the content. Answers the request
 * itself when something is wrong and returns null.
 */
function resolveTarget(req, res) {
  const { type, id } = req.params;
  if (!isContentAccessType(type)) {
    sendBadRequest(
      res,
      `Unknown content type '${type}'. Expected one of: ${CONTENT_ACCESS_TYPES.join(', ')}`
    );
    return null;
  }
  if (!validateIdForPath(id, type.slice(0, -1), res)) {
    return null;
  }
  const content = findContent(type, id);
  if (!content) {
    sendNotFound(res, `${type.slice(0, -1)} '${id}'`);
    return null;
  }
  return { type, contentId: content.id };
}

/**
 * The groups every signed-in user carries without being a member of them.
 * `enhanceUserGroups` adds the configured authenticated group to everyone;
 * anonymous defaults come from `anonymousAuth`. Neither is membership in the
 * sense of "the groups a content admin is part of".
 */
function implicitGroups() {
  const authenticatedGroup = configCache.getPlatform()?.auth?.authenticatedGroup || 'authenticated';
  return Array.from(new Set([authenticatedGroup, 'authenticated', 'anonymous']));
}

/**
 * Which groups the caller may change, and the view of them for this content.
 *
 * @returns {{ manageableIds: string[], view: object }} The ids the caller may
 *   change, and the response body describing them
 */
function buildView(req, groupsData, type, contentId) {
  const groups = groupsData.groups || {};
  const { scope, groupIds } = resolveManageableGroups({
    groups,
    user: req.user,
    // The same rule adminAuth applies: adminAccess through a group, and an
    // eligible principal (no API keys, OAuth clients or agents).
    fullAdmin: !isAdminAuthRequired(req),
    implicitGroups: implicitGroups()
  });
  return {
    manageableIds: groupIds,
    view: {
      type,
      id: contentId,
      scope,
      groups: describeContentAccess({ groups, type, contentId, groupIds })
    }
  };
}

/**
 * @swagger
 * components:
 *   schemas:
 *     ContentAccessGroup:
 *       type: object
 *       description: How one group stands towards one piece of content
 *       properties:
 *         id:
 *           type: string
 *           example: "sales"
 *         name:
 *           type: string
 *           example: "Sales"
 *         description:
 *           type: string
 *         granted:
 *           type: boolean
 *           description: The group's own permission list names this content
 *         wildcard:
 *           type: boolean
 *           description: The group's own list grants every item of this type (`*`)
 *         inheritedFrom:
 *           type: array
 *           description: Parent groups whose own lists grant this content
 *           items:
 *             type: string
 *         effective:
 *           type: boolean
 *           description: Members of the group can use the content, by any of the above
 *     ContentAccess:
 *       type: object
 *       properties:
 *         type:
 *           type: string
 *           enum: [apps, prompts, skills, tools, workflows]
 *         id:
 *           type: string
 *           description: The content id as configured
 *         scope:
 *           type: string
 *           enum: [all, membership]
 *           description: >
 *             `all` for a full admin (every group is listed), `membership` for a
 *             content admin (only the groups they belong to and the groups
 *             inheriting from those are listed).
 *         groups:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/ContentAccessGroup'
 */
export default function registerAdminContentAccessRoutes(app) {
  /**
   * @swagger
   * /api/admin/content-access/{type}/{id}:
   *   get:
   *     summary: Which groups can use an app, prompt, skill, tool or workflow
   *     description: |
   *       The content-first view of the group permission lists in `groups.json`.
   *
   *       A full admin sees every group. A content admin sees only the groups
   *       they are a member of plus the groups that inherit from those — the
   *       groups whose access they may change. The `authenticated` and
   *       `anonymous` groups every user carries implicitly do not count as
   *       membership.
   *     tags:
   *       - Admin
   *       - Groups
   *     security:
   *       - contentAdminAuth: []
   *     parameters:
   *       - in: path
   *         name: type
   *         required: true
   *         schema:
   *           type: string
   *           enum: [apps, prompts, skills, tools, workflows]
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         example: "chat"
   *     responses:
   *       200:
   *         description: The groups the caller may manage, with their access to this content
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ContentAccess'
   *       400:
   *         description: Unknown content type or invalid id
   *       403:
   *         description: Content admin access required
   *       404:
   *         description: No such content
   */
  app.get(
    buildServerPath('/api/admin/content-access/:type/:id'),
    contentAdminAuth,
    async (req, res) => {
      try {
        const target = resolveTarget(req, res);
        if (!target) return;

        const groupsData = await configStore.readJsonStrict(GROUPS_FILE);
        if (!groupsData?.groups) {
          return sendNotFound(res, 'Groups file');
        }

        const { view } = buildView(req, groupsData, target.type, target.contentId);
        res.json(view);
      } catch (error) {
        return sendInternalError(res, error, 'get content access');
      }
    }
  );

  /**
   * @swagger
   * /api/admin/content-access/{type}/{id}:
   *   put:
   *     summary: Grant or revoke an app, prompt, skill, tool or workflow for groups
   *     description: |
   *       Adds the content to, or removes it from, the named groups' own
   *       permission lists. The request is checked as a whole before anything
   *       is written: a group outside the caller's scope (403), an unknown
   *       group (404) or a revoke from a group that holds a wildcard (400)
   *       leaves every group untouched.
   *
   *       Each changed group gets a change-history snapshot and an audit entry,
   *       exactly as an edit in the group editor would.
   *     tags:
   *       - Admin
   *       - Groups
   *     security:
   *       - contentAdminAuth: []
   *     parameters:
   *       - in: path
   *         name: type
   *         required: true
   *         schema:
   *           type: string
   *           enum: [apps, prompts, skills, tools, workflows]
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               grant:
   *                 type: array
   *                 description: Group ids that should be able to use the content
   *                 items:
   *                   type: string
   *               revoke:
   *                 type: array
   *                 description: Group ids that should no longer be able to
   *                 items:
   *                   type: string
   *           example:
   *             grant: ["sales"]
   *             revoke: ["marketing"]
   *     responses:
   *       200:
   *         description: The updated view, plus the ids of the groups that changed
   *         content:
   *           application/json:
   *             schema:
   *               allOf:
   *                 - $ref: '#/components/schemas/ContentAccess'
   *                 - type: object
   *                   properties:
   *                     changed:
   *                       type: array
   *                       items:
   *                         type: string
   *       400:
   *         description: Malformed request, or a revoke from a wildcard group
   *       403:
   *         description: A named group is not one the caller may change
   *       404:
   *         description: No such content or group
   */
  app.put(
    buildServerPath('/api/admin/content-access/:type/:id'),
    contentAdminAuth,
    async (req, res) => {
      try {
        const target = resolveTarget(req, res);
        if (!target) return;

        const { grant = [], revoke = [] } = req.body || {};
        if (!Array.isArray(grant) || !Array.isArray(revoke)) {
          return sendBadRequest(res, "'grant' and 'revoke' must be arrays of group ids");
        }
        const invalid = [...grant, ...revoke].find(groupId => !isValidId(groupId));
        if (invalid !== undefined) {
          return sendBadRequest(
            res,
            'Invalid group ID. Only alphanumeric characters, dots, underscores, and hyphens are allowed.'
          );
        }

        const groupsData = await configStore.readJsonStrict(GROUPS_FILE);
        if (!groupsData?.groups) {
          return sendNotFound(res, 'Groups file');
        }

        const { manageableIds } = buildView(req, groupsData, target.type, target.contentId);

        let changes;
        try {
          changes = applyContentAccessChanges({
            groups: groupsData.groups,
            type: target.type,
            contentId: target.contentId,
            grant,
            revoke,
            manageableIds
          });
        } catch (error) {
          if (error instanceof ContentAccessError) {
            return sendErrorResponse(res, error.status, error.message);
          }
          throw error;
        }

        if (changes.length > 0) {
          groupsData.metadata = {
            ...(groupsData.metadata || {}),
            lastModified: new Date().toISOString()
          };
          await configStore.writeJson(GROUPS_FILE, groupsData);
          await configCache.refreshCacheEntry(GROUPS_FILE);

          const admin = req.user?.username ?? req.user?.name ?? req.user?.id ?? 'unknown';
          const noun = target.type.slice(0, -1);
          for (const change of changes) {
            await saveSnapshot({
              resource: 'group',
              id: change.groupId,
              before: change.before,
              after: change.after,
              admin
            });
            await logAudit({
              req,
              action: 'update',
              resource: 'group',
              resourceId: change.groupId,
              summary:
                change.action === 'grant'
                  ? `Granted ${noun} ${target.contentId} to group ${change.groupId}`
                  : `Revoked ${noun} ${target.contentId} from group ${change.groupId}`
            });
          }

          logger.info('Updated content access', {
            component: 'AdminContentAccess',
            type: target.type,
            contentId: target.contentId,
            changed: changes.map(change => `${change.action}:${change.groupId}`)
          });
        }

        // Re-read the view from the (possibly updated) data so the response
        // reflects exactly what was written.
        const { view } = buildView(req, groupsData, target.type, target.contentId);
        res.json({ ...view, changed: changes.map(change => change.groupId) });
      } catch (error) {
        return sendInternalError(res, error, 'update content access');
      }
    }
  );
}
