import { readFileSync, existsSync } from 'fs';
import { promises as fs } from 'fs';
import { join, basename } from 'path';
import { createHash } from 'crypto';
import { getRootDir } from '../../pathUtils.js';
import configCache from '../../configCache.js';
import { loadToolsFromFiles } from '../../toolsLoader.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { buildServerPath } from '../../utils/basePath.js';
import { validateIdForPath, resolveAndValidatePath } from '../../utils/pathSecurity.js';
import logger from '../../utils/logger.js';
import { saveSnapshot } from '../../services/ChangeHistoryService.js';
import {
  sendInternalError,
  sendNotFound,
  sendBadRequest,
  sendFailedOperationError
} from '../../utils/responseHelpers.js';

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
 * Filter out expanded tools (those with a 'method' property) from a list —
 * but PRESERVE intentionally script-bound tools like the agent tools
 * registered by V042/V045 (`script: 'agentTools.js'` + `method: '...'` +
 * `isAgentTool: true`). The original "expanded tools" filter targets
 * accidentally persisted runtime expansions; for script-bound tools,
 * `method` is the canonical reference to the exported function and must
 * survive admin round-trips.
 */
function filterExpandedTools(tools) {
  return tools.filter(tool => {
    if (!tool.method) return true;
    if (tool.isAgentTool === true) return true;
    if (typeof tool.script === 'string' && tool.script.length > 0) return true;
    return false;
  });
}

/**
 * Load raw tool definitions (unexpanded) merged from both the legacy
 * config/tools.json file and individual files in contents/tools/.
 * Individual files take precedence over legacy entries with the same ID.
 * For admin operations, we need the original tool definitions, not the
 * expanded (per-function) ones used at runtime.
 */
