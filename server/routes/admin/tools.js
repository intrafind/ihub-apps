import { readFileSync, existsSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { getRootDir } from '../../pathUtils.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { validateIdForPath } from '../../utils/pathSecurity.js';
import logger from '../../utils/logger.js';

/**
 * @swagger
 * components:
 *   schemas:
 *     ToolConfiguration:
 *       type: object
 *       description: AI tool/function configuration with localization support
 *       required:
 *         - id
 *         - name
 *         - description
 *       properties:
 *         id:
 *           type: string
 *           description: Unique identifier for the tool
 *           example: "braveSearch"
 *         name:
 *           type: object
 *           description: Localized names for the tool
 *           additionalProperties:
 *             type: string
 *           example: { "en": "Brave Search", "de": "Brave-Suche" }
 *         description:
 *           type: object
 *           description: Localized descriptions of the tool's purpose
 *           additionalProperties:
 *             type: string
 *           example: { "en": "Search the web using Brave", "de": "Das Web mit Brave durchsuchen" }
 *         script:
 *           type: string
 *           description: Filename of the JavaScript file implementing the tool
 *           example: "braveSearch.js"
 *         enabled:
 *           type: boolean
 *           description: Whether the tool is currently enabled
 *           default: true
 *           example: true
 *         concurrency:
 *           type: number
 *           description: Maximum number of concurrent executions allowed
 *           example: 5
 *         parameters:
 *           type: object
 *           description: JSON schema defining tool parameters
 *           example: { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] }
 *         functions:
 *           type: object
 *           description: Multiple function definitions within a single tool (for multi-function tools like Entra)
 *           additionalProperties:
 *             type: object
 *         provider:
 *           type: string
 *           description: Provider identifier for special tools (e.g., "google" for Google Search Grounding)
 *           example: "google"
 *         isSpecialTool:
 *           type: boolean
 *           description: Whether this is a provider-specific special tool
 *           example: false
 *
 *     ToolOperation:
 *       type: object
 *       description: Result of a tool operation
 *       properties:
 *         message:
 *           type: string
 *           description: Operation result message
 *           example: "Tool updated successfully"
 *         tool:
 *           $ref: '#/components/schemas/ToolConfiguration'
 *           description: The affected tool (for single operations)
 *         enabled:
 *           type: boolean
 *           description: New enabled state (for toggle operations)
 *
 *     ToolScript:
 *       type: object
 *       description: Tool script content
 *       properties:
 *         id:
 *           type: string
 *           description: Tool identifier
 *           example: "braveSearch"
 *         script:
 *           type: string
 *           description: Script filename
 *           example: "braveSearch.js"
 *         content:
 *           type: string
 *           description: JavaScript source code
 *           example: "export default async function braveSearch({ query }) { ... }"
 *
 *     AdminError:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *           description: Error message
 *           example: "Failed to update tool"
 *         details:
 *           type: string
 *           description: Additional error details
 */

/**
 * Load raw tools from JSON file (unexpanded)
 * For admin operations, we need the original tool definitions, not the expanded ones
 */
function loadRawTools() {
  const rootDir = getRootDir();
  const contentsDir = process.env.CONTENTS_DIR || 'contents';
  const toolsFilePath = join(rootDir, contentsDir, 'config', 'tools.json');

  let tools = [];
  let needsCleanup = false;

  if (existsSync(toolsFilePath)) {
    const fileContent = readFileSync(toolsFilePath, 'utf-8');
    const allTools = JSON.parse(fileContent);

    // Filter out expanded tools (those with 'method' property)
    // This handles legacy cases where expanded tools were saved to the config file
    tools = allTools.filter(tool => !tool.method);

    // Check if we filtered any tools out
    if (tools.length !== allTools.length) {
      needsCleanup = true;
      logger.info(
        `⚠️  Detected ${allTools.length - tools.length} expanded tools in ${toolsFilePath}`
      );
      logger.info(`✓ Filtered to ${tools.length} raw tool definitions`);
    }
  } else {
    // Fall back to defaults if no custom config exists
    const defaultToolsPath = join(rootDir, 'server', 'defaults', 'config', 'tools.json');
    if (existsSync(defaultToolsPath)) {
      const fileContent = readFileSync(defaultToolsPath, 'utf-8');
      tools = JSON.parse(fileContent);
    }
  }

  return { tools, needsCleanup, filePath: toolsFilePath };
}

export default function registerAdminToolsRoutes(app) {
  /**
   * @swagger
   * /api/admin/tools:
   *   get:
   *     summary: Get all tool configurations (admin view)
   *     description: |
   *       Retrieves all tool configurations in the system with complete configuration details.
   *       This admin endpoint provides access to all tool properties including enabled/disabled status,
   *       script references, parameters, and internal configuration that regular users cannot see.
   *
   *       **Admin Access Required**: This endpoint requires administrator authentication.
   *
   *       **ETag Support**: This endpoint supports HTTP ETag caching for efficient data transfer.
   *     tags:
   *       - Admin - Tools
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     responses:
   *       200:
   *         description: All tool configurations successfully retrieved
   *         headers:
   *           ETag:
   *             description: Cache validation header for tools list
   *             schema:
   *               type: string
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/ToolConfiguration'
   *       304:
   *         description: Not Modified - content hasn't changed (ETag match)
   *       401:
   *         description: Authentication required
   *       403:
   *         description: Forbidden - insufficient admin privileges
   *       500:
   *         description: Internal server error
   */
  app.get(buildServerPath('/api/admin/tools'), adminAuth, async (req, res) => {
    try {
      // Load raw (unexpanded) tools for admin interface
      const { tools, needsCleanup, filePath } = loadRawTools();

      if (!tools) {
        return res.status(500).json({ error: 'Failed to load tools configuration' });
      }

      // If we detected expanded tools, clean up the file
      if (needsCleanup && filePath) {
        try {
          const rootDir = getRootDir();
          const contentsDir = process.env.CONTENTS_DIR || 'contents';
          await fs.mkdir(join(rootDir, contentsDir, 'config'), { recursive: true });
          await fs.writeFile(filePath, JSON.stringify(tools, null, 2));
          logger.info(`✓ Cleaned up ${filePath} - removed expanded tools`);
        } catch (cleanupError) {
          logger.error('Failed to cleanup tools file:', cleanupError);
          // Don't fail the request, just log the error
        }
      }

      // Append workflow tools that have chatIntegration enabled
      const { data: workflows } = configCache.getWorkflows();
      const workflowTools = workflows
        .filter(wf => wf.chatIntegration?.enabled)
        .map(wf => ({
          id: `workflow:${wf.id}`,
          name: wf.chatIntegration?.toolDescription || wf.name,
          description: wf.chatIntegration?.toolDescription || wf.description,
          isWorkflowTool: true,
          workflowId: wf.id
        }));

      const allTools = [...tools, ...workflowTools];

      // Generate ETag for caching using MD5 hash (same as configCache)
      const hash = createHash('md5');
      hash.update(JSON.stringify(allTools));
      const etag = `"${hash.digest('hex')}"`;

      if (etag) {
        res.setHeader('ETag', etag);
        const clientETag = req.headers['if-none-match'];
        if (clientETag && clientETag === etag) {
          return res.status(304).end();
        }
      }
      res.json(allTools);
    } catch (error) {
      logger.error('Error fetching all tools:', error);
      res.status(500).json({ error: 'Failed to fetch tools' });
    }
  });

  /**
   * @swagger
   * /api/admin/tools/{toolId}:
   *   get:
   *     summary: Get a specific tool configuration by ID
   *     description: |
   *       Retrieves detailed information about a specific tool including all
   *       configuration properties, localized content, and administrative metadata.
   *
   *       **Admin Access Required**: This endpoint requires administrator authentication.
   *     tags:
   *       - Admin - Tools
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: toolId
   *         required: true
   *         description: Unique identifier of the tool
   *         schema:
   *           type: string
   *         example: "braveSearch"
   *     responses:
   *       200:
   *         description: Tool configuration successfully retrieved
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ToolConfiguration'
   *       404:
   *         description: Tool not found
   *       401:
   *         description: Authentication required
   *       403:
   *         description: Forbidden - insufficient admin privileges
   *       500:
   *         description: Internal server error
   */
  app.get(buildServerPath('/api/admin/tools/:toolId'), adminAuth, async (req, res) => {
    try {
      const { toolId } = req.params;

      // Validate toolId for security
      if (!validateIdForPath(toolId, 'tool', res)) {
        return;
      }

      // Load raw (unexpanded) tools
      const { tools } = loadRawTools();
      const tool = tools.find(t => t.id === toolId);

      if (!tool) {
        return res.status(404).json({ error: 'Tool not found' });
      }
      res.json(tool);
    } catch (error) {
      logger.error('Error fetching tool:', error);
      res.status(500).json({ error: 'Failed to fetch tool' });
    }
  });

  /**
   * @swagger
   * /api/admin/tools/{toolId}:
   *   put:
   *     summary: Update an existing tool configuration
   *     description: |
   *       Updates an existing tool configuration with new data.
   *       The tool ID cannot be changed during an update operation.
   *       All required fields must be present in the request body.
   *
   *       **Admin Access Required**: This endpoint requires administrator authentication.
   *
   *       **File System Changes**: This operation modifies the tools.json file on disk
   *       and refreshes the system cache immediately.
   *     tags:
   *       - Admin - Tools
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: toolId
   *         required: true
   *         description: Unique identifier of the tool to update
   *         schema:
   *           type: string
   *         example: "braveSearch"
   *     requestBody:
   *       required: true
   *       description: Updated tool configuration
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/ToolConfiguration'
   *     responses:
   *       200:
   *         description: Tool configuration successfully updated
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ToolOperation'
   *       400:
   *         description: Bad request - missing required fields or invalid data
   *       401:
   *         description: Authentication required
   *       403:
   *         description: Forbidden - insufficient admin privileges
   *       404:
   *         description: Tool not found
   *       500:
   *         description: Internal server error
   */
  app.put(buildServerPath('/api/admin/tools/:toolId'), adminAuth, async (req, res) => {
    try {
      const { toolId } = req.params;
      const updatedTool = req.body;

      // Validate toolId for security
      if (!validateIdForPath(toolId, 'tool', res)) {
        return;
      }

      // Validate required fields
      if (!updatedTool.id || !updatedTool.name || !updatedTool.description) {
        return res.status(400).json({ error: 'Missing required fields: id, name, description' });
      }

      if (updatedTool.id !== toolId) {
        return res.status(400).json({ error: 'Tool ID cannot be changed' });
      }

      const rootDir = getRootDir();
      const contentsDir = process.env.CONTENTS_DIR || 'contents';
      const toolsFilePath = join(rootDir, contentsDir, 'config', 'tools.json');

      // Load existing tools (raw, unexpanded)
      const { tools } = loadRawTools();
      const toolIndex = tools.findIndex(t => t.id === toolId);

      if (toolIndex === -1) {
        return res.status(404).json({ error: 'Tool not found' });
      }

      // Update the tool
      tools[toolIndex] = updatedTool;

      // Ensure directory exists
      await fs.mkdir(join(rootDir, contentsDir, 'config'), { recursive: true });

      // Write back to file
      await fs.writeFile(toolsFilePath, JSON.stringify(tools, null, 2));

      // Refresh cache
      await configCache.refreshCacheEntry('config/tools.json');

      res.json({ message: 'Tool updated successfully', tool: updatedTool });
    } catch (error) {
      logger.error('Error updating tool:', error);
      res.status(500).json({ error: 'Failed to update tool' });
    }
  });

  /**
   * @swagger
   * /api/admin/tools:
   *   post:
   *     summary: Create a new tool configuration
   *     description: |
   *       Creates a new tool configuration with the provided data.
   *       The tool ID must be unique - creation will fail if a tool with the same ID already exists.
   *
   *       **Admin Access Required**: This endpoint requires administrator authentication.
   *
   *       **File System Changes**: This operation modifies the tools.json file on disk
   *       and refreshes the system cache immediately.
   *     tags:
   *       - Admin - Tools
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     requestBody:
   *       required: true
   *       description: New tool configuration
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/ToolConfiguration'
   *     responses:
   *       201:
   *         description: Tool configuration successfully created
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ToolOperation'
   *       400:
   *         description: Bad request - missing required fields or tool already exists
   *       401:
   *         description: Authentication required
   *       403:
   *         description: Forbidden - insufficient admin privileges
   *       500:
   *         description: Internal server error
   */
  app.post(buildServerPath('/api/admin/tools'), adminAuth, async (req, res) => {
    try {
      const newTool = req.body;

      // Validate required fields
      if (!newTool.id || !newTool.name || !newTool.description) {
        return res.status(400).json({ error: 'Missing required fields: id, name, description' });
      }

      // Validate toolId for security
      if (!validateIdForPath(newTool.id, 'tool', res)) {
        return;
      }

      const rootDir = getRootDir();
      const contentsDir = process.env.CONTENTS_DIR || 'contents';
      const toolsFilePath = join(rootDir, contentsDir, 'config', 'tools.json');

      // Load existing tools (raw, unexpanded)
      const { tools } = loadRawTools();

      // Check if tool already exists
      if (tools.find(t => t.id === newTool.id)) {
        return res.status(400).json({ error: 'Tool with this ID already exists' });
      }

      // Set default enabled state if not provided
      if (newTool.enabled === undefined) {
        newTool.enabled = true;
      }

      // Add the new tool
      tools.push(newTool);

      // Ensure directory exists
      await fs.mkdir(join(rootDir, contentsDir, 'config'), { recursive: true });

      // Write back to file
      await fs.writeFile(toolsFilePath, JSON.stringify(tools, null, 2));

      // Refresh cache
      await configCache.refreshCacheEntry('config/tools.json');

      res.status(201).json({ message: 'Tool created successfully', tool: newTool });
    } catch (error) {
      logger.error('Error creating tool:', error);
      res.status(500).json({ error: 'Failed to create tool' });
    }
  });

  /**
   * @swagger
   * /api/admin/tools/{toolId}:
   *   delete:
   *     summary: Delete a tool configuration
   *     description: |
   *       Deletes a tool configuration from the system.
   *       This operation is irreversible.
   *
   *       **Admin Access Required**: This endpoint requires administrator authentication.
   *
   *       **File System Changes**: This operation modifies the tools.json file on disk
   *       and refreshes the system cache immediately.
   *     tags:
   *       - Admin - Tools
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: toolId
   *         required: true
   *         description: Unique identifier of the tool to delete
   *         schema:
   *           type: string
   *         example: "braveSearch"
   *     responses:
   *       200:
   *         description: Tool configuration successfully deleted
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *                   example: "Tool deleted successfully"
   *       401:
   *         description: Authentication required
   *       403:
   *         description: Forbidden - insufficient admin privileges
   *       404:
   *         description: Tool not found
   *       500:
   *         description: Internal server error
   */
  app.delete(buildServerPath('/api/admin/tools/:toolId'), adminAuth, async (req, res) => {
    try {
      const { toolId } = req.params;

      // Validate toolId for security
      if (!validateIdForPath(toolId, 'tool', res)) {
        return;
      }

      const rootDir = getRootDir();
      const contentsDir = process.env.CONTENTS_DIR || 'contents';
      const toolsFilePath = join(rootDir, contentsDir, 'config', 'tools.json');

      // Load existing tools (raw, unexpanded)
      const { tools } = loadRawTools();
      const toolIndex = tools.findIndex(t => t.id === toolId);

      if (toolIndex === -1) {
        return res.status(404).json({ error: 'Tool not found' });
      }

      const tool = tools[toolIndex];

      // Delete the script file if it exists (only for non-special tools)
      if (tool.script && !tool.isSpecialTool && !tool.provider) {
        const scriptPath = join(rootDir, 'server', 'tools', tool.script);
        try {
          if (existsSync(scriptPath)) {
            await fs.unlink(scriptPath);
            logger.info(`Deleted script file: ${tool.script}`);
          }
        } catch (scriptError) {
          logger.warn(`Failed to delete script file ${tool.script}:`, scriptError);
          // Continue with config deletion even if script deletion fails
        }
      }

      // Remove the tool from config
      tools.splice(toolIndex, 1);

      // Ensure directory exists
      await fs.mkdir(join(rootDir, contentsDir, 'config'), { recursive: true });

      // Write back to file
      await fs.writeFile(toolsFilePath, JSON.stringify(tools, null, 2));

      // Refresh cache
      await configCache.refreshCacheEntry('config/tools.json');

      res.json({
        message: 'Tool deleted successfully',
        scriptDeleted: tool.script ? true : false
      });
    } catch (error) {
      logger.error('Error deleting tool:', error);
      res.status(500).json({ error: 'Failed to delete tool' });
    }
  });

  /**
   * @swagger
   * /api/admin/tools/{toolId}/toggle:
   *   post:
   *     summary: Toggle tool enabled/disabled state
   *     description: |
   *       Toggles the enabled state of a tool.
   *       If the tool is currently enabled, it will be disabled, and vice versa.
   *
   *       **Admin Access Required**: This endpoint requires administrator authentication.
   *
   *       **File System Changes**: This operation modifies the tools.json file on disk
   *       and refreshes the system cache immediately.
   *     tags:
   *       - Admin - Tools
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: toolId
   *         required: true
   *         description: Unique identifier of the tool to toggle
   *         schema:
   *           type: string
   *         example: "braveSearch"
   *     responses:
   *       200:
   *         description: Tool state successfully toggled
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *                   example: "Tool state updated successfully"
   *                 enabled:
   *                   type: boolean
   *                   example: false
   *       401:
   *         description: Authentication required
   *       403:
   *         description: Forbidden - insufficient admin privileges
   *       404:
   *         description: Tool not found
   *       500:
   *         description: Internal server error
   */
  app.post(buildServerPath('/api/admin/tools/:toolId/toggle'), adminAuth, async (req, res) => {
    try {
      const { toolId } = req.params;

      // Validate toolId for security
      if (!validateIdForPath(toolId, 'tool', res)) {
        return;
      }

      const rootDir = getRootDir();
      const contentsDir = process.env.CONTENTS_DIR || 'contents';
      const toolsFilePath = join(rootDir, contentsDir, 'config', 'tools.json');

      // Load existing tools (raw, unexpanded)
      const { tools } = loadRawTools();
      const tool = tools.find(t => t.id === toolId);

      if (!tool) {
        return res.status(404).json({ error: 'Tool not found' });
      }

      // Toggle enabled state
      tool.enabled = !tool.enabled;

      // Ensure directory exists
      await fs.mkdir(join(rootDir, contentsDir, 'config'), { recursive: true });

      // Write back to file
      await fs.writeFile(toolsFilePath, JSON.stringify(tools, null, 2));

      // Refresh cache
      await configCache.refreshCacheEntry('config/tools.json');

      res.json({ message: 'Tool state updated successfully', enabled: tool.enabled });
    } catch (error) {
      logger.error('Error toggling tool:', error);
      res.status(500).json({ error: 'Failed to toggle tool' });
    }
  });

  /**
   * @swagger
   * /api/admin/tools/{toolId}/script:
   *   get:
   *     summary: Get tool script content
   *     description: |
   *       Retrieves the JavaScript source code for a tool's script file.
   *       Only works for tools that have a 'script' property.
   *
   *       **Admin Access Required**: This endpoint requires administrator authentication.
   *     tags:
   *       - Admin - Tools
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: toolId
   *         required: true
   *         description: Unique identifier of the tool
   *         schema:
   *           type: string
   *         example: "braveSearch"
   *     responses:
   *       200:
   *         description: Script content successfully retrieved
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ToolScript'
   *       400:
   *         description: Bad request - tool has no script property
   *       401:
   *         description: Authentication required
   *       403:
   *         description: Forbidden - insufficient admin privileges
   *       404:
   *         description: Tool not found or script file not found
   *       500:
   *         description: Internal server error
   */
  app.get(buildServerPath('/api/admin/tools/:toolId/script'), adminAuth, async (req, res) => {
    try {
      const { toolId } = req.params;

      // Validate toolId for security
      if (!validateIdForPath(toolId, 'tool', res)) {
        return;
      }

      const { tools } = loadRawTools();
      const tool = tools.find(t => t.id === toolId);

      if (!tool) {
        return res.status(404).json({ error: 'Tool not found' });
      }

      if (!tool.script) {
        return res
          .status(400)
          .json({ error: 'Tool has no script property (may be a special tool)' });
      }

      const rootDir = getRootDir();
      const scriptPath = join(rootDir, 'server', 'tools', tool.script);

      if (!existsSync(scriptPath)) {
        return res.status(404).json({ error: 'Script file not found' });
      }

      const content = readFileSync(scriptPath, 'utf-8');

      res.json({
        id: toolId,
        script: tool.script,
        content
      });
    } catch (error) {
      logger.error('Error reading tool script:', error);
      res.status(500).json({ error: 'Failed to read tool script' });
    }
  });

  /**
   * @swagger
   * /api/admin/tools/{toolId}/script:
   *   put:
   *     summary: Update tool script content
   *     description: |
   *       Updates the JavaScript source code for a tool's script file.
   *       Only works for tools that have a 'script' property.
   *
   *       **Admin Access Required**: This endpoint requires administrator authentication.
   *
   *       **File System Changes**: This operation modifies the script file on disk.
   *       **Warning**: No syntax validation is performed. Invalid JavaScript will cause runtime errors.
   *     tags:
   *       - Admin - Tools
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   *     parameters:
   *       - in: path
   *         name: toolId
   *         required: true
   *         description: Unique identifier of the tool
   *         schema:
   *           type: string
   *         example: "braveSearch"
   *     requestBody:
   *       required: true
   *       description: New script content
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - content
   *             properties:
   *               content:
   *                 type: string
   *                 description: JavaScript source code
   *     responses:
   *       200:
   *         description: Script content successfully updated
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *                   example: "Script updated successfully"
   *       400:
   *         description: Bad request - missing content or tool has no script
   *       401:
   *         description: Authentication required
   *       403:
   *         description: Forbidden - insufficient admin privileges
   *       404:
   *         description: Tool not found or script file not found
   *       500:
   *         description: Internal server error
   */
  app.put(buildServerPath('/api/admin/tools/:toolId/script'), adminAuth, async (req, res) => {
    try {
      const { toolId } = req.params;
      const { content } = req.body;

      if (!content) {
        return res.status(400).json({ error: 'Missing script content' });
      }

      // Validate toolId for security
      if (!validateIdForPath(toolId, 'tool', res)) {
        return;
      }

      const { tools } = loadRawTools();
      const tool = tools.find(t => t.id === toolId);

      if (!tool) {
        return res.status(404).json({ error: 'Tool not found' });
      }

      if (!tool.script) {
        return res
          .status(400)
          .json({ error: 'Tool has no script property (may be a special tool)' });
      }

      const rootDir = getRootDir();
      const scriptPath = join(rootDir, 'server', 'tools', tool.script);

      if (!existsSync(scriptPath)) {
        return res.status(404).json({ error: 'Script file not found' });
      }

      // Write the new content
      await fs.writeFile(scriptPath, content, 'utf-8');

      res.json({ message: 'Script updated successfully' });
    } catch (error) {
      logger.error('Error updating tool script:', error);
      res.status(500).json({ error: 'Failed to update tool script' });
    }
  });
}
