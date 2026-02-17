import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import logger from '../../utils/logger.js';

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

export default function registerAdminGroupRoutes(app, basePath = '') {
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
      const rootDir = getRootDir();
      const groupsFilePath = join(rootDir, 'contents', 'config', 'groups.json');

      let groupsData = { groups: {}, metadata: {} };
      try {
        const groupsFileData = await fs.readFile(groupsFilePath, 'utf8');
        groupsData = JSON.parse(groupsFileData);
      } catch {
        logger.info('Groups file not found or invalid, returning empty list');
      }

      res.json(groupsData);
    } catch (error) {
      logger.error('Error getting groups:', error);
      res.status(500).json({ error: 'Failed to get groups' });
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
      const rootDir = getRootDir();

      // Get apps
      const appsPath = join(rootDir, 'contents', 'apps');
      const appFiles = await fs.readdir(appsPath);
      const apps = [];

      for (const file of appFiles) {
        if (file.endsWith('.json')) {
          try {
            const appData = await fs.readFile(join(appsPath, file), 'utf8');
            const app = JSON.parse(appData);
            apps.push({
              id: app.id,
              name: app.name || { en: app.id, de: app.id }
            });
          } catch (error) {
            logger.warn(`Error reading app file ${file}:`, error.message);
          }
        }
      }

      // Get models
      const modelsPath = join(rootDir, 'contents', 'models');
      const modelFiles = await fs.readdir(modelsPath);
      const models = [];

      for (const file of modelFiles) {
        if (file.endsWith('.json')) {
          try {
            const modelData = await fs.readFile(join(modelsPath, file), 'utf8');
            const model = JSON.parse(modelData);
            models.push({
              id: model.id,
              name: model.name || { en: model.id, de: model.id }
            });
          } catch (error) {
            logger.warn(`Error reading model file ${file}:`, error.message);
          }
        }
      }

      // Get prompts
      const promptsPath = join(rootDir, 'contents', 'prompts');
      const prompts = [];

      try {
        const promptFiles = await fs.readdir(promptsPath);
        for (const file of promptFiles) {
          if (file.endsWith('.json')) {
            try {
              const promptData = await fs.readFile(join(promptsPath, file), 'utf8');
              const prompt = JSON.parse(promptData);
              prompts.push({
                id: prompt.id,
                name: prompt.name || { en: prompt.id, de: prompt.id }
              });
            } catch (error) {
              logger.warn(`Error reading prompt file ${file}:`, error.message);
            }
          }
        }
      } catch {
        logger.info('Prompts directory not found or empty');
      }

      // Get workflows
      const workflowsPath = join(rootDir, 'contents', 'workflows');
      const workflows = [];

      try {
        const workflowFiles = await fs.readdir(workflowsPath);
        for (const file of workflowFiles) {
          if (file.endsWith('.json')) {
            try {
              const workflowData = await fs.readFile(join(workflowsPath, file), 'utf8');
              const workflow = JSON.parse(workflowData);
              workflows.push({
                id: workflow.id,
                name: workflow.name || { en: workflow.id, de: workflow.id }
              });
            } catch (error) {
              logger.warn(`Error reading workflow file ${file}:`, error.message);
            }
          }
        }
      } catch {
        logger.info('Workflows directory not found or empty');
      }

      res.json({
        apps: apps.sort((a, b) => a.id.localeCompare(b.id)),
        models: models.sort((a, b) => a.id.localeCompare(b.id)),
        prompts: prompts.sort((a, b) => a.id.localeCompare(b.id)),
        workflows: workflows.sort((a, b) => a.id.localeCompare(b.id))
      });
    } catch (error) {
      logger.error('Error getting resources:', error);
      res.status(500).json({ error: 'Failed to get resources' });
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
      const { id, name, description, permissions, mappings = [] } = req.body;

      if (!id || !name) {
        return res.status(400).json({ error: 'Group ID and name are required' });
      }

      // Validate group ID for security
      if (!validateIdForPath(id, 'group', res)) {
        return;
      }

      // Validate permissions structure
      if (!permissions || typeof permissions !== 'object') {
        return res.status(400).json({ error: 'Valid permissions object is required' });
      }

      const rootDir = getRootDir();
      const groupsFilePath = join(rootDir, 'contents', 'config', 'groups.json');

      // Load existing groups
      let groupsData = { groups: {}, metadata: {} };
      try {
        const groupsFileData = await fs.readFile(groupsFilePath, 'utf8');
        groupsData = JSON.parse(groupsFileData);
      } catch {
        // File doesn't exist, create new structure
        groupsData = {
          groups: {},
          metadata: {
            version: '1.0.0',
            description: 'Unified group configuration with permissions and external mappings',
            lastModified: new Date().toISOString()
          }
        };
      }

      // Check if group ID already exists
      if (groupsData.groups[id]) {
        return res.status(409).json({ error: 'Group ID already exists' });
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
        mappings: Array.isArray(mappings) ? mappings : []
      };

      groupsData.groups[id] = newGroup;
      groupsData.metadata.lastModified = new Date().toISOString();

      // Save to file
      await atomicWriteJSON(groupsFilePath, groupsData);

      // Refresh cache
      await configCache.refreshCacheEntry('config/groups.json');

      logger.info(`👥 Created new group: ${name} (${id})`);

      res.json({ group: newGroup });
    } catch (error) {
      logger.error('Error creating group:', error);
      res.status(500).json({ error: 'Failed to create group' });
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

      const { name, description, permissions, mappings } = req.body;

      const rootDir = getRootDir();
      const groupsFilePath = join(rootDir, 'contents', 'config', 'groups.json');

      // Load existing groups
      let groupsData = { groups: {}, metadata: {} };
      try {
        const groupsFileData = await fs.readFile(groupsFilePath, 'utf8');
        groupsData = JSON.parse(groupsFileData);
      } catch {
        return res.status(404).json({ error: 'Groups file not found' });
      }

      // Check if group exists
      if (!groupsData.groups[groupId]) {
        return res.status(404).json({ error: 'Group not found' });
      }

      const group = groupsData.groups[groupId];

      // Update fields
      if (name !== undefined) group.name = name;
      if (description !== undefined) group.description = description;
      if (mappings !== undefined) group.mappings = Array.isArray(mappings) ? mappings : [];

      // Update permissions
      if (permissions !== undefined && typeof permissions === 'object') {
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
          adminAccess:
            permissions.adminAccess !== undefined
              ? Boolean(permissions.adminAccess)
              : group.permissions.adminAccess || false
        };
      }

      groupsData.metadata.lastModified = new Date().toISOString();

      // Save to file
      await atomicWriteJSON(groupsFilePath, groupsData);

      // Refresh cache
      await configCache.refreshCacheEntry('config/groups.json');

      logger.info(`👥 Updated group: ${group.name} (${groupId})`);

      res.json({ group });
    } catch (error) {
      logger.error('Error updating group:', error);
      res.status(500).json({ error: 'Failed to update group' });
    }
  });

  /**
   * @swagger
   * /api/admin/groups/{groupId}:
   *   delete:
   *     summary: Delete a user group
   *     description: |
   *       Permanently deletes a user group and its configuration.
   *       Protected system groups (admin, user, anonymous, authenticated) cannot be deleted
   *       to maintain system integrity.
   *
   *       **Protected Groups:**
   *       The following system groups are protected and cannot be deleted:
   *       - admin: Administrative access group
   *       - user: Standard user group
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
   *               error: "Cannot delete protected system group: admin"
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
  app.delete(
    buildServerPath('/api/admin/groups/:groupId'),
    adminAuth,
    async (req, res) => {
      try {
        const { groupId } = req.params;

        // Validate groupId for security (prevents prototype pollution)
        if (!validateIdForPath(groupId, 'group', res)) {
          return;
        }

        // Prevent deletion of core system groups
        const protectedGroups = ['admin', 'user', 'anonymous', 'authenticated'];
        if (protectedGroups.includes(groupId)) {
          return res
            .status(400)
            .json({ error: `Cannot delete protected system group: ${groupId}` });
        }

        const rootDir = getRootDir();
        const groupsFilePath = join(rootDir, 'contents', 'config', 'groups.json');

        // Load existing groups
        let groupsData = { groups: {}, metadata: {} };
        try {
          const groupsFileData = await fs.readFile(groupsFilePath, 'utf8');
          groupsData = JSON.parse(groupsFileData);
        } catch {
          return res.status(404).json({ error: 'Groups file not found' });
        }

        // Check if group exists
        if (!groupsData.groups[groupId]) {
          return res.status(404).json({ error: 'Group not found' });
        }

        const groupName = groupsData.groups[groupId].name;

        // Remove group
        delete groupsData.groups[groupId];
        groupsData.metadata.lastModified = new Date().toISOString();

        // Save to file
        await atomicWriteJSON(groupsFilePath, groupsData);

        // Refresh cache
        await configCache.refreshCacheEntry('config/groups.json');

        logger.info(`👥 Deleted group: ${groupName} (${groupId})`);

        res.json({ message: 'Group deleted successfully' });
      } catch (error) {
        logger.error('Error deleting group:', error);
        res.status(500).json({ error: 'Failed to delete group' });
      }
    }
  );
}
