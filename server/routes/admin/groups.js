// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configStore from '../../services/config/ConfigStore.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { assertValidId } from '../../utils/pathSecurity.js';
import { ServiceError } from '../../utils/ServiceError.js';
import logger from '../../utils/logger.js';
import { logAudit } from '../../services/AuditLogService.js';
import { saveSnapshot } from '../../services/ChangeHistoryService.js';
import { parseUsageLimitsInput } from '../../validators/common.js';
import { resolveGroupInheritance } from '../../utils/authorization.js';
import { PROTECTED_GROUP_IDS } from '../../utils/protectedGroups.js';

/** The group configuration, as a path relative to `contents/`. */
const GROUPS_FILE = 'config/groups.json';

/**
 * Check the `inherits` list of one group against the whole group map.
 *
 * A saved group that names a missing parent, or closes a cycle, makes
 * `loadGroupsConfiguration()` throw on the next load — so it is refused here,
 * before it is written. The cycle and missing-parent rules are the resolver's
 * own (`resolveGroupInheritance`), not a second copy of them.
 *
 * @param {Object<string, Object>} groups - Every group by id, with the group being saved already in place
 * @param {string} groupId - The group being saved
 * @returns {string|null} A message for the admin, or `null` when the inheritance is valid
 */
function validateGroupInheritance(groups, groupId) {
  const inherits = groups[groupId]?.inherits;
  if (inherits === undefined || inherits.length === 0) return null;

  for (const parentId of inherits) {
    if (typeof parentId !== 'string' || !parentId) {
      return 'Inherited groups must be a list of group IDs';
    }
    // Own-property check: "constructor" and the like are not groups.
    if (!Object.hasOwn(groups, parentId)) {
      return `Parent group not found: ${parentId}`;
    }
    if (parentId === groupId) {
      return `Group '${groupId}' cannot inherit from itself`;
    }
  }

  try {
    resolveGroupInheritance({ groups });
  } catch (error) {
    return `Invalid group inheritance: ${error.message}`;
  }
  return null;
}

/**
 * Normalize a request's `inherits` value: a list of distinct group ids.
 * Anything that is not an array becomes an empty list.
 *
 * @param {*} inherits - The value from the request body
 * @returns {Array} The list without duplicates; non-string entries are kept so validation can name them
 */
function normalizeInherits(inherits) {
  return Array.isArray(inherits) ? [...new Set(inherits)] : [];
}

/**
 * The ``{ id, name }` summaries a resource namespace holds.
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
 * Normalize an incoming group `permissions` object.
 *
 * Both the create and update handlers rebuild this object field by field, so
 * anything missing from the list is silently dropped on every admin save —
 * that is how `skills` disappeared from groups that an
 * admin merely opened and saved. Keep every permission the authorization layer
 * reads (`utils/authorization.js`) in ONE place so adding the next one cannot
 * regress the others.
 *
 * @param {object} incoming - `permissions` from the request body.
 * @param {object} [existing] - Current permissions, used as the fallback for
 *   list fields the caller omitted. Empty for newly created groups.
 * @param {boolean} [adminAccess] - Resolved adminAccess (the update handler
 *   computes it separately because of the last-admin-group guard).
 */
