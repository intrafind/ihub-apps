import { readFileSync } from 'fs';
import { promises as fs } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { atomicWriteJSON } from '../../utils/atomicWrite.js';
import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import {
  sendNotFound,
  sendBadRequest,
  sendFailedOperationError
} from '../../utils/responseHelpers.js';
import { buildServerPath } from '../../utils/basePath.js';
import { validateIdForPath, validateIdsForPath } from '../../utils/pathSecurity.js';
import logger from '../../utils/logger.js';

/**
 * Find the actual filename for an app ID
 * Handles cases where the filename doesn't match the app ID
 * @param {string} appId - The app ID to search for
 * @param {string} appsDir - The apps directory path
 * @returns {Promise<string|null>} The filename if found, null otherwise
 */
async function findAppFile(appId, appsDir) {
  try {
    const files = await fs.readdir(appsDir);
    const jsonFiles = files.filter(f => f.endsWith('.json'));

    // First try the expected filename
    const expectedFilename = `${appId}.json`;
    if (jsonFiles.includes(expectedFilename)) {
      return expectedFilename;
    }

    // If not found, search through all files to find one with matching ID
    for (const file of jsonFiles) {
      try {
        const filePath = join(appsDir, file);
        const content = await fs.readFile(filePath, 'utf8');
        const app = JSON.parse(content);
        if (app.id === appId) {
          return file;
        }
      } catch (err) {
        // Skip files that can't be read or parsed
        console.debug(`Skipping malformed app file: ${file}`, err.message);
        continue;
      }
    }

    return null;
  } catch (err) {
    console.warn(`Failed to read apps directory: ${appsDir}`, err.message);
    return null;
  }
}

/**
 * @swagger
 * components:
 *   schemas:
 *     AdminApplication:
 *       type: object
 *       description: Complete application configuration with admin-specific fields
 *       required:
 *         - id
 *         - name
 *         - description
 *         - color
 *         - icon
 *         - system
 *         - tokenLimit
 *       properties:
 *         id:
 *           type: string
 *           description: Unique identifier for the application
 *           example: "chat-assistant"
 *         order:
 *           type: number
 *           description: Display order for the application
 *           example: 1
 *         name:
 *           type: object
 *           description: Localized application names
 *           example: { "en": "Chat Assistant", "de": "Chat-Assistent" }
 *         description:
 *           type: object
 *           description: Localized application descriptions
 *           example: { "en": "AI-powered chat assistant" }
 *         color:
 *           type: string
 *           description: UI color theme for the application
 *           example: "blue"
 *         icon:
 *           type: string
 *           description: Icon identifier for the application
 *           example: "chat"
 *         system:
 *           type: object
 *           description: Localized system prompts
 *           example: { "en": "You are a helpful AI assistant..." }
 *         tokenLimit:
 *           type: number
 *           description: Maximum tokens per request
 *           example: 4000
 *         preferredModel:
 *           type: string
 *           description: Default model selection
 *           example: "gpt-4"
 *         preferredOutputFormat:
 *           type: string
 *           description: Output format preference
 *         preferredStyle:
 *           type: string
 *           description: Style preference
 *         preferredTemperature:
 *           type: number
 *           description: Temperature setting (0.0-1.0)
 *           example: 0.7
 *         sendChatHistory:
 *           type: boolean
 *           description: Include chat history in requests
 *         messagePlaceholder:
 *           type: object
 *           description: Localized input placeholder text
 *         prompt:
 *           type: object
 *           description: Localized user prompts
 *         variables:
 *           type: array
 *           description: Input variable definitions
 *           items:
 *             type: object
 *         settings:
 *           description: Additional settings
 *         inputMode:
 *           description: Input mode configuration
 *         imageUpload:
 *           description: Image upload settings
 *         fileUpload:
 *           description: File upload settings
 *         features:
 *           description: Feature flags
 *         greeting:
 *           description: Welcome message
 *         starterPrompts:
 *           type: array
 *           description: Suggested prompts
 *         allowedModels:
 *           type: array
 *           description: Restricted model list
 *           items:
 *             type: string
 *         disallowModelSelection:
 *           type: boolean
 *           description: Hide model selector
 *         allowEmptyContent:
 *           type: boolean
 *           description: Allow empty submissions
 *         tools:
 *           type: array
 *           description: Available tool names
 *           items:
 *             type: string
 *         outputSchema:
 *           description: Structured output schema
 *         category:
 *           type: string
 *           description: Application category
 *           example: "productivity"
 *         enabled:
 *           type: boolean
 *           description: Whether the application is currently enabled
 *           example: true
 *         allowInheritance:
 *           type: boolean
 *           description: Allow this app to be used as a template
 *           example: true
 *         parentId:
 *           type: string
 *           description: Parent app ID for inheritance
 *           example: "base-chat"
 *         inheritanceLevel:
 *           type: number
 *           description: Inheritance depth level
 *         overriddenFields:
 *           type: array
 *           description: Fields overridden from parent
 *           items:
 *             type: string
 *
 *     AppInheritance:
 *       type: object
 *       description: Application inheritance information
 *       properties:
 *         app:
 *           $ref: '#/components/schemas/AdminApplication'
 *         parent:
 *           $ref: '#/components/schemas/AdminApplication'
 *           nullable: true
 *           description: Parent application (null if no parent)
 *         children:
 *           type: array
 *           description: Child applications inheriting from this app
 *           items:
 *             $ref: '#/components/schemas/AdminApplication'
 *
 *     AppOperation:
 *       type: object
 *       description: Result of an application operation
 *       properties:
 *         message:
 *           type: string
 *           description: Operation result message
 *         app:
 *           $ref: '#/components/schemas/AdminApplication'
 *           description: The affected application (for single operations)
 *         enabled:
 *           type: boolean
 *           description: New enabled state (for toggle operations)
 *         ids:
 *           type: array
 *           description: List of affected app IDs (for batch operations)
 *           items:
 *             type: string
 *
 *     AdminError:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *           description: Error message
 *           example: "Failed to update app"
 */

