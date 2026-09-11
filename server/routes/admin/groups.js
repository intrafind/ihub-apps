import configStore from '../../services/config/ConfigStore.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import logger from '../../utils/logger.js';
import {
  sendInternalError,
  sendNotFound,
  sendBadRequest,
  sendErrorResponse
} from '../../utils/responseHelpers.js';
import { logAudit } from '../../services/AuditLogService.js';
import { saveSnapshot } from '../../services/ChangeHistoryService.js';

/** The group configuration, as a path relative to `contents/`. */
const GROUPS_FILE = 'config/groups.json';

/**
 * The `{ id, name }` summaries a resource namespace holds.
 *
 * A document that does not parse is skipped and a namespace with no directory
 * yet reads as empty — both are how this endpoint has always behaved for
 * prompts and workflows, and now for apps and models too.
 *
 * @param {string} ns - Configuration namespace: apps, models, prompts, workflows
 * @returns {Promise<Array<{id: string, name: Object}>>} One summary per document
 */
async function listResourceSummaries(ns) {
  const documents = await configStore.listDocuments(ns);
  return documents.map(({ data }) => ({
    id: data?.id,
    name: data?.name || { en: data?.id, de: data?.id }
  }));
}

/**
 * Count groups that grant adminAccess. Used to prevent removing/demoting the
 * last group that can administer the platform.
 */
function countAdminAccessGroups(groups, excludeGroupId = null) {
  return Object.entries(groups || {}).filter(
    ([groupId, group]) => groupId !== excludeGroupId && group?.permissions?.adminAccess === true
  ).length;
}

/**
 * @swagger
 * components:
 *   schemas:
 *     GroupPermissions:
 *       type: object
 *       description: Permission settings for a user group
 *       properties:
 *         apps:
 *           type: array
 *           description: List of app IDs the group can access, or ['*'] for all apps
 *           items:
 *             type: string
 *           example: ["chat-assistant", "code-reviewer"]
 *         prompts:
 *           type: array
 *           description: List of prompt IDs the group can access, or ['*'] for all prompts
 *           items:
 *             type: string
 *           example: ["analysis", "creative-writing"]
 *         models:
 *           type: array
 *           description: List of model IDs the group can use, or ['*'] for all models
 *           items:
 *             type: string
 *           example: ["gpt-4", "claude-3"]
 *         adminAccess:
 *           type: boolean
 *           description: Whether the group has administrative access
 *           example: false
 *
 *     UserGroup:
 *       type: object
 *       description: User group configuration with permissions and external mappings
 *       required:
 *         - id
 *         - name
 *         - permissions
 *       properties:
 *         id:
 *           type: string
 *           description: Unique identifier for the group
 *           example: "developers"
 *         name:
 *           type: string
 *           description: Human-readable name for the group
 *           example: "Developers"
 *         description:
 *           type: string
 *           description: Optional description of the group's purpose
 *           example: "Software development team with code review access"
 *         permissions:
 *           $ref: '#/components/schemas/GroupPermissions'
 *         mappings:
 *           type: array
 *           description: External authentication provider group mappings
 *           items:
 *             type: string
 *           example: ["Dev-Team", "Developers-AD"]
 *         inherits:
 *           type: array
 *           description: Parent groups to inherit permissions from
 *           items:
 *             type: string
 *           example: ["authenticated"]
 *
 *     GroupsData:
 *       type: object
 *       description: Complete groups configuration file structure
 *       properties:
 *         groups:
 *           type: object
 *           description: Map of group ID to group configuration
 *           additionalProperties:
 *             $ref: '#/components/schemas/UserGroup'
 *         metadata:
 *           type: object
 *           description: Configuration metadata
 *           properties:
 *             version:
 *               type: string
 *               example: "1.0.0"
 *             description:
 *               type: string
 *               example: "Unified group configuration with permissions and external mappings"
 *             lastModified:
 *               type: string
 *               format: date-time
 *               example: "2024-01-15T10:30:00Z"
 *
 *     GroupResources:
 *       type: object
 *       description: Available resources for group permission configuration
 *       properties:
 *         apps:
 *           type: array
 *           description: Available applications
 *           items:
 *             type: object
 *             properties:
 *               id:
 *                 type: string
 *               name:
 *                 type: object
 *                 description: Localized names
 *         models:
 *           type: array
 *           description: Available AI models
 *           items:
 *             type: object
 *             properties:
 *               id:
 *                 type: string
 *               name:
 *                 type: object
 *                 description: Localized names
 *         prompts:
 *           type: array
 *           description: Available prompt templates
 *           items:
 *             type: object
 *             properties:
 *               id:
 *                 type: string
 *               name:
 *                 type: object
 *                 description: Localized names
 *
 *     GroupOperation:
 *       type: object
 *       description: Result of a group operation
 *       properties:
 *         message:
 *           type: string
 *           description: Operation result message
 *         group:
 *           $ref: '#/components/schemas/UserGroup'
 *           description: The affected group (for single operations)
 */

