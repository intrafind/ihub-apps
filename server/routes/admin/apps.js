// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configStore from '../../services/config/ConfigStore.js';
import configCache from '../../configCache.js';
import { contentAdminAuth } from '../../middleware/contentAdminAuth.js';
import { ServiceError } from '../../utils/ServiceError.js';
import { buildServerPath } from '../../utils/basePath.js';
import { responseEtag } from '../../utils/etag.js';
import {
  assertIfMatch,
  parseIfMatch,
  revisionOf,
  setRevisionHeaders
} from '../../utils/configRevision.js';
import { assertValidId, assertValidIds } from '../../utils/pathSecurity.js';
import { prepareStoredResource } from '../../resourceLoaders.js';
import logger from '../../utils/logger.js';
import { removeMarketplaceInstallation } from '../../utils/installationCleanup.js';
import { logAudit } from '../../services/AuditLogService.js';
import { saveSnapshot } from '../../services/ChangeHistoryService.js';
import { appConfigSchema } from '../../validators/appConfigSchema.js';
import { describeIssues } from '../../validators/userPromptSchema.js';
import { getIntegrationStatus } from '../../integrationRegistry.js';
import { sendCreated, segment } from '../../utils/created.js';
import { APP_CREATE_ORIGINS } from '../../../shared/appGenerator.js';
import { findAppDependants } from '../../utils/resourceDependants.js';

/**
 * Validate an app configuration an admin is about to save, and answer 400 when
 * it does not pass the app schema.
 *
 * This is the same schema the apps loader applies. The loader only warns, so
 * an existing file that fails validation still loads; a write through the admin
 * API is held to the schema instead, so an invalid configuration (for example a
 * redirect or iframe URL that is not http(s)) is never stored. The body is
 * validated as sent and stored unchanged — schema defaults are not written into
 * the file.
 *
 * @param {object} appConfig - App configuration from the request body.
 * @throws {ServiceError} `VALIDATION_FAILED` (400) with the failed fields in `details.issues`
 */
function assertValidAppConfig(appConfig) {
  const result = appConfigSchema.safeParse(appConfig);
  if (result.success) return;
  throw new ServiceError(
    'VALIDATION_FAILED',
    `Invalid app configuration: ${describeIssues(result.error)}`,
    {
      details: {
        issues: result.error.issues.map(issue => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message
        }))
      }
    }
  );
}

/**
 * The stored body of an app file, for its revision (`ETag`). `null` when the
 * file cannot be found or read: its revision is then that of a missing file,
 * which a later `If-Match` save refuses unless the file is still missing.
 *
 * @param {string} appId - A valid app ID.
 * @returns {Promise<object|null>}
 */
async function readStoredApp(appId) {
  const appFilePath = await configStore.resolveIdToPath('apps', appId, { createIfMissing: false });
  return appFilePath ? configStore.readJson(appFilePath) : null;
}

/**
 * The `origin` query parameter of `POST /api/admin/apps`: how the app was
 * started (`blank`, `template`, `copy`, `generated`, `link`, `upload`). It is
 * audit metadata and changes nothing about the app that is created.
 *
 * It is a query parameter because the body is the app itself: the app schema
 * is strict and the body is stored as sent, so a body field would be refused
 * or end up in the app file.
 *
 * @param {unknown} value - `req.query.origin`
 * @returns {string|undefined} The origin, or undefined when the parameter is absent.
 * @throws {ServiceError} `VALIDATION_FAILED` (400) for any other value
 */
function readCreateOrigin(value) {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && APP_CREATE_ORIGINS.includes(value)) return value;
  const message = `origin must be one of: ${APP_CREATE_ORIGINS.join(', ')}`;
  throw new ServiceError('VALIDATION_FAILED', message, {
    details: [{ path: 'origin', code: 'INVALID', message }]
  });
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
 *         integrations:
 *           type: object
 *           description: Installed integrations the app binds (an installation id, a definition id or `type:<type>`), each with an optional `actions` list; the app's tools come from them
 *           additionalProperties:
 *             type: object
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

