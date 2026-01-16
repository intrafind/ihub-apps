import { readFileSync, existsSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { getLocalizedContent } from '../../../shared/localize.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { validateIdForPath, validateIdsForPath } from '../../utils/pathSecurity.js';

export default function registerAdminToolsRoutes(app, basePath = '') {
  /**
   * @swagger
   * /admin/tools:
   *   get:
   *     summary: Get all tools (Admin)
   *     description: Retrieves all configured tools including disabled ones (admin access required)
   *     tags:
   *       - Admin - Tools
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: List of all tools
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 type: object
   *                 properties:
   *                   id:
   *                     type: string
   *                   name:
   *                     type: object
   *                   description:
   *                     type: object
   *                   enabled:
   *                     type: boolean
   *       401:
   *         description: Admin authentication required
   *       500:
   *         description: Internal server error
   */
  app.get(buildServerPath('/api/admin/tools', basePath), adminAuth, async (req, res) => {
    try {
      const { data: tools, etag: toolsEtag } = configCache.getTools(true);

      res.setHeader('ETag', toolsEtag);
      res.json(tools);
    } catch (error) {
      console.error('Error fetching all tools:', error);
      res.status(500).json({ error: 'Failed to fetch tools' });
    }
  });

  /**
   * @swagger
   * /admin/tools/{toolId}:
   *   get:
   *     summary: Get a specific tool (Admin)
   *     description: Retrieves a specific tool configuration (admin access required)
   *     tags:
   *       - Admin - Tools
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: toolId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Tool configuration
   *       404:
   *         description: Tool not found
   *       401:
   *         description: Admin authentication required
   *       500:
   *         description: Internal server error
   */
  app.get(buildServerPath('/api/admin/tools/:toolId', basePath), adminAuth, async (req, res) => {
    try {
      const { toolId } = req.params;

      // Validate toolId for security
      if (!validateIdForPath(toolId, 'tool', res)) {
        return;
      }

      const { data: tools, etag: toolsEtag } = configCache.getTools(true);
      const tool = tools.find(t => t.id === toolId);
      if (!tool) {
        return res.status(404).json({ error: 'Tool not found' });
      }

      res.setHeader('ETag', toolsEtag);
      res.json(tool);
    } catch (error) {
      console.error('Error fetching tool:', error);
      res.status(500).json({ error: 'Failed to fetch tool' });
    }
  });

  /**
   * @swagger
   * /admin/tools/{toolId}:
   *   put:
   *     summary: Update a tool (Admin)
   *     description: Updates an existing tool configuration (admin access required)
   *     tags:
   *       - Admin - Tools
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: toolId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *     responses:
   *       200:
   *         description: Tool updated successfully
   *       400:
   *         description: Invalid request
   *       404:
   *         description: Tool not found
   *       401:
   *         description: Admin authentication required
   *       500:
   *         description: Internal server error
   */
  app.put(buildServerPath('/api/admin/tools/:toolId', basePath), adminAuth, async (req, res) => {
    try {
      const { toolId } = req.params;
      const updatedTool = req.body;

      // Validate toolId for security
      if (!validateIdForPath(toolId, 'tool', res)) {
        return;
      }

      const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
      if (
        !updatedTool.id ||
        !getLocalizedContent(updatedTool.name, defaultLang) ||
        !getLocalizedContent(updatedTool.description, defaultLang)
      ) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      if (updatedTool.id !== toolId) {
        return res.status(400).json({ error: 'Tool ID cannot be changed' });
      }

      // Load all tools
      const { data: allTools } = configCache.getTools(true);
      const toolIndex = allTools.findIndex(t => t.id === toolId);
      if (toolIndex === -1) {
        return res.status(404).json({ error: 'Tool not found' });
      }

      // Update the tool in the array
      allTools[toolIndex] = updatedTool;

      // Write the updated tools array back to the config file
      const rootDir = getRootDir();
      const toolsFilePath = join(rootDir, 'contents', 'config', 'tools.json');
      await fs.writeFile(toolsFilePath, JSON.stringify(allTools, null, 2));

      // Refresh the cache
      await configCache.refreshCacheEntry('config/tools.json');

      res.json({ message: 'Tool updated successfully', tool: updatedTool });
    } catch (error) {
      console.error('Error updating tool:', error);
      res.status(500).json({ error: 'Failed to update tool' });
    }
  });

  /**
   * @swagger
   * /admin/tools:
   *   post:
   *     summary: Create a new tool (Admin)
   *     description: Creates a new tool configuration (admin access required)
   *     tags:
   *       - Admin - Tools
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *     responses:
   *       200:
   *         description: Tool created successfully
   *       400:
   *         description: Invalid request
   *       409:
   *         description: Tool with this ID already exists
   *       401:
   *         description: Admin authentication required
   *       500:
   *         description: Internal server error
   */
  app.post(buildServerPath('/api/admin/tools', basePath), adminAuth, async (req, res) => {
    try {
      const newTool = req.body;
      const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
      if (
        !newTool.id ||
        !getLocalizedContent(newTool.name, defaultLang) ||
        !getLocalizedContent(newTool.description, defaultLang)
      ) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Validate newTool.id for security
      if (!validateIdForPath(newTool.id, 'tool', res)) {
        return;
      }

      // Load all tools
      const { data: allTools } = configCache.getTools(true);

      // Check if tool with this ID already exists
      if (allTools.find(t => t.id === newTool.id)) {
        return res.status(409).json({ error: 'Tool with this ID already exists' });
      }

      // Add the new tool
      allTools.push(newTool);

      // Write the updated tools array back to the config file
      const rootDir = getRootDir();
      const toolsFilePath = join(rootDir, 'contents', 'config', 'tools.json');
      await fs.writeFile(toolsFilePath, JSON.stringify(allTools, null, 2));

      // Refresh the cache
      await configCache.refreshCacheEntry('config/tools.json');

      res.json({ message: 'Tool created successfully', tool: newTool });
    } catch (error) {
      console.error('Error creating tool:', error);
      res.status(500).json({ error: 'Failed to create tool' });
    }
  });

  /**
   * @swagger
   * /admin/tools/{toolId}/toggle:
   *   post:
   *     summary: Toggle tool enabled status (Admin)
   *     description: Enables or disables a tool (admin access required)
   *     tags:
   *       - Admin - Tools
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: toolId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Tool toggled successfully
   *       404:
   *         description: Tool not found
   *       401:
   *         description: Admin authentication required
   *       500:
   *         description: Internal server error
   */
  app.post(
    buildServerPath('/api/admin/tools/:toolId/toggle', basePath),
    adminAuth,
    async (req, res) => {
      try {
        const { toolId } = req.params;

        // Validate toolId for security
        if (!validateIdForPath(toolId, 'tool', res)) {
          return;
        }

        const { data: allTools } = configCache.getTools(true);
        const tool = allTools.find(t => t.id === toolId);
        if (!tool) {
          return res.status(404).json({ error: 'Tool not found' });
        }

        const newEnabledState = !tool.enabled;
        tool.enabled = newEnabledState;

        // Write the updated tools array back to the config file
        const rootDir = getRootDir();
        const toolsFilePath = join(rootDir, 'contents', 'config', 'tools.json');
        await fs.writeFile(toolsFilePath, JSON.stringify(allTools, null, 2));

        // Refresh the cache
        await configCache.refreshCacheEntry('config/tools.json');

        res.json({
          message: `Tool ${newEnabledState ? 'enabled' : 'disabled'} successfully`,
          tool: tool,
          enabled: newEnabledState
        });
      } catch (error) {
        console.error('Error toggling tool:', error);
        res.status(500).json({ error: 'Failed to toggle tool' });
      }
    }
  );

  /**
   * @swagger
   * /admin/tools/{toolIds}/_toggle:
   *   post:
   *     summary: Toggle multiple tools enabled status (Admin)
   *     description: Enables or disables multiple tools at once (admin access required)
   *     tags:
   *       - Admin - Tools
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: toolIds
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
   *               enabled:
   *                 type: boolean
   *     responses:
   *       200:
   *         description: Tools toggled successfully
   *       400:
   *         description: Invalid request
   *       401:
   *         description: Admin authentication required
   *       500:
   *         description: Internal server error
   */
  app.post(
    buildServerPath('/api/admin/tools/:toolIds/_toggle', basePath),
    adminAuth,
    async (req, res) => {
      try {
        const { toolIds } = req.params;
        const { enabled } = req.body;
        if (typeof enabled !== 'boolean') {
          return res.status(400).json({ error: 'Missing enabled flag' });
        }

        // Validate toolIds for security
        const ids = validateIdsForPath(toolIds, 'tool', res);
        if (!ids) {
          return;
        }

        const { data: allTools } = configCache.getTools(true);
        const resolvedIds = ids.includes('*') ? allTools.map(t => t.id) : ids;

        for (const id of resolvedIds) {
          const tool = allTools.find(t => t.id === id);
          if (!tool) continue;
          tool.enabled = enabled;
        }

        // Write the updated tools array back to the config file
        const rootDir = getRootDir();
        const toolsFilePath = join(rootDir, 'contents', 'config', 'tools.json');
        await fs.writeFile(toolsFilePath, JSON.stringify(allTools, null, 2));

        // Refresh the cache
        await configCache.refreshCacheEntry('config/tools.json');

        res.json({
          message: `Tools ${enabled ? 'enabled' : 'disabled'} successfully`,
          enabled,
          ids: resolvedIds
        });
      } catch (error) {
        console.error('Error toggling tools:', error);
        res.status(500).json({ error: 'Failed to toggle tools' });
      }
    }
  );

  /**
   * @swagger
   * /admin/tools/{toolId}:
   *   delete:
   *     summary: Delete a tool (Admin)
   *     description: Deletes a tool configuration (admin access required)
   *     tags:
   *       - Admin - Tools
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: toolId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Tool deleted successfully
   *       404:
   *         description: Tool not found
   *       401:
   *         description: Admin authentication required
   *       500:
   *         description: Internal server error
   */
  app.delete(
    buildServerPath('/api/admin/tools/:toolId', basePath),
    adminAuth,
    async (req, res) => {
      try {
        const { toolId } = req.params;

        // Validate toolId for security
        if (!validateIdForPath(toolId, 'tool', res)) {
          return;
        }

        const { data: allTools } = configCache.getTools(true);
        const toolIndex = allTools.findIndex(t => t.id === toolId);
        if (toolIndex === -1) {
          return res.status(404).json({ error: 'Tool not found' });
        }

        // Remove the tool from the array
        allTools.splice(toolIndex, 1);

        // Write the updated tools array back to the config file
        const rootDir = getRootDir();
        const toolsFilePath = join(rootDir, 'contents', 'config', 'tools.json');
        await fs.writeFile(toolsFilePath, JSON.stringify(allTools, null, 2));

        // Refresh the cache
        await configCache.refreshCacheEntry('config/tools.json');

        res.json({ message: 'Tool deleted successfully' });
      } catch (error) {
        console.error('Error deleting tool:', error);
        res.status(500).json({ error: 'Failed to delete tool' });
      }
    }
  );
}
