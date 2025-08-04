import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';

export default function registerAdminGroupRoutes(app) {
  /**
   * Get all groups
   */
  app.get('/api/admin/groups', adminAuth, async (req, res) => {
    try {
      const rootDir = getRootDir();
      const groupsFilePath = join(rootDir, 'contents', 'config', 'groups.json');

      let groupsData = { groups: {}, metadata: {} };
      try {
        const groupsFileData = await fs.readFile(groupsFilePath, 'utf8');
        groupsData = JSON.parse(groupsFileData);
      } catch {
        console.log('Groups file not found or invalid, returning empty list');
      }

      res.json(groupsData);
    } catch (error) {
      console.error('Error getting groups:', error);
      res.status(500).json({ error: 'Failed to get groups' });
    }
  });

  /**
   * Get available apps, models, and prompts for dropdowns
   */
  //TODO make use of existing configCache
  app.get('/api/admin/groups/resources', adminAuth, async (req, res) => {
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
            console.warn(`Error reading app file ${file}:`, error.message);
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
            console.warn(`Error reading model file ${file}:`, error.message);
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
              console.warn(`Error reading prompt file ${file}:`, error.message);
            }
          }
        }
      } catch {
        console.log('Prompts directory not found or empty');
      }

      res.json({
        apps: apps.sort((a, b) => a.id.localeCompare(b.id)),
        models: models.sort((a, b) => a.id.localeCompare(b.id)),
        prompts: prompts.sort((a, b) => a.id.localeCompare(b.id))
      });
    } catch (error) {
      console.error('Error getting resources:', error);
      res.status(500).json({ error: 'Failed to get resources' });
    }
  });

  /**
   * Create a new group
   */
  app.post('/api/admin/groups', adminAuth, async (req, res) => {
    try {
      const { id, name, description, permissions, mappings = [] } = req.body;

      if (!id || !name) {
        return res.status(400).json({ error: 'Group ID and name are required' });
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

      console.log(`👥 Created new group: ${name} (${id})`);

      res.json({ group: newGroup });
    } catch (error) {
      console.error('Error creating group:', error);
      res.status(500).json({ error: 'Failed to create group' });
    }
  });

  /**
   * Update a group
   */
  app.put('/api/admin/groups/:groupId', adminAuth, async (req, res) => {
    try {
      const { groupId } = req.params;
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

      console.log(`👥 Updated group: ${group.name} (${groupId})`);

      res.json({ group });
    } catch (error) {
      console.error('Error updating group:', error);
      res.status(500).json({ error: 'Failed to update group' });
    }
  });

  /**
   * Delete a group
   */
  app.delete('/api/admin/groups/:groupId', adminAuth, async (req, res) => {
    try {
      const { groupId } = req.params;

      // Prevent deletion of core system groups
      const protectedGroups = ['admin', 'user', 'anonymous', 'authenticated'];
      if (protectedGroups.includes(groupId)) {
        return res.status(400).json({ error: `Cannot delete protected system group: ${groupId}` });
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

      console.log(`👥 Deleted group: ${groupName} (${groupId})`);

      res.json({ message: 'Group deleted successfully' });
    } catch (error) {
      console.error('Error deleting group:', error);
      res.status(500).json({ error: 'Failed to delete group' });
    }
  });
}