export default function registerAdminAppsRoutes(app) {
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
   *                 overriddenFields: ["system", "preferredModel"]
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
  app.get(buildServerPath('/api/admin/apps'), contentAdminAuth, async (req, res) => {
    const { data: apps, etag: appsEtag } = configCache.getApps(true);
    res.setHeader('ETag', responseEtag(appsEtag));
    res.json({ items: apps });
  });

  /**
   * @swagger
   * /api/admin/apps/templates:
   *   get:
   *     summary: Get template applications for inheritance
   *     description: |
   *       The applications a new app can be copied from in the Create App dialog:
   *       every enabled app. `allowInheritance` does not narrow the list: the
   *       schema defaults it to `false` and no admin screen sets it, so a filter on
   *       it left the dialog empty.
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
  app.get(buildServerPath('/api/admin/apps/templates'), contentAdminAuth, async (req, res) => {
    const { data: apps, etag: appsEtag } = configCache.getApps(true);
    // Every enabled app can be copied. `allowInheritance` is `false` unless an
    // app sets it (schema default) and nothing in the admin sets it, so
    // filtering on it returned an empty list (AI-B4).
    const templates = apps.filter(app => app.enabled);
    res.setHeader('ETag', responseEtag(appsEtag));
    res.json({ items: templates });
  });

  /**
   * @swagger
   * /api/admin/apps/integration-status:
   *   get:
   *     summary: Which integrations are on
   *     description: Whether each integration an app can require (`requiredIntegrations`) is set up and switched on. While one is off, users do not get the apps that need it.
   *     tags:
   *       - Admin
   *       - Applications
   *     security:
   *       - adminAuth: []
   *     responses:
   *       200:
   *         description: 'Installation and definition ids with their state, e.g. `{"ifinder": true, "com.intrafind/ldap-directory": false}`'
   *       401:
   *         description: Authentication required
   *       403:
   *         description: Admin access required
   */
  app.get(buildServerPath('/api/admin/apps/integration-status'), contentAdminAuth, (req, res) => {
    res.json(getIntegrationStatus(configCache.getIntegrationContext()));
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
    buildServerPath('/api/admin/apps/:appId/inheritance'),
    contentAdminAuth,
    async (req, res) => {
      const { appId } = req.params;

      // Validate appId for security
      assertValidId(appId, 'app');

      const { data: apps } = configCache.getApps(true);
      const app = apps.find(a => a.id === appId);

      if (!app) {
        throw new ServiceError('NOT_FOUND', 'App not found');
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
    }
  );

  /**
   * @swagger
   * /api/admin/apps/{appId}/_dependants:
   *   get:
   *     summary: What refers to an app
   *     description: |
   *       Read-only. Lists what names the app, so the delete dialog can say what loses its
   *       reference before the app is deleted. Nothing here blocks a delete: a prompt whose
   *       app is gone opens without it, an app-as-tool entry naming no app offers no tool, a
   *       group entry naming no app grants nothing. A delete keeps a copy in the change
   *       history, from which an administrator can restore the app.
   *     tags:
   *       - Admin
   *       - Applications
   *     security:
   *       - adminAuth: []
   *     parameters:
   *       - in: path
   *         name: appId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The references
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 prompts:
   *                   type: array
   *                   description: Prompts that open in the app (`appId`)
   *                   items:
   *                     type: object
   *                     properties:
   *                       id: { type: string }
   *                       name: { description: "Localized name object or text" }
   *                 apps:
   *                   type: array
   *                   description: Apps that call it as a tool or inherit from it
   *                   items:
   *                     type: object
   *                     properties:
   *                       id: { type: string }
   *                       name: { description: "Localized name object or text" }
   *                       references:
   *                         type: array
   *                         items: { type: string, enum: [tool, parent] }
   *                 workflows:
   *                   type: array
   *                   description: Workflows with a node that calls it as a tool
   *                   items:
   *                     type: object
   *                     properties:
   *                       id: { type: string }
   *                       name: { description: "Localized name object or text" }
   *                 groups:
   *                   type: array
   *                   description: Groups whose app permissions list it by id
   *                   items:
   *                     type: object
   *                     properties:
   *                       id: { type: string }
   *                       name: { type: string }
   *       400:
   *         description: "`BAD_REQUEST`: invalid app id"
   *       404:
   *         description: "`NOT_FOUND`: no such app"
   */
  app.get(
    buildServerPath('/api/admin/apps/:appId/_dependants'),
    contentAdminAuth,
    async (req, res) => {
      const { appId } = req.params;
      assertValidId(appId, 'app');
      const { data: apps = [] } = configCache.getApps(true);
      if (!apps.some(candidate => candidate.id === appId)) {
        throw new ServiceError('NOT_FOUND', 'App not found');
      }
      const dependants = findAppDependants(appId, {
        apps,
        prompts: configCache.getPrompts(true)?.data ?? [],
        workflows: configCache.getWorkflows(true)?.data ?? [],
        // The authored file: the cache's groups carry their parents' permissions as their own.
        groupsConfig: await configStore.readJson('config/groups.json').catch(() => null)
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json(dependants);
    }
  );

  /**
   * @swagger
   * /api/admin/apps/{appId}:
   *   get:
   *     summary: Get one application
   *     description: |
   *       The app as the server runs it: the stored app file with the schema's
   *       defaults applied. The `ETag` header carries the revision of that same
   *       stored file; send it as `If-Match` on `PUT /api/admin/apps/{appId}`
   *       (or on `POST /api/admin/apps/{appId}/_toggle`) to refuse a change over
   *       one someone else saved in the meantime.
   *     tags:
   *       - Admin
   *       - Applications
   *     security:
   *       - adminAuth: []
   *     parameters:
   *       - in: path
   *         name: appId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The app
   *         headers:
   *           ETag:
   *             description: Revision of the stored app file
   *             schema:
   *               type: string
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminApplication'
   *       400:
   *         description: "`BAD_REQUEST`: invalid app id"
   *       404:
   *         description: "`NOT_FOUND`: no such app"
   */
  app.get(buildServerPath('/api/admin/apps/:appId'), contentAdminAuth, async (req, res) => {
    const { appId } = req.params;

    // Validate appId for security
    assertValidId(appId, 'app');

    // Body and revision come from one read of the stored file. The cache can lag
    // behind a save (between a PUT's write and the cache refresh, or a save on
    // another worker): an old cached body sent with the new file's revision would
    // let the client save its stale copy over the newer change.
    const stored = await readStoredApp(appId);
    if (!stored || stored.id !== appId) {
      throw new ServiceError('NOT_FOUND', 'App not found');
    }

    // The revision of the stored file: what `If-Match` on PUT /api/admin/apps/{appId}
    // is compared against (utils/configRevision.js). The body is that file in the
    // shape the cache holds it (schema defaults applied), as before.
    setRevisionHeaders(res, revisionOf(stored));
    res.json(prepareStoredResource('apps', stored, `apps/${appId}.json`));
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
   *       - Required fields: id, name, description, color, icon
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
   *       - in: header
   *         name: If-Match
   *         required: false
   *         schema:
   *           type: string
   *         description: |
   *           The `ETag` of the `GET /api/admin/apps/{appId}` the change is based on.
   *           Optional; without it the save behaves as before (the last save wins).
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
   *             preferredModel: "gpt-4-turbo"
   *             enabled: true
   *     responses:
   *       200:
   *         description: Application successfully updated. The `ETag` header carries the new revision.
   *         headers:
   *           ETag:
   *             description: Revision of the stored app file after the save
   *             schema:
   *               type: string
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
   *               invalidConfig:
   *                 summary: Configuration does not pass the app schema
   *                 value:
   *                   error: "Invalid app configuration: redirectConfig.url: Redirect URL must use http or https"
   *                   details: []
   *       412:
   *         description: "`PRECONDITION_FAILED` (`details.resource` `app`): `If-Match` does not name the stored revision; someone saved the app after it was read. Nothing was written."
   *       500:
   *         description: Internal server error
   */
  app.put(buildServerPath('/api/admin/apps/:appId'), contentAdminAuth, async (req, res) => {
    const { appId } = req.params;
    const updatedApp = req.body;

    // Validate appId for security
    assertValidId(appId, 'app');

    if (!updatedApp.id || !updatedApp.name || !updatedApp.description) {
      throw new ServiceError('BAD_REQUEST', 'Missing required fields');
    }
    if (updatedApp.id !== appId) {
      throw new ServiceError('BAD_REQUEST', 'App ID cannot be changed');
    }
    assertValidAppConfig(updatedApp);

    // Find the actual file for this app ID (may not match ${appId}.json)
    const appFilePath = await configStore.resolveIdToPath('apps', appId, {
      createIfMissing: false
    });
    if (!appFilePath) {
      throw new ServiceError('NOT_FOUND', 'App file not found');
    }
    const { data: currentApps } = configCache.getApps(true);
    const oldApp = currentApps.find(a => a.id === appId);
    if (parseIfMatch(req.get('If-Match')) === null) {
      // Without If-Match: the last save wins, as before.
      await configStore.writeJson(appFilePath, updatedApp);
    } else {
      // The comparison runs under the file's update lock, on the body the write replaces,
      // so no other save can land in between. A mismatch throws 412 and writes nothing.
      await configStore.updateJson(appFilePath, stored => {
        assertIfMatch(req, stored, 'app');
        return updatedApp;
      });
    }
    await configCache.refreshAppsCache();
    if (oldApp) {
      await saveSnapshot({
        resource: 'app',
        id: appId,
        before: oldApp,
        after: updatedApp,
        admin: req.user?.username ?? req.user?.name ?? req.user?.id ?? 'unknown'
      });
    }
    await logAudit({
      req,
      action: 'update',
      resource: 'app',
      resourceId: appId,
      summary: `Updated app ${appId}`
    });
    // The stored body is the body sent, so its revision is the next save's If-Match.
    setRevisionHeaders(res, revisionOf(updatedApp));
    res.json(updatedApp);
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
   *       - Required fields: id, name, description, color, icon
   *       - All fields are validated against the application schema
   *       - Application ID will be used as filename
   *
   *       **File System Operations:**
   *       - Creates new JSON file in contents/apps/ directory
   *       - Automatically refreshes cache after successful creation
   *
   *       The app is stored as sent. Without `enabled` in the body it is
   *       published (`enabled` defaults to `true`). No change-history snapshot
   *       is written on create; the first edit writes one whose "before" is
   *       the created app.
   *     tags:
   *       - Admin
   *       - Applications
   *     security:
   *       - adminAuth: []
   *     parameters:
   *       - in: query
   *         name: origin
   *         required: false
   *         schema:
   *           type: string
   *           enum: [blank, template, copy, generated, link, upload]
   *         description: |
   *           Audit metadata: how the app was started (empty, from a template,
   *           as a copy, from an AI draft, as a link app, by uploading a
   *           configuration). It is recorded in `details.origin` of the audit
   *           entry and changes nothing about the app. An unknown value
   *           answers 400 `VALIDATION_FAILED`.
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
   *         description: Bad request - missing required fields or invalid configuration
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/AdminError'
   *             examples:
   *               missingFields:
   *                 summary: Missing required fields
   *                 value:
   *                   error: "Missing required fields"
   *               invalidConfig:
   *                 summary: Configuration does not pass the app schema
   *                 value:
   *                   error: "Invalid app configuration: iframeConfig.url: Iframe URL must use http or https"
   *                   details: []
   *               invalidOrigin:
   *                 summary: Unknown value of the origin query parameter (VALIDATION_FAILED)
   *                 value:
   *                   error: "origin must be one of: blank, template, copy, generated, link, upload"
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
  app.post(buildServerPath('/api/admin/apps'), contentAdminAuth, async (req, res) => {
    const origin = readCreateOrigin(req.query?.origin);
    const newApp = req.body;
    if (!newApp.id || !newApp.name || !newApp.description) {
      throw new ServiceError('BAD_REQUEST', 'Missing required fields');
    }

    // Validate newApp.id for security
    assertValidId(newApp.id, 'app');
    assertValidAppConfig(newApp);

    // Check for duplicate ID via configCache (covers filenames that differ from their ID)
    const { data: existingApps } = configCache.getApps(true);
    if (existingApps.some(a => a.id === newApp.id)) {
      throw new ServiceError('CONFLICT', 'App with this ID already exists');
    }
    try {
      // Create-only: the file-exists check and the write are one step, so two
      // concurrent creates cannot both decide the name is free.
      await configStore.createJson(`apps/${newApp.id}.json`, newApp);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      throw new ServiceError('CONFLICT', 'App with this ID already exists');
    }
    await configCache.refreshAppsCache();
    // No change-history snapshot on create: its rollback would have nothing to go back to.
    // The first edit writes one whose "before" is this app.
    await logAudit({
      req,
      action: 'create',
      resource: 'app',
      resourceId: newApp.id,
      summary: `Created app ${newApp.id}`,
      ...(origin ? { details: { origin } } : {})
    });
    sendCreated(res, `/api/admin/apps/${segment(newApp.id)}`, newApp);
  });

  /**
   * @swagger
   * /api/admin/apps/{appId}/features/feedback:
   *   post:
   *     summary: Enable or disable response feedback for one app
   *     description: |
   *       Sets `features.feedback` on the app's own configuration file. Passing
   *       `enabled: true` removes the key again, so the app follows the
   *       platform-wide `feedback` feature flag (the default). The platform flag
   *       still has the last word: an app cannot switch feedback on while it is
   *       off platform-wide.
   *     tags:
   *       - Admin
   *       - Applications
   *     security:
   *       - adminAuth: []
   *     parameters:
   *       - in: path
   *         name: appId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - enabled
   *             properties:
   *               enabled:
   *                 type: boolean
   *     responses:
   *       200:
   *         description: Setting applied
   *       400:
   *         description: "`enabled` missing or not a boolean"
   *       404:
   *         description: Application not found
   *       500:
   *         description: Internal server error
   */
  app.post(
    buildServerPath('/api/admin/apps/:appId/features/feedback'),
    contentAdminAuth,
    async (req, res) => {
      const { appId } = req.params;
      const { enabled } = req.body || {};

      assertValidId(appId, 'app');
      if (typeof enabled !== 'boolean') {
        throw new ServiceError('BAD_REQUEST', 'Field "enabled" must be a boolean');
      }

      const { data: apps } = configCache.getApps(true);
      const appConfig = apps.find(a => a.id === appId);
      if (!appConfig) {
        throw new ServiceError('NOT_FOUND', 'App not found');
      }

      const features = { ...appConfig.features };
      if (enabled) {
        // Absent means "follow the platform flag" — the default state, so an
        // app that is switched back on carries no override at all.
        delete features.feedback;
      } else {
        features.feedback = false;
      }
      const updatedApp = { ...appConfig, features };
      if (Object.keys(features).length === 0) delete updatedApp.features;

      const appFilePath = await configStore.resolveIdToPath('apps', appId, {
        createIfMissing: false
      });
      if (!appFilePath) {
        throw new ServiceError('NOT_FOUND', 'App file not found');
      }
      await configStore.writeJson(appFilePath, updatedApp);
      await configCache.refreshAppsCache();
      await logAudit({
        req,
        action: 'update',
        resource: 'app',
        resourceId: appId,
        summary: `${enabled ? 'Enabled' : 'Disabled'} response feedback for app ${appId}`
      });
      res.json({
        message: `Feedback ${enabled ? 'enabled' : 'disabled'} for app ${appId}`,
        appId,
        enabled
      });
    }
  );

  /**
   * @swagger
   * /api/admin/apps/_reorder:
   *   post:
   *     summary: Set the display order of applications
   *     description: |
   *       Rewrites the `order` field of the given applications so it matches the
   *       order the ids are sent in: the first id gets `order: 1`, the second
   *       `order: 2`, and so on. This is what the reorder view in
   *       **Admin → Apps** saves, and what the apps browser, the start page and
   *       the sidebar rank by.
   *
   *       Only the `order` field of each app's own configuration file is
   *       touched; apps that are not listed keep the order they have.
   *     tags:
   *       - Admin
   *       - Applications
   *     security:
   *       - adminAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - ids
   *             properties:
   *               ids:
   *                 type: array
   *                 items:
   *                   type: string
   *                 description: App ids, in the order they should appear
   *           example:
   *             ids: ["chat-assistant", "translator", "code-reviewer"]
   *     responses:
   *       200:
   *         description: Order successfully applied
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *                 ids:
   *                   type: array
   *                   items:
   *                     type: string
   *                 updated:
   *                   type: array
   *                   items:
   *                     type: string
   *                   description: Apps whose file actually changed
   *             example:
   *               message: "App order updated successfully"
   *               ids: ["chat-assistant", "translator"]
   *               updated: ["translator"]
   *       400:
   *         description: Bad request - missing, duplicated or unknown ids
   *       500:
   *         description: Internal server error
   */
  app.post(buildServerPath('/api/admin/apps/_reorder'), contentAdminAuth, async (req, res) => {
    const { ids: requestedIds } = req.body || {};
    if (!Array.isArray(requestedIds) || requestedIds.length === 0) {
      throw new ServiceError('BAD_REQUEST', 'ids must be a non-empty array of app ids');
    }
    if (new Set(requestedIds).size !== requestedIds.length) {
      throw new ServiceError('BAD_REQUEST', 'ids must not contain duplicates');
    }

    // Same id validation as every other app route — these reach the filesystem.
    const ids = assertValidIds(requestedIds, 'app');

    const { data: apps } = configCache.getApps(true);
    const known = new Set(apps.map(a => a.id));
    const unknown = ids.filter(id => !known.has(id));
    if (unknown.length > 0) {
      throw new ServiceError('BAD_REQUEST', `Unknown app ids: ${unknown.join(', ')}`);
    }

    const updated = [];

    for (const [index, id] of ids.entries()) {
      const order = index + 1;
      const appFilePath = await configStore.resolveIdToPath('apps', id, {
        createIfMissing: false
      });
      if (!appFilePath) {
        logger.warn('App file not found', { component: 'AdminApps', id });
        continue;
      }
      // Read the stored document, not the cached entry: the cache holds
      // inheritance already merged in, and writing that back would freeze a
      // child app's inherited fields into its own config.
      const stored = await configStore.readJson(appFilePath);
      if (!stored) {
        logger.warn('App file not readable', { component: 'AdminApps', id });
        continue;
      }
      if (stored.order === order) continue;
      stored.order = order;
      await configStore.writeJson(appFilePath, stored);
      updated.push(id);
    }

    await configCache.refreshAppsCache();
    await logAudit({
      req,
      action: 'update',
      resource: 'app',
      resourceId: updated.join(','),
      summary: `Reordered ${ids.length} apps (${updated.length} changed)`
    });

    res.json({ ids, updated });
  });

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
   *       - Only the `enabled` flag of each stored app file changes
   *
   *       **One app:** for a single app ID the answer carries the app's new
   *       revision as `ETag`, and an optional `If-Match` (the `ETag` of
   *       `GET /api/admin/apps/{appId}`) refuses the toggle with 412 when the
   *       app was saved by someone else since it was read. The app editor uses
   *       both, so its next save builds on the toggled file.
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
   *       - in: header
   *         name: If-Match
   *         required: false
   *         schema:
   *           type: string
   *         description: |
   *           One app only: the `ETag` of the `GET /api/admin/apps/{appId}` the
   *           toggle is based on. Refused with 400 for several apps or `*`.
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
   *         headers:
   *           ETag:
   *             description: For one app, the revision of its stored file after the toggle
   *             schema:
   *               type: string
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
   *         description: "`BAD_REQUEST`: missing enabled flag, or `If-Match` for more than one app"
   *       412:
   *         description: "`PRECONDITION_FAILED` (`details.resource` `app`): `If-Match` does not name the stored revision; nothing was written"
   *       500:
   *         description: Internal server error
   */
  app.post(
    buildServerPath('/api/admin/apps/:appIds/_toggle'),
    contentAdminAuth,
    async (req, res) => {
      const { appIds } = req.params;
      const { enabled } = req.body;
      if (typeof enabled !== 'boolean') {
        throw new ServiceError('BAD_REQUEST', 'Missing enabled flag');
      }

      // Validate appIds for security
      const ids = assertValidIds(appIds, 'app');
      // One named app: the answer carries its new revision, and `If-Match` is honoured.
      const single = ids.length === 1 && ids[0] !== '*';
      if (!single && parseIfMatch(req.get('If-Match')) !== null) {
        throw new ServiceError('BAD_REQUEST', 'If-Match is accepted for one app only');
      }

      const { data: apps } = configCache.getApps(true);
      const resolvedIds = ids.includes('*') ? apps.map(a => a.id) : ids;
      let stored = null;
      for (const id of resolvedIds) {
        if (!single && !apps.some(a => a.id === id)) continue;
        // Find the actual file for this app ID (may not match ${id}.json)
        const appFilePath = await configStore.resolveIdToPath('apps', id, {
          createIfMissing: false
        });
        if (!appFilePath) {
          logger.warn('App file not found', { component: 'AdminApps', id });
          continue;
        }
        // Only the flag of the stored file changes, under the file's update lock; with
        // `If-Match` (one app) the comparison runs on the body the change replaces.
        const { data } = await configStore.updateJson(appFilePath, current => {
          if (single) assertIfMatch(req, current, 'app');
          if (!current || (current.enabled !== false) === enabled) return undefined;
          return { ...current, enabled };
        });
        stored = data;
      }

      await configCache.refreshAppsCache();
      await logAudit({
        req,
        action: 'toggle',
        resource: 'app',
        resourceId: resolvedIds.join(','),
        summary: `Batch ${enabled ? 'enabled' : 'disabled'} ${resolvedIds.length} apps`
      });
      // The revision of the stored file after the toggle: a form that edits this app
      // keeps saving with `If-Match` from it.
      if (single && stored) setRevisionHeaders(res, revisionOf(stored));
      res.json({
        enabled,
        ids: resolvedIds
      });
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
  app.delete(buildServerPath('/api/admin/apps/:appId'), contentAdminAuth, async (req, res) => {
    const { appId } = req.params;

    // Validate appId for security
    assertValidId(appId, 'app');

    const appFilePath = await configStore.resolveIdToPath('apps', appId, {
      createIfMissing: false
    });
    if (!appFilePath) {
      throw new ServiceError('NOT_FOUND', 'App not found');
    }
    const { data: currentApps } = configCache.getApps(true);
    const deletedApp = currentApps.find(a => a.id === appId);
    if (deletedApp) {
      await saveSnapshot({
        resource: 'app',
        id: appId,
        before: deletedApp,
        after: null,
        admin: req.user?.username ?? req.user?.name ?? req.user?.id ?? 'unknown'
      });
    }
    await configStore.remove(appFilePath);
    await configCache.refreshAppsCache();
    await removeMarketplaceInstallation('app', appId);
    await logAudit({
      req,
      action: 'delete',
      resource: 'app',
      resourceId: appId,
      summary: `Deleted app ${appId}`
    });
    res.status(204).end();
  });
}