function normalizeGroupPermissions(incoming = {}, existing = {}, adminAccess = undefined) {
  const list = key => (Array.isArray(incoming[key]) ? incoming[key] : existing[key] || []);
  return {
    apps: list('apps'),
    prompts: list('prompts'),
    models: list('models'),
    workflows: list('workflows'),
    skills: list('skills'),
    integrations: list('integrations'),
    adminAccess:
      adminAccess !== undefined
        ? adminAccess
        : Boolean(incoming.adminAccess ?? existing.adminAccess),
    contentAdmin: Boolean(incoming.contentAdmin ?? existing.contentAdmin),
    scheduledTasks: Boolean(incoming.scheduledTasks ?? existing.scheduledTasks),
    projects: Boolean(incoming.projects ?? existing.projects),
    projectSharing: Boolean(incoming.projectSharing ?? existing.projectSharing)
  };
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
 *         workflows:
 *           type: array
 *           description: List of workflow IDs the group can run, or ['*'] for all workflows
 *           items:
 *             type: string
 *           example: ["document-analysis"]
 *         skills:
 *           type: array
 *           description: List of agent skill names the group can use, or ['*'] for all skills
 *           items:
 *             type: string
 *           example: ["*"]
 *         integrations:
 *           type: array
 *           description: >
 *             Installed integrations members may use, or ['*'] for all of them (the ones
 *             installed later included). An entry is an installation id (`x500bund`), a
 *             definition id (every installation of it, `com.intrafind/ldap-directory`) or a
 *             type key (every installation of that type, `type:people-directory`,
 *             `type:web-search`, `type:storage`). Checked on top of every app binding:
 *             an app that binds an installation offers it only to members of a group
 *             that grants it. Inherited like `apps`.
 *           items:
 *             type: string
 *           example: ["type:web-search", "x500bund"]
 *         adminAccess:
 *           type: boolean
 *           description: Whether the group has administrative access
 *           example: false
 *         contentAdmin:
 *           type: boolean
 *           description: Whether the group can administer content without full admin access
 *           example: false
 *         scheduledTasks:
 *           type: boolean
 *           description: Whether members may create and run scheduled tasks
 *           example: true
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
   *                 admins:
   *                   id: "admins"
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
   *               inherits:
   *                 type: array
   *                 description: |
   *                   IDs of the parent groups this group inherits permissions from.
   *                   Every ID must be an existing group and the chain must not form a cycle.
   *                 items:
   *                   type: string
   *                 example: ["users"]
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
    const {
      id,
      name,
      description,
      permissions,
      mappings = [],
      inherits = [],
      usageLimits
    } = req.body;
    const limits = usageLimits === undefined ? null : parseUsageLimitsInput(usageLimits);
    if (limits && !limits.ok) throw new ServiceError('BAD_REQUEST', limits.error);

    if (!id || !name) {
      throw new ServiceError('BAD_REQUEST', 'Group ID and name are required');
    }

    // Validate group ID for security
    assertValidId(id, 'group');

    // Validate permissions structure
    if (!permissions || typeof permissions !== 'object') {
      throw new ServiceError('BAD_REQUEST', 'Valid permissions object is required');
    }

    // Read, check and write as one locked step: two creates (or a create and
    // an edit) racing on a read-then-write would each drop the other's change.
    // No group file yet is the first-run case: start the structure here.
    let newGroup;
    await configStore.updateJson(GROUPS_FILE, current => {
      const groupsData = current || {
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
        throw new ServiceError('CONFLICT', 'Group ID already exists');
      }

      // Create new group
      newGroup = {
        id,
        name,
        description: description || '',
        permissions: normalizeGroupPermissions(permissions),
        mappings: Array.isArray(mappings) ? mappings : [],
        inherits: normalizeInherits(inherits),
        ...(limits?.value ? { usageLimits: limits.value } : {})
      };

      groupsData.groups[id] = newGroup;
      const inheritanceError = validateGroupInheritance(groupsData.groups, id);
      if (inheritanceError) throw new ServiceError('BAD_REQUEST', inheritanceError);
      groupsData.metadata.lastModified = new Date().toISOString();
      return groupsData;
    });

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
    res.json(newGroup);
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
   *               inherits:
   *                 type: array
   *                 description: |
   *                   Updated parent group IDs. Every ID must be an existing group and the chain
   *                   must not form a cycle; otherwise the request is rejected with 400.
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
    const { groupId } = req.params;

    // Validate groupId for security (prevents prototype pollution)
    assertValidId(groupId, 'group');

    const { name, description, permissions, mappings, inherits, usageLimits } = req.body;
    const limits = usageLimits === undefined ? null : parseUsageLimitsInput(usageLimits);
    if (limits && !limits.ok) throw new ServiceError('BAD_REQUEST', limits.error);

    // Check, change and write on the body read under the lock, so the
    // last-admin-group guard sees the groups as they are now and an edit
    // cannot overwrite a concurrent create, delete or content-access change.
    let group;
    let oldGroup;
    await configStore.updateJson(GROUPS_FILE, groupsData => {
      if (!groupsData) {
        throw new ServiceError('NOT_FOUND', 'Groups file not found');
      }

      // Check if group exists (own-property check so names inherited from
      // Object.prototype, e.g. "hasOwnProperty", can't be mistaken for a group)
      if (!Object.hasOwn(groupsData.groups, groupId)) {
        throw new ServiceError('NOT_FOUND', 'Group not found');
      }

      group = groupsData.groups[groupId];
      oldGroup = JSON.parse(JSON.stringify(group));

      // Update fields
      if (name !== undefined) group.name = name;
      if (description !== undefined) group.description = description;
      if (mappings !== undefined) group.mappings = Array.isArray(mappings) ? mappings : [];
      if (inherits !== undefined) {
        group.inherits = normalizeInherits(inherits);
        const inheritanceError = validateGroupInheritance(groupsData.groups, groupId);
        if (inheritanceError) throw new ServiceError('BAD_REQUEST', inheritanceError);
      }
      if (limits) {
        if (limits.value) group.usageLimits = limits.value;
        else delete group.usageLimits;
      }

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
            throw new ServiceError(
              'BAD_REQUEST',
              `Cannot remove administrative access from group '${groupId}': it is the only group with administrative access`
            );
          }
        }

        group.permissions = normalizeGroupPermissions(
          permissions,
          group.permissions || {},
          newAdminAccess
        );
      }

      groupsData.metadata.lastModified = new Date().toISOString();
      return groupsData;
    });

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
    res.json(group);
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
    const { groupId } = req.params;

    // Validate groupId for security (prevents prototype pollution)
    assertValidId(groupId, 'group');

    // Prevent deletion of core system groups
    if (PROTECTED_GROUP_IDS.includes(groupId)) {
      throw new ServiceError('BAD_REQUEST', `Cannot delete protected system group: ${groupId}`);
    }

    // Check, snapshot and remove on the body read under the lock, so the
    // last-admin-group guard sees the groups as they are now.
    let deletedGroup;
    await configStore.updateJson(GROUPS_FILE, groupsData => {
      if (!groupsData) {
        throw new ServiceError('NOT_FOUND', 'Groups file not found');
      }

      // Check if group exists (own-property check so names inherited from
      // Object.prototype, e.g. "hasOwnProperty", can't be mistaken for a group)
      if (!Object.hasOwn(groupsData.groups, groupId)) {
        throw new ServiceError('NOT_FOUND', 'Group not found');
      }

      deletedGroup = groupsData.groups[groupId];

      // Prevent deleting the last group that grants adminAccess, which would
      // lock every admin out of the platform.
      if (deletedGroup.permissions?.adminAccess === true) {
        const remainingAdminGroups = countAdminAccessGroups(groupsData.groups, groupId);
        if (remainingAdminGroups === 0) {
          throw new ServiceError(
            'BAD_REQUEST',
            `Cannot delete group '${groupId}': it is the only group with administrative access`
          );
        }
      }

      delete groupsData.groups[groupId];
      groupsData.metadata.lastModified = new Date().toISOString();
      return groupsData;
    });
    const groupName = deletedGroup.name;

    // Save snapshot of the deleted group
    await saveSnapshot({
      resource: 'group',
      id: groupId,
      before: deletedGroup,
      after: null,
      admin: req.user?.username ?? req.user?.name ?? req.user?.id ?? 'unknown'
    });

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
    res.status(204).end();
  });
}