export default function registerAdminGroupRoutes(app) {
  /**
   * @swagger
   * /api/admin/groups:
   *   get:
   *     summary: Get all user groups and their configurations
   *     description: |
   *       Retrieves the complete groups configuration including all user groups,
   *       their permissions, inheritance settings, and external authentication mappings.
   *
   *       **Group System Features:**
   *       - Hierarchical permission inheritance
   *       - External authentication provider mappings
   *       - Granular permissions for apps, prompts, and models
   *       - Protected system groups (admin, user, anonymous, authenticated)
   *     tags:
   *       - Admin
   *       - Groups
   *       - Authentication
   *     security:
   *       - adminAuth: []
   *     responses:
   *       200:
   *         description: Groups configuration successfully retrieved
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/GroupsData'
   *             example:
   *               groups:
   *                 admin:
   *                   id: "admin"
   *                   name: "Administrators"
   *                   description: "Full administrative access"
   *                   permissions:
   *                     apps: ["*"]
   *                     prompts: ["*"]
   *                     models: ["*"]
   *                     adminAccess: true
   *                   mappings: ["Admins", "IT-Admin"]
   *                   inherits: ["users"]
   *                 developers:
   *                   id: "developers"
   *                   name: "Developers"
   *                   description: "Software development team"
   *                   permissions:
   *                     apps: ["code-reviewer", "documentation"]
   *                     prompts: ["analysis", "code-review"]
   *                     models: ["gpt-4", "claude-3"]
   *                     adminAccess: false
   *                   mappings: ["Dev-Team"]
   *                   inherits: ["authenticated"]
   *               metadata:
   *                 version: "1.0.0"
   *                 description: "Unified group configuration"
   *                 lastModified: "2024-01-15T10:30:00Z"
   *       401:
   *         description: Authentication required
   *       403:
   *         description: Admin access required
   *       500:
   *         description: Failed to load groups configuration
   */
  app.get(buildServerPath('/api/admin/groups'), adminAuth, async (req, res) => {
    try {
      // Strict, so an unreadable file is not rendered as an empty one. The
      // write path already fails closed, but an admin page showing no groups
      // over a `groups.json` with a trailing comma in it says the permissions
      // are gone rather than that the file cannot be parsed — and the first
      // thing it invites is a save.
      let groupsData = await configStore.readJsonStrict(GROUPS_FILE);
      if (!groupsData) {
        logger.info('Groups file not found, returning empty list', {
          component: 'AdminGroups'
        });
        groupsData = { groups: {}, metadata: {} };
      }

      res.json(groupsData);
    } catch (error) {
      return sendInternalError(res, error, 'get groups');
    }
  });

  /**
   * @swagger
   * /api/admin/groups/resources:
   *   get:
   *     summary: Get available resources for group permission configuration
   *     description: |
   *       Retrieves lists of available apps, models, and prompts that can be used
   *       when configuring group permissions. This endpoint provides the data needed
   *       for dropdown menus and permission selection interfaces in admin UI.
   *
   *       **Resource Types:**
   *       - Apps: Available applications that groups can be granted access to
   *       - Models: AI models that groups can be authorized to use
   *       - Prompts: Prompt templates that groups can access
   *     tags:
   *       - Admin
   *       - Groups
   *       - Resources
   *     security:
   *       - adminAuth: []
   *     responses:
   *       200:
   *         description: Available resources successfully retrieved
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/GroupResources'
   *             example:
   *               apps:
   *                 - id: "chat-assistant"
   *                   name:
   *                     en: "Chat Assistant"
   *                     de: "Chat-Assistent"
   *                 - id: "code-reviewer"
   *                   name:
   *                     en: "Code Reviewer"
   *               models:
   *                 - id: "gpt-4"
   *                   name:
   *                     en: "GPT-4"
   *                 - id: "claude-3"
   *                   name:
   *                     en: "Claude 3"
   *               prompts:
   *                 - id: "analysis"
   *                   name:
   *                     en: "Analysis Helper"
   *                 - id: "creative-writing"
   *                   name:
   *                     en: "Creative Writing"
   *       500:
   *         description: Failed to load resources
   */
  app.get(buildServerPath('/api/admin/groups/resources'), adminAuth, async (req, res) => {
    try {
      const apps = await listResourceSummaries('apps');
      const models = await listResourceSummaries('models');
      const prompts = await listResourceSummaries('prompts');
      const workflows = await listResourceSummaries('workflows');

      // Get skills
      const { data: allSkills } = configCache.getSkills();
      const skills = (allSkills || []).map(skill => ({
        id: skill.name,
        name: { en: skill.displayName || skill.name, de: skill.displayName || skill.name }
      }));

      res.json({
        apps: apps.sort((a, b) => a.id.localeCompare(b.id)),
        models: models.sort((a, b) => a.id.localeCompare(b.id)),
        prompts: prompts.sort((a, b) => a.id.localeCompare(b.id)),
        workflows: workflows.sort((a, b) => a.id.localeCompare(b.id)),
        skills: skills.sort((a, b) => a.id.localeCompare(b.id))
      });
    } catch (error) {
      return sendInternalError(res, error, 'get resources');
    }
  });

  /**
   * @swagger
   * /api/admin/groups:
   *   post:
   *     summary: Create a new user group
   *     description: |
   *       Creates a new user group with specified permissions and external mappings.
   *       The group configuration is validated and saved to the groups file, and
   *       the cache is refreshed.
   *
   *       **Validation Rules:**
   *       - Group ID must be unique
   *       - Group ID and name are required
   *       - Permissions object must be valid
   *       - External mappings are optional
   *     tags:
   *       - Admin
   *       - Groups
   *     security:
   *       - adminAuth: []
   *     requestBody:
   *       required: true
   *       description: New group configuration
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - id
   *               - name
   *               - permissions
   *             properties:
   *               id:
   *                 type: string
   *                 description: Unique group identifier
   *                 example: "qa-team"
   *               name:
   *                 type: string
   *                 description: Human-readable group name
   *                 example: "QA Team"
   *               description:
   *                 type: string
   *                 description: Optional group description
   *                 example: "Quality Assurance team with testing permissions"
   *               permissions:
   *                 $ref: '#/components/schemas/GroupPermissions'
   *               mappings:
   *                 type: array
   *                 description: External authentication provider mappings
   *                 items:
   *                   type: string
   *                 example: ["QA-Team", "Testers"]
   *           example:
   *             id: "qa-team"
   *             name: "QA Team"
   *             description: "Quality Assurance team with testing permissions"
   *             permissions:
   *               apps: ["test-runner", "bug-tracker"]
   *               prompts: ["test-case-generation"]
   *               models: ["gpt-3.5-turbo"]
   *               adminAccess: false
   *             mappings: ["QA-Team", "Testers"]
   *     responses:
   *       200:
   *         description: Group successfully created
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/GroupOperation'
   *       400:
   *         description: Bad request - validation error
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 error:
   *                   type: string
   *             examples:
   *               missingFields:
   *                 value:
   *                   error: "Group ID and name are required"
   *               invalidPermissions:
   *                 value:
   *                   error: "Valid permissions object is required"
   *       409:
   *         description: Conflict - group ID already exists
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 error:
   *                   type: string
   *             example:
   *               error: "Group ID already exists"
   *       500:
   *         description: Failed to create group
   */
  app.post(buildServerPath('/api/admin/groups'), adminAuth, async (req, res) => {
    try {
      const { id, name, description, permissions, mappings = [], inherits = [] } = req.body;

      if (!id || !name) {
        return sendBadRequest(res, 'Group ID and name are required');
      }

      // Validate group ID for security
      if (!validateIdForPath(id, 'group', res)) {
        return;
      }

      // Validate permissions structure
      if (!permissions || typeof permissions !== 'object') {
        return sendBadRequest(res, 'Valid permissions object is required');
      }

      // No group file yet is the first-run case: start the structure here.
      const groupsData = (await configStore.readJsonStrict(GROUPS_FILE)) || {
        groups: {},
        metadata: {
          version: '1.0.0',
          description: 'Unified group configuration with permissions and external mappings',
          lastModified: new Date().toISOString()
        }
      };

      // Check if group ID already exists (own-property check so names inherited
      // from Object.prototype, e.g. "hasOwnProperty", can't be mistaken for a group)
      if (Object.hasOwn(groupsData.groups, id)) {
        return sendErrorResponse(res, 409, 'Group ID already exists');
      }

      // Create new group
      const newGroup = {
        id,
        name,
        description: description || '',
        permissions: {
          apps: Array.isArray(permissions.apps) ? permissions.apps : [],
          prompts: Array.isArray(permissions.prompts) ? permissions.prompts : [],
          models: Array.isArray(permissions.models) ? permissions.models : [],
          workflows: Array.isArray(permissions.workflows) ? permissions.workflows : [],
          adminAccess: Boolean(permissions.adminAccess)
        },
        mappings: Array.isArray(mappings) ? mappings : [],
        inherits: Array.isArray(inherits) ? inherits : []
      };

      groupsData.groups[id] = newGroup;
      groupsData.metadata.lastModified = new Date().toISOString();

      // Save to file
      await configStore.writeJson(GROUPS_FILE, groupsData);

      // Refresh cache
      await configCache.refreshCacheEntry('config/groups.json');

      logger.info('Created new group', { component: 'AdminGroups', name, id });

      await logAudit({
        req,
        action: 'create',
        resource: 'group',
        resourceId: id,
        summary: `Created group ${id}`
      });
      res.json({ group: newGroup });
    } catch (error) {
      return sendInternalError(res, error, 'create group');
    }
  });

  /**
   * @swagger
   * /api/admin/groups/{groupId}:
   *   put:
   *     summary: Update an existing user group
   *     description: |
   *       Updates an existing user group's configuration including name, description,
   *       permissions, and external mappings. Only provided fields are updated,
   *       other fields remain unchanged.
   *     tags:
   *       - Admin
   *       - Groups
   *     security:
   *       - adminAuth: []
   *     parameters:
   *       - in: path
   *         name: groupId
   *         required: true
   *         description: Unique identifier of the group to update
   *         schema:
   *           type: string
   *           example: "developers"
   *     requestBody:
   *       required: true
   *       description: Updated group configuration (partial update)
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               name:
   *                 type: string
   *                 description: Updated group name
   *               description:
   *                 type: string
   *                 description: Updated group description
   *               permissions:
   *                 $ref: '#/components/schemas/GroupPermissions'
   *               mappings:
   *                 type: array
   *                 description: Updated external mappings
   *                 items:
   *                   type: string
   *           example:
   *             name: "Senior Developers"
   *             description: "Senior development team with extended permissions"
   *             permissions:
   *               apps: ["*"]
   *               prompts: ["*"]
   *               models: ["gpt-4", "claude-3"]
   *               adminAccess: false
   *             mappings: ["Senior-Devs", "Lead-Developers"]
   *     responses:
   *       200:
   *         description: Group successfully updated
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/GroupOperation'
   *       404:
   *         description: Group not found
   *       500:
   *         description: Failed to update group
   */
  app.put(buildServerPath('/api/admin/groups/:groupId'), adminAuth, async (req, res) => {
    try {
      const { groupId } = req.params;

      // Validate groupId for security (prevents prototype pollution)
      if (!validateIdForPath(groupId, 'group', res)) {
        return;
      }

      const { name, description, permissions, mappings, inherits } = req.body;

      const groupsData = await configStore.readJsonStrict(GROUPS_FILE);
      if (!groupsData) {
        return sendNotFound(res, 'Groups file');
      }

      // Check if group exists (own-property check so names inherited from
      // Object.prototype, e.g. "hasOwnProperty", can't be mistaken for a group)
      if (!Object.hasOwn(groupsData.groups, groupId)) {
        return sendNotFound(res, 'Group');
      }

      const group = groupsData.groups[groupId];
      const oldGroup = JSON.parse(JSON.stringify(group));

      // Update fields
      if (name !== undefined) group.name = name;
      if (description !== undefined) group.description = description;
      if (mappings !== undefined) group.mappings = Array.isArray(mappings) ? mappings : [];
      if (inherits !== undefined) group.inherits = Array.isArray(inherits) ? inherits : [];

      // Update permissions
      if (permissions !== undefined && typeof permissions === 'object') {
        const newAdminAccess =
          permissions.adminAccess !== undefined
            ? Boolean(permissions.adminAccess)
            : group.permissions.adminAccess || false;

        // Prevent stripping adminAccess from the last group that grants it,
        // which would lock every admin out of the platform.
        if (group.permissions?.adminAccess === true && newAdminAccess !== true) {
          const remainingAdminGroups = countAdminAccessGroups(groupsData.groups, groupId);
          if (remainingAdminGroups === 0) {
            return sendBadRequest(
              res,
              `Cannot remove administrative access from group '${groupId}': it is the only group with administrative access`
            );
          }
        }

        group.permissions = {
          apps: Array.isArray(permissions.apps) ? permissions.apps : group.permissions.apps || [],
          prompts: Array.isArray(permissions.prompts)
            ? permissions.prompts
            : group.permissions.prompts || [],
          models: Array.isArray(permissions.models)
            ? permissions.models
            : group.permissions.models || [],
          workflows: Array.isArray(permissions.workflows)
            ? permissions.workflows
            : group.permissions.workflows || [],
          adminAccess: newAdminAccess
        };
      }

      groupsData.metadata.lastModified = new Date().toISOString();

      // Save to file
      await configStore.writeJson(GROUPS_FILE, groupsData);

      // Refresh cache
      await configCache.refreshCacheEntry('config/groups.json');

      logger.info('Updated group', { component: 'AdminGroups', groupName: group.name, groupId });

      await saveSnapshot({
        resource: 'group',
        id: groupId,
        before: oldGroup,
        after: group,
        admin: req.user?.username ?? req.user?.name ?? req.user?.id ?? 'unknown'
      });
      await logAudit({
        req,
        action: 'update',
        resource: 'group',
        resourceId: groupId,
        summary: `Updated group ${groupId}`
      });
      res.json({ group });
    } catch (error) {
      return sendInternalError(res, error, 'update group');
    }
  });

  /**
   * @swagger
   * /api/admin/groups/{groupId}:
   *   delete:
   *     summary: Delete a user group
   *     description: |
   *       Permanently deletes a user group and its configuration.
   *       Protected system groups (admins, users, anonymous, authenticated) cannot be deleted
   *       to maintain system integrity. Additionally, the last remaining group that grants
   *       adminAccess cannot be deleted, to prevent locking all admins out of the platform.
   *
   *       **Protected Groups:**
   *       The following system groups are protected and cannot be deleted:
   *       - admins: Administrative access group
   *       - users: Standard user group
   *       - anonymous: Anonymous access group
   *       - authenticated: Base authenticated user group
   *     tags:
   *       - Admin
   *       - Groups
   *     security:
   *       - adminAuth: []
   *     parameters:
   *       - in: path
   *         name: groupId
   *         required: true
   *         description: Unique identifier of the group to delete
   *         schema:
   *           type: string
   *           example: "old-team"
   *     responses:
   *       200:
   *         description: Group successfully deleted
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *             example:
   *               message: "Group deleted successfully"
   *       400:
   *         description: Bad request - cannot delete protected group
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 error:
   *                   type: string
   *             example:
   *               error: "Cannot delete protected system group: admins"
   *       404:
   *         description: Group not found
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 error:
   *                   type: string
   *             example:
   *               error: "Group not found"
   *       500:
   *         description: Failed to delete group
   */
  app.delete(buildServerPath('/api/admin/groups/:groupId'), adminAuth, async (req, res) => {
    try {
      const { groupId } = req.params;

      // Validate groupId for security (prevents prototype pollution)
      if (!validateIdForPath(groupId, 'group', res)) {
        return;
      }

      // Prevent deletion of core system groups
      const protectedGroups = ['admins', 'users', 'anonymous', 'authenticated'];
      if (protectedGroups.includes(groupId)) {
        return sendBadRequest(res, `Cannot delete protected system group: ${groupId}`);
      }

      const groupsData = await configStore.readJsonStrict(GROUPS_FILE);
      if (!groupsData) {
        return sendNotFound(res, 'Groups file');
      }

      // Check if group exists (own-property check so names inherited from
      // Object.prototype, e.g. "hasOwnProperty", can't be mistaken for a group)
      if (!Object.hasOwn(groupsData.groups, groupId)) {
        return sendNotFound(res, 'Group');
      }

      const deletedGroup = groupsData.groups[groupId];
      const groupName = deletedGroup.name;

      // Prevent deleting the last group that grants adminAccess, which would
      // lock every admin out of the platform.
      if (deletedGroup.permissions?.adminAccess === true) {
        const remainingAdminGroups = countAdminAccessGroups(groupsData.groups, groupId);
        if (remainingAdminGroups === 0) {
          return sendBadRequest(
            res,
            `Cannot delete group '${groupId}': it is the only group with administrative access`
          );
        }
      }

      // Save snapshot before deletion
      await saveSnapshot({
        resource: 'group',
        id: groupId,
        before: deletedGroup,
        after: null,
        admin: req.user?.username ?? req.user?.name ?? req.user?.id ?? 'unknown'
      });

      // Remove group
      delete groupsData.groups[groupId];
      groupsData.metadata.lastModified = new Date().toISOString();

      // Save to file
      await configStore.writeJson(GROUPS_FILE, groupsData);

      // Refresh cache
      await configCache.refreshCacheEntry('config/groups.json');

      logger.info('Deleted group', { component: 'AdminGroups', groupName, groupId });

      await logAudit({
        req,
        action: 'delete',
        resource: 'group',
        resourceId: groupId,
        summary: `Deleted group ${groupId}`
      });
      res.json({ message: 'Group deleted successfully' });
    } catch (error) {
      return sendInternalError(res, error, 'delete group');
    }
  });
}