export default function registerAdminAppsRoutes(app, basePath = '') {
  /**
   * @swagger
   * /api/admin/apps:
   *   get:
   *     summary: Get all applications (admin view)
   *     description: |
   *       Retrieves all applications in the system with complete configuration details.
   *       This admin endpoint provides access to all app properties including inheritance settings,
   *       enabled/disabled status, and internal configuration that regular users cannot see.
   *
   *       **Admin Access Required**: This endpoint requires administrator authentication.
   *     tags:
   *       - Admin
   *       - Applications
   *     security:
   *       - adminAuth: []
   *     responses:
   *       200:
   *         description: All applications successfully retrieved
   *         headers:
   *           ETag:
   *             description: Cache validation header for applications list
   *             schema:
   *               type: string
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/AdminApplication'
   *             example:
   *               - id: "chat-assistant"
   *                 order: 1
   *                 name:
   *                   en: "Chat Assistant"
   *                   de: "Chat-Assistent"
   *                 description:
   *                   en: "AI-powered chat assistant for productivity"
   *                 color: "blue"
   *                 icon: "chat"
   *                 system:
   *                   en: "You are a helpful AI assistant..."
   *                 tokenLimit: 4000
   *                 preferredModel: "gpt-4"
   *                 category: "productivity"
   *                 enabled: true
   *                 allowInheritance: true
   *               - id: "code-reviewer"
   *                 order: 2
   *                 name:
   *                   en: "Code Reviewer"
   *                 parentId: "chat-assistant"
   *                 inheritanceLevel: 1
   *                 overriddenFields: ["system", "tools"]
   *                 enabled: true
   *       401:
   *         description: Authentication required
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Admin authentication required"
   *       403:
   *         description: Forbidden - insufficient admin privileges
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Admin access required"
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Failed to fetch apps"
   */
  app.get(buildServerPath('/api/admin/apps', basePath), adminAuth, async (req, res) => {
    try {
      const { data: apps, etag: appsEtag } = configCache.getApps(true);
      res.setHeader('ETag', appsEtag);
      res.json(apps);
    } catch (error) {
      sendFailedOperationError(res, 'fetch apps', error);
    }
  });

  /**
   * @swagger
   * /api/admin/apps/templates:
   *   get:
   *     summary: Get template applications for inheritance
   *     description: |
   *       Retrieves applications that can be used as templates for inheritance.
   *       Only returns apps where allowInheritance is not false and the app is enabled.
   *       These templates can serve as parent applications for creating derived apps.
   *     tags:
   *       - Admin
   *       - Applications
   *       - Inheritance
   *     security:
   *       - adminAuth: []
   *     responses:
   *       200:
   *         description: Template applications successfully retrieved
   *         headers:
   *           ETag:
   *             description: Cache validation header
   *             schema:
   *               type: string
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/AdminApplication'
   *             example:
   *               - id: "base-chat"
   *                 name:
   *                   en: "Base Chat Template"
   *                 allowInheritance: true
   *                 enabled: true
   *               - id: "analysis-template"
   *                 name:
   *                   en: "Analysis Template"
   *                 allowInheritance: true
   *                 enabled: true
   *       401:
   *         description: Authentication required
   *       403:
   *         description: Admin access required
   *       500:
   *         description: Internal server error
   */
  app.get(buildServerPath('/api/admin/apps/templates', basePath), adminAuth, async (req, res) => {
    try {
      const { data: apps, etag: appsEtag } = configCache.getApps(true);
      const templates = apps.filter(app => app.allowInheritance !== false && app.enabled);
      res.setHeader('ETag', appsEtag);
      res.json(templates);
    } catch (error) {
      sendFailedOperationError(res, 'fetch template apps', error);
    }
  });

  /**
   * @swagger
   * /api/admin/apps/{appId}/inheritance:
   *   get:
   *     summary: Get application inheritance information
   *     description: |
   *       Retrieves the complete inheritance chain for a specific application,
   *       including its parent application (if any) and all child applications
   *       that inherit from it.
   *
   *       **Inheritance System:**
   *       - Apps can inherit configuration from a parent app
   *       - Child apps can override specific fields from the parent
   *       - Multiple levels of inheritance are supported
   *       - Inheritance chains help manage app families and reduce configuration duplication
   *     tags:
   *       - Admin
   *       - Applications
   *       - Inheritance
   *     security:
   *       - adminAuth: []
   *     parameters:
   *       - in: path
   *         name: appId
   *         required: true
   *         description: Unique identifier of the application
   *         schema:
   *           type: string
   *           example: "chat-assistant"
   *     responses:
   *       200:
   *         description: Inheritance information successfully retrieved
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AppInheritance'
   *             example:
   *               app:
   *                 id: "specialized-chat"
   *                 name:
   *                   en: "Specialized Chat"
   *                 parentId: "base-chat"
   *                 inheritanceLevel: 1
   *               parent:
   *                 id: "base-chat"
   *                 name:
   *                   en: "Base Chat Template"
   *                 allowInheritance: true
   *               children:
   *                 - id: "child-app-1"
   *                   parentId: "specialized-chat"
   *                 - id: "child-app-2"
   *                   parentId: "specialized-chat"
   *       404:
   *         description: Application not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "App not found"
   *       500:
   *         description: Internal server error
   */
  app.get(
    buildServerPath('/api/admin/apps/:appId/inheritance', basePath),
    adminAuth,
    async (req, res) => {
      try {
        const { appId } = req.params;

        // Validate appId for security
        if (!validateIdForPath(appId, 'app', res)) {
          return;
        }

        const { data: apps } = configCache.getApps(true);
        const app = apps.find(a => a.id === appId);

        if (!app) {
          return sendNotFound(res, 'App');
        }

        const inheritance = {
          app: app,
          parent: null,
          children: []
        };

        if (app.parentId) {
          inheritance.parent = apps.find(a => a.id === app.parentId);
        }
        inheritance.children = apps.filter(a => a.parentId === appId);
        res.json(inheritance);
      } catch (error) {
        sendFailedOperationError(res, 'fetch app inheritance', error);
      }
    }
  );

  app.get(buildServerPath('/api/admin/apps/:appId', basePath), adminAuth, async (req, res) => {
    try {
      const { appId } = req.params;

      // Validate appId for security
      if (!validateIdForPath(appId, 'app', res)) {
        return;
      }

      const { data: apps } = configCache.getApps(true);
      const app = apps.find(a => a.id === appId);

      if (!app) {
        return sendNotFound(res, 'App');
      }

      res.json(app);
    } catch (error) {
      sendFailedOperationError(res, 'fetch app', error);
    }
  });

  /**
   * @swagger
   * /api/admin/apps/{appId}:
   *   put:
   *     summary: Update an existing application
   *     description: |
   *       Updates an existing application's configuration. Performs atomic write
   *       operations to ensure data consistency and refreshes the application cache.
   *
   *       **Validation Rules:**
   *       - Application ID cannot be changed
   *       - Required fields: id, name, description
   *       - All fields are validated against the application schema
   *
   *       **File System Operations:**
   *       - Uses atomic write to prevent corruption
   *       - Automatically refreshes cache after successful update
   *     tags:
   *       - Admin
   *       - Applications
   *     security:
   *       - adminAuth: []
   *     parameters:
   *       - in: path
   *         name: appId
   *         required: true
   *         description: Unique identifier of the application to update
   *         schema:
   *           type: string
   *           example: "chat-assistant"
   *     requestBody:
   *       required: true
   *       description: Updated application configuration
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/AdminApplication'
   *           example:
   *             id: "chat-assistant"
   *             name:
   *               en: "Enhanced Chat Assistant"
   *             description:
   *               en: "Updated AI-powered chat assistant with new features"
   *             color: "purple"
   *             icon: "chat"
   *             system:
   *               en: "You are an enhanced AI assistant..."
   *             tokenLimit: 8000
   *             preferredModel: "gpt-4-turbo"
   *             enabled: true
   *     responses:
   *       200:
   *         description: Application successfully updated
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AppOperation'
   *             example:
   *               message: "App updated successfully"
   *               app:
   *                 id: "chat-assistant"
   *                 name:
   *                   en: "Enhanced Chat Assistant"
   *       400:
   *         description: Bad request - validation error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             examples:
   *               missingFields:
   *                 summary: Missing required fields
   *                 value:
   *                   error: "Missing required fields"
   *               idMismatch:
   *                 summary: App ID cannot be changed
   *                 value:
   *                   error: "App ID cannot be changed"
   *       500:
   *         description: Internal server error
   */
  app.put(buildServerPath('/api/admin/apps/:appId', basePath), adminAuth, async (req, res) => {
    try {
      const { appId } = req.params;
      const updatedApp = req.body;

      // Validate appId for security
      if (!validateIdForPath(appId, 'app', res)) {
        return;
      }

      if (!updatedApp.id || !updatedApp.name || !updatedApp.description) {
        return sendBadRequest(res, 'Missing required fields');
      }
      if (updatedApp.id !== appId) {
        return sendBadRequest(res, 'App ID cannot be changed');
      }

      const rootDir = getRootDir();
      const appsDir = join(rootDir, 'contents', 'apps');
      // Ensure directory exists before writing
      await fs.mkdir(appsDir, { recursive: true });
      // Find the actual file for this app ID (may not match ${appId}.json)
      const filename = await findAppFile(appId, appsDir);
      if (!filename) {
        return res.status(404).json({ error: 'App file not found on disk' });
      }
      const appFilePath = join(appsDir, filename);
      await atomicWriteJSON(appFilePath, updatedApp);
      await configCache.refreshAppsCache();
      res.json({ message: 'App updated successfully', app: updatedApp });
    } catch (error) {
      sendFailedOperationError(res, 'update app', error);
    }
  });

  /**
   * @swagger
   * /api/admin/apps:
   *   post:
   *     summary: Create a new application
   *     description: |
   *       Creates a new application with the provided configuration.
   *       Validates that the application ID is unique and creates the corresponding
   *       JSON file in the file system.
   *
   *       **Validation Rules:**
   *       - Application ID must be unique
   *       - Required fields: id, name, description
   *       - Application ID will be used as filename
   *
   *       **File System Operations:**
   *       - Creates new JSON file in contents/apps/ directory
   *       - Automatically refreshes cache after successful creation
   *     tags:
   *       - Admin
   *       - Applications
   *     security:
   *       - adminAuth: []
   *     requestBody:
   *       required: true
   *       description: New application configuration
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/AdminApplication'
   *           example:
   *             id: "new-assistant"
   *             name:
   *               en: "New Assistant"
   *               de: "Neuer Assistent"
   *             description:
   *               en: "A new AI assistant application"
   *             color: "green"
   *             icon: "assistant"
   *             system:
   *               en: "You are a helpful new assistant..."
   *             tokenLimit: 4000
   *             preferredModel: "gpt-4"
   *             category: "productivity"
   *             enabled: true
   *     responses:
   *       200:
   *         description: Application successfully created
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AppOperation'
   *             example:
   *               message: "App created successfully"
   *               app:
   *                 id: "new-assistant"
   *                 name:
   *                   en: "New Assistant"
   *       400:
   *         description: Bad request - missing required fields
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Missing required fields"
   *       409:
   *         description: Conflict - app with ID already exists
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "App with this ID already exists"
   *       500:
   *         description: Internal server error
   */
  app.post(buildServerPath('/api/admin/apps', basePath), adminAuth, async (req, res) => {
    try {
      const newApp = req.body;
      if (!newApp.id || !newApp.name || !newApp.description) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Validate newApp.id for security
      if (!validateIdForPath(newApp.id, 'app', res)) {
        return;
      }

      const rootDir = getRootDir();
      const appsDir = join(rootDir, 'contents', 'apps');
      const appFilePath = join(appsDir, `${newApp.id}.json`);
      try {
        readFileSync(appFilePath, 'utf8');
        return res.status(409).json({ error: 'App with this ID already exists' });
      } catch {
        // file does not exist
      }
      // Ensure directory exists before writing
      await fs.mkdir(appsDir, { recursive: true });
      await fs.writeFile(appFilePath, JSON.stringify(newApp, null, 2));
      await configCache.refreshAppsCache();
      res.json({ message: 'App created successfully', app: newApp });
    } catch (error) {
      logger.error('Error creating app:', error);
      res.status(500).json({ error: 'Failed to create app' });
    }
  });

  /**
   * @swagger
   * /api/admin/apps/{appId}/toggle:
   *   post:
   *     summary: Toggle application enabled/disabled status
   *     description: |
   *       Toggles the enabled status of a specific application.
   *       If the app is currently enabled, it will be disabled, and vice versa.
   *       Updates the application file and refreshes the cache.
   *     tags:
   *       - Admin
   *       - Applications
   *     security:
   *       - adminAuth: []
   *     parameters:
   *       - in: path
   *         name: appId
   *         required: true
   *         description: Unique identifier of the application to toggle
   *         schema:
   *           type: string
   *           example: "chat-assistant"
   *     responses:
   *       200:
   *         description: Application status successfully toggled
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AppOperation'
   *             examples:
   *               enabled:
   *                 summary: App enabled
   *                 value:
   *                   message: "App enabled successfully"
   *                   enabled: true
   *                   app:
   *                     id: "chat-assistant"
   *                     enabled: true
   *               disabled:
   *                 summary: App disabled
   *                 value:
   *                   message: "App disabled successfully"
   *                   enabled: false
   *                   app:
   *                     id: "chat-assistant"
   *                     enabled: false
   *       404:
   *         description: Application not found
   *       500:
   *         description: Internal server error
   */
  app.post(
    buildServerPath('/api/admin/apps/:appId/toggle', basePath),
    adminAuth,
    async (req, res) => {
      try {
        const { appId } = req.params;

        // Validate appId for security
        if (!validateIdForPath(appId, 'app', res)) {
          return;
        }

        const { data: apps } = configCache.getApps(true);
        const app = apps.find(a => a.id === appId);
        if (!app) {
          return sendNotFound(res, 'App');
        }
        const newEnabledState = !app.enabled;
        app.enabled = newEnabledState;
        const rootDir = getRootDir();
        const appsDir = join(rootDir, 'contents', 'apps');
        // Ensure directory exists before writing
        await fs.mkdir(appsDir, { recursive: true });
        // Find the actual file for this app ID (may not match ${appId}.json)
        const filename = await findAppFile(appId, appsDir);
        if (!filename) {
          return res.status(404).json({ error: 'App file not found on disk' });
        }
        const appFilePath = join(appsDir, filename);
        await fs.writeFile(appFilePath, JSON.stringify(app, null, 2));
        await configCache.refreshAppsCache();
        res.json({
          message: `App ${newEnabledState ? 'enabled' : 'disabled'} successfully`,
          app: app,
          enabled: newEnabledState
        });
      } catch (error) {
        logger.error('Error toggling app:', error);
        res.status(500).json({ error: 'Failed to toggle app' });
      }
    }
  );

  /**
   * @swagger
   * /api/admin/apps/{appIds}/_toggle:
   *   post:
   *     summary: Batch toggle applications enabled/disabled status
   *     description: |
   *       Toggles the enabled status for multiple applications at once.
   *       Accepts comma-separated app IDs or '*' for all apps.
   *       The enabled flag in the request body determines the new state for all specified apps.
   *
   *       **Batch Operations:**
   *       - Use comma-separated IDs: "app1,app2,app3"
   *       - Use '*' for all applications
   *       - Only updates apps that need status change (performance optimization)
   *     tags:
   *       - Admin
   *       - Applications
   *     security:
   *       - adminAuth: []
   *     parameters:
   *       - in: path
   *         name: appIds
   *         required: true
   *         description: |
   *           Comma-separated list of app IDs to toggle, or '*' for all apps
   *         schema:
   *           type: string
   *           example: "chat-assistant,code-reviewer,translator"
   *     requestBody:
   *       required: true
   *       description: Target enabled state for all specified applications
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - enabled
   *             properties:
   *               enabled:
   *                 type: boolean
   *                 description: New enabled state for all specified apps
   *           example:
   *             enabled: true
   *     responses:
   *       200:
   *         description: Applications successfully toggled
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AppOperation'
   *             examples:
   *               batchEnabled:
   *                 summary: Multiple apps enabled
   *                 value:
   *                   message: "Apps enabled successfully"
   *                   enabled: true
   *                   ids: ["chat-assistant", "code-reviewer"]
   *               allAppsDisabled:
   *                 summary: All apps disabled
   *                 value:
   *                   message: "Apps disabled successfully"
   *                   enabled: false
   *                   ids: ["*"]
   *       400:
   *         description: Bad request - missing enabled flag
   *       500:
   *         description: Internal server error
   */
  app.post(
    buildServerPath('/api/admin/apps/:appIds/_toggle', basePath),
    adminAuth,
    async (req, res) => {
      try {
        const { appIds } = req.params;
        const { enabled } = req.body;
        if (typeof enabled !== 'boolean') {
          return res.status(400).json({ error: 'Missing enabled flag' });
        }

        // Validate appIds for security
        const ids = validateIdsForPath(appIds, 'app', res);
        if (!ids) {
          return;
        }

        const { data: apps } = configCache.getApps(true);
        const resolvedIds = ids.includes('*') ? apps.map(a => a.id) : ids;
        const rootDir = getRootDir();
        const appsDir = join(rootDir, 'contents', 'apps');
        // Ensure directory exists before writing
        await fs.mkdir(appsDir, { recursive: true });

        for (const id of resolvedIds) {
          const app = apps.find(a => a.id === id);
          if (!app) continue;
          if (app.enabled !== enabled) {
            app.enabled = enabled;
            // Find the actual file for this app ID (may not match ${id}.json)
            const filename = await findAppFile(id, appsDir);
            if (!filename) {
              console.warn(`App file not found for ID: ${id}`);
              continue;
            }
            const appFilePath = join(appsDir, filename);
            await fs.writeFile(appFilePath, JSON.stringify(app, null, 2));
          }
        }

        await configCache.refreshAppsCache();
        res.json({
          message: `Apps ${enabled ? 'enabled' : 'disabled'} successfully`,
          enabled,
          ids: resolvedIds
        });
      } catch (error) {
        logger.error('Error toggling apps:', error);
        res.status(500).json({ error: 'Failed to toggle apps' });
      }
    }
  );

  /**
   * @swagger
   * /api/admin/apps/{appId}:
   *   delete:
   *     summary: Delete an application
   *     description: |
   *       Permanently deletes an application and its configuration file.
   *       This operation cannot be undone. The application file is removed from
   *       the file system and the cache is refreshed.
   *
   *       **Warning:** This is a destructive operation that cannot be reversed.
   *       Consider disabling the app instead if you might need it later.
   *     tags:
   *       - Admin
   *       - Applications
   *     security:
   *       - adminAuth: []
   *     parameters:
   *       - in: path
   *         name: appId
   *         required: true
   *         description: Unique identifier of the application to delete
   *         schema:
   *           type: string
   *           example: "obsolete-app"
   *     responses:
   *       200:
   *         description: Application successfully deleted
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *             example:
   *               message: "App deleted successfully"
   *       404:
   *         description: Application not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "App not found"
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             example:
   *               error: "Failed to delete app"
   */
  app.delete(buildServerPath('/api/admin/apps/:appId', basePath), adminAuth, async (req, res) => {
    try {
      const { appId } = req.params;

      // Validate appId for security
      if (!validateIdForPath(appId, 'app', res)) {
        return;
      }

      const rootDir = getRootDir();
      const appFilePath = join(rootDir, 'contents', 'apps', `${appId}.json`);
      try {
        readFileSync(appFilePath, 'utf8');
      } catch {
        return res.status(404).json({ error: 'App not found' });
      }
      await fs.unlink(appFilePath);
      await configCache.refreshAppsCache();
      res.json({ message: 'App deleted successfully' });
    } catch (error) {
      logger.error('Error deleting app:', error);
      res.status(500).json({ error: 'Failed to delete app' });
    }
  });
}