async function loadRawTools() {
  const rootDir = getRootDir();
  const contentsDir = process.env.CONTENTS_DIR || 'contents';
  const toolsFilePath = join(rootDir, contentsDir, 'config', 'tools.json');

  let legacyTools = [];
  let needsCleanup = false;

  if (existsSync(toolsFilePath)) {
    const fileContent = readFileSync(toolsFilePath, 'utf-8');
    const allLegacyTools = JSON.parse(fileContent);
    legacyTools = filterExpandedTools(allLegacyTools);

    // Check if we filtered any tools out
    if (legacyTools.length !== allLegacyTools.length) {
      needsCleanup = true;
      logger.info('Detected expanded tools in config file', {
        component: 'AdminTools',
        expandedCount: allLegacyTools.length - legacyTools.length,
        toolsFilePath
      });
      logger.info('Filtered raw tool definitions', {
        component: 'AdminTools',
        count: legacyTools.length
      });
    }
  }

  const individualTools = filterExpandedTools(await loadToolsFromFiles(false));

  // Merge: individual files override legacy entries with the same ID
  const merged = new Map();
  for (const tool of legacyTools) merged.set(tool.id, tool);
  for (const tool of individualTools) merged.set(tool.id, tool);

  return {
    tools: Array.from(merged.values()),
    legacyTools,
    needsCleanup,
    filePath: toolsFilePath
  };
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
      const { tools, legacyTools, needsCleanup, filePath } = await loadRawTools();

      if (!tools) {
        return sendFailedOperationError(
          res,
          'load tools configuration',
          new Error('tools is null')
        );
      }

      // If we detected expanded tools, clean up the legacy file
      if (needsCleanup && filePath) {
        try {
          const rootDir = getRootDir();
          const contentsDir = process.env.CONTENTS_DIR || 'contents';
          await fs.mkdir(join(rootDir, contentsDir, 'config'), { recursive: true });
          await fs.writeFile(filePath, JSON.stringify(legacyTools, null, 2));
          logger.info('Cleaned up tools file - removed expanded tools', {
            component: 'AdminTools',
            filePath
          });
        } catch (cleanupError) {
          logger.error('Failed to cleanup tools file', {
            component: 'AdminTools',
            error: cleanupError
          });
          // Don't fail the request, just log the error
        }
      }

      // Workflows are managed as a dedicated app.workflows array (first-class
      // citizens), so they are intentionally NOT mixed into the tools list.

      // Generate ETag for caching using MD5 hash (same as configCache)
      const hash = createHash('md5');
      hash.update(JSON.stringify(tools));
      const etag = `"${hash.digest('hex')}"`;

      if (etag) {
        res.setHeader('ETag', etag);
        const clientETag = req.headers['if-none-match'];
        if (clientETag && clientETag === etag) {
          return res.status(304).end();
        }
      }
      res.json(tools);
    } catch (error) {
      return sendInternalError(res, error, 'fetch tools');
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
      const { tools } = await loadRawTools();
      const tool = tools.find(t => t.id === toolId);

      if (!tool) {
        return sendNotFound(res, 'Tool');
      }
      res.json(tool);
    } catch (error) {
      return sendInternalError(res, error, 'fetch tool');
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

      // Validate required fields. Description is optional — per-tool schemas
      // (e.g. openApiToolDefSchema) decide what else is mandatory.
      if (!updatedTool.id || !updatedTool.name) {
        return sendBadRequest(res, 'Missing required fields: id, name');
      }

      if (updatedTool.id !== toolId) {
        return sendBadRequest(res, 'Tool ID cannot be changed');
      }

      // Validate OpenAPI tool definitions against their schema
      if (updatedTool.type === 'openapi') {
        const { validateOpenApiToolDef } = await import('../../validators/openApiToolDefSchema.js');
        const result = validateOpenApiToolDef(updatedTool);
        if (!result.success) {
          return sendBadRequest(res, 'Invalid OpenAPI tool definition', result.errors);
        }
      }

      const rootDir = getRootDir();
      const contentsDir = process.env.CONTENTS_DIR || 'contents';
      const toolsDir = join(rootDir, contentsDir, 'tools');

      // Load existing tools (raw, unexpanded) to confirm the tool exists
      const { tools } = await loadRawTools();
      const oldTool = tools.find(t => t.id === toolId);

      if (!oldTool) {
        return sendNotFound(res, 'Tool');
      }

      // Persist the update to the tool's individual file (migrates
      // legacy-sourced tools to the per-file store on first edit). The
      // filename is re-derived with path.basename() (stripping any
      // directory components) so the write target can't escape toolsDir,
      // in addition to the resolveAndValidatePath containment check.
      await fs.mkdir(toolsDir, { recursive: true });
      const safeToolFileName = basename(`${toolId}.json`);
      const validatedToolPath = await resolveAndValidatePath(safeToolFileName, toolsDir);
      if (!validatedToolPath) {
        return sendBadRequest(res, 'Invalid tool path');
      }
      const toolFilePath = join(toolsDir, safeToolFileName);
      await fs.writeFile(toolFilePath, JSON.stringify(updatedTool, null, 2));

      // Refresh cache
      await configCache.refreshToolsCache();

      try {
        await saveSnapshot({
          resource: 'tool',
          id: toolId,
          before: oldTool,
          after: updatedTool,
          admin: req.user?.username ?? req.user?.name ?? req.user?.id ?? 'unknown'
        });
      } catch {
        /* skip */
      }

      res.json({ message: 'Tool updated successfully', tool: updatedTool });
    } catch (error) {
      return sendInternalError(res, error, 'update tool');
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

      // Validate required fields. Description is optional — per-tool schemas
      // (e.g. openApiToolDefSchema) decide what else is mandatory.
      if (!newTool.id || !newTool.name) {
        return sendBadRequest(res, 'Missing required fields: id, name');
      }

      // Validate toolId for security
      if (!validateIdForPath(newTool.id, 'tool', res)) {
        return;
      }

      // Validate OpenAPI tool definitions against their schema
      if (newTool.type === 'openapi') {
        const { validateOpenApiToolDef } = await import('../../validators/openApiToolDefSchema.js');
        const result = validateOpenApiToolDef(newTool);
        if (!result.success) {
          return sendBadRequest(res, 'Invalid OpenAPI tool definition', result.errors);
        }
      }

      const rootDir = getRootDir();
      const contentsDir = process.env.CONTENTS_DIR || 'contents';
      const toolsDir = join(rootDir, contentsDir, 'tools');

      // Load existing tools (raw, unexpanded)
      const { tools } = await loadRawTools();

      // Check if tool already exists
      if (tools.find(t => t.id === newTool.id)) {
        return sendBadRequest(res, 'Tool with this ID already exists');
      }

      // Set default enabled state if not provided
      if (newTool.enabled === undefined) {
        newTool.enabled = true;
      }

      // Create the new tool as its own individual file. The filename is
      // re-derived with path.basename() (stripping any directory
      // components) so the write target can't escape toolsDir, in
      // addition to the resolveAndValidatePath containment check.
      await fs.mkdir(toolsDir, { recursive: true });
      const safeNewToolFileName = basename(`${newTool.id}.json`);
      const validatedNewToolPath = await resolveAndValidatePath(safeNewToolFileName, toolsDir);
      if (!validatedNewToolPath) {
        return sendBadRequest(res, 'Invalid tool path');
      }
      const newToolFilePath = join(toolsDir, safeNewToolFileName);
      await fs.writeFile(newToolFilePath, JSON.stringify(newTool, null, 2));

      // Refresh cache
      await configCache.refreshToolsCache();

      try {
        await saveSnapshot({
          resource: 'tool',
          id: newTool.id,
          before: null,
          after: newTool,
          admin: req.user?.username ?? req.user?.name ?? req.user?.id ?? 'unknown'
        });
      } catch {
        /* skip */
      }

      res.status(201).json({ message: 'Tool created successfully', tool: newTool });
    } catch (error) {
      return sendInternalError(res, error, 'create tool');
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
      const toolsDir = join(rootDir, contentsDir, 'tools');

      // Load existing tools (raw, unexpanded) to confirm the tool exists
      const { tools, legacyTools } = await loadRawTools();
      const tool = tools.find(t => t.id === toolId);

      if (!tool) {
        return sendNotFound(res, 'Tool');
      }

      // Delete the script file if it exists (only for non-special tools)
      if (tool.script && !tool.isSpecialTool && !tool.provider) {
        const scriptPath = join(rootDir, 'server', 'tools', tool.script);
        try {
          if (existsSync(scriptPath)) {
            await fs.unlink(scriptPath);
            logger.info('Deleted script file', { component: 'AdminTools', script: tool.script });
          }
        } catch (scriptError) {
          logger.warn('Failed to delete script file', {
            component: 'AdminTools',
            script: tool.script,
            error: scriptError.message
          });
          // Continue with config deletion even if script deletion fails
        }
      }

      // Remove the tool's individual file, if it has been migrated there.
      // The filename is re-derived with path.basename() (stripping any
      // directory components) so the target can't escape toolsDir, in
      // addition to the resolveAndValidatePath containment check.
      const safeDeleteFileName = basename(`${toolId}.json`);
      const validatedDeletePath = await resolveAndValidatePath(safeDeleteFileName, toolsDir);
      const individualToolPath = join(toolsDir, safeDeleteFileName);
      const hasIndividualToolFile = validatedDeletePath && existsSync(individualToolPath);
      if (hasIndividualToolFile) {
        await fs.unlink(individualToolPath);
      }

      // Remove the tool from the legacy config file, if it's still stored there
      if (legacyTools.some(t => t.id === toolId)) {
        const remainingLegacyTools = legacyTools.filter(t => t.id !== toolId);
        await fs.mkdir(join(rootDir, contentsDir, 'config'), { recursive: true });
        await fs.writeFile(toolsFilePath, JSON.stringify(remainingLegacyTools, null, 2));
      }

      // Refresh cache
      await configCache.refreshToolsCache();

      try {
        await saveSnapshot({
          resource: 'tool',
          id: toolId,
          before: tool,
          after: null,
          admin: req.user?.username ?? req.user?.name ?? req.user?.id ?? 'unknown'
        });
      } catch {
        /* skip */
      }

      res.json({
        message: 'Tool deleted successfully',
        scriptDeleted: tool.script ? true : false
      });
    } catch (error) {
      return sendInternalError(res, error, 'delete tool');
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
      const toolsDir = join(rootDir, contentsDir, 'tools');

      // Load existing tools (raw, unexpanded)
      const { tools } = await loadRawTools();
      const tool = tools.find(t => t.id === toolId);

      if (!tool) {
        return sendNotFound(res, 'Tool');
      }

      // Toggle enabled state
      tool.enabled = !tool.enabled;

      // Persist to the tool's individual file (migrates legacy-sourced
      // tools to the per-file store on first toggle). The filename is
      // re-derived with path.basename() (stripping any directory
      // components) so the write target can't escape toolsDir, in
      // addition to the resolveAndValidatePath containment check.
      await fs.mkdir(toolsDir, { recursive: true });
      const safeToggleFileName = basename(`${toolId}.json`);
      const validatedTogglePath = await resolveAndValidatePath(safeToggleFileName, toolsDir);
      if (!validatedTogglePath) {
        return sendBadRequest(res, 'Invalid tool path');
      }
      const toolFilePath = join(toolsDir, safeToggleFileName);
      await fs.writeFile(toolFilePath, JSON.stringify(tool, null, 2));

      // Refresh cache
      await configCache.refreshToolsCache();

      res.json({ message: 'Tool state updated successfully', enabled: tool.enabled });
    } catch (error) {
      return sendInternalError(res, error, 'toggle tool');
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

      const { tools } = await loadRawTools();
      const tool = tools.find(t => t.id === toolId);

      if (!tool) {
        return sendNotFound(res, 'Tool');
      }

      if (!tool.script) {
        return sendBadRequest(res, 'Tool has no script property (may be a special tool)');
      }

      const rootDir = getRootDir();
      const scriptPath = join(rootDir, 'server', 'tools', tool.script);

      if (!existsSync(scriptPath)) {
        return sendNotFound(res, 'Script file');
      }

      const content = readFileSync(scriptPath, 'utf-8');

      res.json({
        id: toolId,
        script: tool.script,
        content
      });
    } catch (error) {
      return sendInternalError(res, error, 'read tool script');
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
        return sendBadRequest(res, 'Missing script content');
      }

      // Validate toolId for security
      if (!validateIdForPath(toolId, 'tool', res)) {
        return;
      }

      const { tools } = await loadRawTools();
      const tool = tools.find(t => t.id === toolId);

      if (!tool) {
        return sendNotFound(res, 'Tool');
      }

      if (!tool.script) {
        return sendBadRequest(res, 'Tool has no script property (may be a special tool)');
      }

      const rootDir = getRootDir();
      const scriptPath = join(rootDir, 'server', 'tools', tool.script);

      if (!existsSync(scriptPath)) {
        return sendNotFound(res, 'Script file');
      }

      // Write the new content
      await fs.writeFile(scriptPath, content, 'utf-8');

      res.json({ message: 'Script updated successfully' });
    } catch (error) {
      return sendInternalError(res, error, 'update tool script');
    }
  });

  /**
   * @swagger
   * /api/admin/tools/openapi/parse:
   *   post:
   *     summary: Parse an OpenAPI document and list its operations
   *     description: |
   *       Fetches (SSRF-guarded) and parses an OpenAPI 3.x document, returning
   *       its operations so the admin UI can present an operation picker for
   *       building a `type: "openapi"` tool.
   *     tags:
   *       - Admin - Tools
   *     security:
   *       - bearerAuth: []
   *       - sessionAuth: []
   */
  app.post(buildServerPath('/api/admin/tools/openapi/parse'), adminAuth, async (req, res) => {
    try {
      const { source } = req.body || {};
      if (!source || !source.type) {
        return sendBadRequest(res, 'Missing OpenAPI source ({ type, url|path|spec })');
      }

      let raw;
      if (source.type === 'url') {
        if (!/^https?:\/\//i.test(source.url || '')) {
          return sendBadRequest(res, 'Only http(s) OpenAPI URLs are supported');
        }
        const { safeFetch } = await import('../../services/mcp/safeFetch.js');
        // SSRF is mitigated by safeFetch: it resolves DNS once, rejects
        // private/internal IPs (blockPrivateIps), and pins the socket to the
        // validated address to defeat DNS rebinding. This admin-only endpoint
        // must fetch an operator-supplied OpenAPI URL, so the host cannot be
        // allow-listed. CodeQL cannot see the guard across the call boundary.
        const fetchRes = await safeFetch(source.url, { method: 'GET' }, { blockPrivateIps: true }); // codeql[js/request-forgery]
        if (!fetchRes.ok) {
          return sendBadRequest(res, `Failed to fetch OpenAPI doc: ${fetchRes.status}`);
        }
        const text = await fetchRes.text();
        if (Buffer.byteLength(text) > 2 * 1024 * 1024) {
          return sendBadRequest(res, 'OpenAPI document exceeds the 2MB limit');
        }
        const { parseOpenApiText } = await import('../../services/tools/OpenApiToolRunner.js');
        raw = parseOpenApiText(text);
      } else if (source.type === 'inline') {
        const { parseOpenApiText } = await import('../../services/tools/OpenApiToolRunner.js');
        raw = typeof source.spec === 'string' ? parseOpenApiText(source.spec) : source.spec;
      } else {
        return sendBadRequest(res, 'Unsupported source type for parsing (use url or inline)');
      }

      const SwaggerParser = (await import('@apidevtools/swagger-parser')).default;
      // external:false prevents dereferencing from following external $refs
      // (remote URLs / local files), which would bypass the SSRF guard above.
      const spec = await SwaggerParser.dereference(raw, { resolve: { external: false } });

      const methods = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];
      const operations = [];
      for (const [path, pathItem] of Object.entries(spec.paths || {})) {
        if (!pathItem || typeof pathItem !== 'object') continue;
        const shared = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
        for (const method of methods) {
          const op = pathItem[method];
          if (!op || typeof op !== 'object') continue;
          operations.push({
            operationId: op.operationId,
            method,
            path,
            summary: op.summary || op.description || '',
            parameters: [...shared, ...(op.parameters || [])].map(p => ({
              name: p.name,
              in: p.in,
              required: Boolean(p.required)
            })),
            hasRequestBody: Boolean(op.requestBody)
          });
        }
      }

      res.json({
        info: { title: spec.info?.title, version: spec.info?.version },
        servers: (spec.servers || []).map(s => ({ url: s.url })),
        operations
      });
    } catch (error) {
      return sendBadRequest(res, `Failed to parse OpenAPI document: ${error.message}`);
    }
  });
}
