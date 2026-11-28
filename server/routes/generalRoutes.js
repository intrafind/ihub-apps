// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configCache from '../configCache.js';
import {
  canUserAccessResource,
  enhanceUserWithPermissions,
  isAnonymousAccessAllowed
} from '../utils/authorization.js';
import { authRequired } from '../middleware/authRequired.js';
import { buildServerPath, getRelativeRequestPath } from '../utils/basePath.js';
import { ServiceError } from '../utils/ServiceError.js';
import { responseEtag } from '../utils/etag.js';
import { getStorage, isStorageReady } from '../storage/bootstrap.js';
import { getTelemetryHealth } from '../telemetry/exportStatus.js';
import { getAppVersion } from '../utils/versionHelper.js';
import { describeWebSearchAvailability } from '../services/tools/webSearchResolver.js';
import { withoutUsageGuideContent } from '../utils/appUsageGuide.js';
import { isUserAppId } from '../../shared/userAppContent.js';
import {
  USER_APP_SCOPES,
  listUserAppsFor,
  readUserAppFor
} from '../services/userApps/resolveApp.js';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { getContentsPath } from '../utils/contentsPath.js';

/**
 * @swagger
 * components:
 *   schemas:
 *     Application:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Unique identifier for the application
 *           example: "chat-assistant"
 *         name:
 *           type: object
 *           description: Localized application names
 *           example: { "en": "Chat Assistant", "de": "Chat-Assistent" }
 *         description:
 *           type: object
 *           description: Localized application descriptions
 *           example: { "en": "AI-powered chat assistant", "de": "KI-gestützter Chat-Assistent" }
 *         color:
 *           type: string
 *           description: UI color theme for the application
 *           example: "blue"
 *         icon:
 *           type: string
 *           description: Icon identifier for the application
 *           example: "chat"
 *         category:
 *           type: string
 *           description: Application category
 *           example: "productivity"
 *         enabled:
 *           type: boolean
 *           description: Whether the application is currently enabled
 *           example: true
 *         order:
 *           type: number
 *           description: Display order for the application
 *           example: 1
 *         system:
 *           type: object
 *           description: Localized system prompts
 *         preferredModel:
 *           type: string
 *           description: Default model selection
 *           example: "gpt-4"
 *         variables:
 *           type: array
 *           description: Input variable definitions
 *           items:
 *             type: object
 *         allowedModels:
 *           type: array
 *           description: Restricted model list (if applicable)
 *           items:
 *             type: string
 *         tools:
 *           type: array
 *           description: Available tool names
 *           items:
 *             type: string
 *     GeneralError:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *           description: Error message
 */

/**
 * What readiness needs, each `ok` or the reason it is not: the platform
 * configuration is loaded, the storage provider is up, and the contents
 * directory can be written (a full or read-only volume fails here instead of
 * on the next chat save).
 *
 * @returns {Promise<{config: string, storage: string, contents: string}>}
 */
export async function readinessChecks() {
  const checks = {
    config: configCache.getPlatform?.() ? 'ok' : 'not_loaded',
    storage: isStorageReady() ? 'ok' : 'not_ready',
    contents: 'ok'
  };
  try {
    await fs.access(getContentsPath(), fsConstants.W_OK);
  } catch (error) {
    checks.contents = error?.code === 'ENOENT' ? 'missing' : 'not_writable';
  }
  return checks;
}

export default function registerGeneralRoutes(app, { getLocalizedError }) {
  // Resolved once: it reads files, and health probes arrive every few seconds.
  const appVersion = getAppVersion();

  /**
   * @swagger
   * /api/apps:
   *   get:
   *     summary: Get available applications
   *     description: |
   *       Retrieves a list of applications that the authenticated user has permission to access.
   *       The list is filtered based on user permissions and group memberships.
   *       Anonymous access is supported if configured in the platform settings.
   *     tags:
   *       - Applications
   *     security:
   *       - bearerAuth: []
   *       - cookieAuth: []
   *       - anonymousAuth: []
   *     parameters:
   *       - in: query
   *         name: scope
   *         required: false
   *         description: |
   *           Lists personal apps instead of the apps of the installation
   *           (feature `userApps`). `mine`: the apps the caller owns and the
   *           apps offered to them. `shared`: the apps shared with the caller,
   *           newest first, at most 200. `personal`: both. The answer is then
   *           `{ items, nextCursor: null }` and carries no `ETag`. It is empty
   *           while the feature is off. Any other value answers 400.
   *         schema:
   *           type: string
   *           enum: [mine, shared, personal]
   *     responses:
   *       200:
   *         description: List of applications successfully retrieved
   *         headers:
   *           ETag:
   *             description: User-specific cache validation header
   *             schema:
   *               type: string
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/Application'
   *             examples:
   *               success:
   *                 summary: Successful response
   *                 value:
   *                   - id: "chat-assistant"
   *                     name: { "en": "Chat Assistant", "de": "Chat-Assistent" }
   *                     description: { "en": "AI-powered chat assistant" }
   *                     color: "blue"
   *                     icon: "chat"
   *                     category: "productivity"
   *                     enabled: true
   *                     order: 1
   *                     preferredModel: "gpt-4"
   *                   - id: "code-reviewer"
   *                     name: { "en": "Code Reviewer" }
   *                     description: { "en": "Automated code review assistant" }
   *                     color: "green"
   *                     icon: "code"
   *                     category: "development"
   *                     enabled: true
   *                     order: 2
   *       401:
   *         description: Authentication required
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/GeneralError'
   *             example:
   *               error: "Authentication required"
   *       403:
   *         description: Access forbidden - insufficient permissions
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/GeneralError'
   *             example:
   *               error: "Access forbidden"
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/GeneralError'
   *             examples:
   *               configError:
   *                 summary: Configuration loading error
   *                 value:
   *                   error: "Failed to load apps configuration"
   *               serverError:
   *                 summary: General server error
   *                 value:
   *                   error: "Internal server error"
   */
  app.get(buildServerPath('/api/apps'), authRequired, async (req, res) => {
    const platformConfig = configCache.getPlatform() || {};
    const authConfig = platformConfig.auth || {};

    // Force permission enhancement if not already done
    if (req.user && !req.user.permissions) {
      req.user = enhanceUserWithPermissions(req.user, authConfig, platformConfig);
    }

    // Create anonymous user if none exists and anonymous access is allowed
    if (!req.user && isAnonymousAccessAllowed(platformConfig)) {
      req.user = enhanceUserWithPermissions(null, authConfig, platformConfig);
    }

    // `scope` asks for personal apps only (feature `userApps`). Without it the
    // answer below is the one it always was, byte for byte.
    if (req.query.scope !== undefined) {
      const { scope } = req.query;
      if (typeof scope !== 'string' || !USER_APP_SCOPES.includes(scope)) {
        throw new ServiceError('VALIDATION_FAILED', 'scope must be mine, shared or personal', {
          details: [{ path: 'scope', code: 'invalid_value', message: 'Unknown scope' }]
        });
      }
      // What a caller may see changes with every share: never from a cache.
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ items: await listUserAppsFor(req.user, scope), nextCursor: null });
    }

    // Use centralized method to get filtered apps with user-specific ETag
    const { data: apps, etag: userSpecificEtag } = await configCache.getAppsForUser(
      req.user,
      platformConfig
    );

    if (!apps) {
      throw new ServiceError('INTERNAL_ERROR', 'Failed to load apps configuration');
    }

    res.setHeader('ETag', responseEtag(userSpecificEtag));
    res.json({ items: withoutUsageGuideContent(apps) });
  });

  /**
   * @swagger
   * /api/apps/{appId}:
   *   get:
   *     summary: Get specific application details
   *     description: |
   *       Retrieves detailed information for a specific application by its ID.
   *       The user must have permission to access the requested application.
   *       Returns a 404 error if the app doesn't exist or the user lacks permission.
   *
   *       A personal app (feature `userApps`, an ID of the form `uap_…`) is
   *       answered for its owner, the people it is shared with, the receiver
   *       of an open offer and full admins, with `ownership: "user"`, `owner`,
   *       `permissions`, `capabilities`, `approval` and an `ETag` that holds
   *       its revision. A caller who may see the app but not use it (switched
   *       off, sharing suspended) gets a reduced body without instructions; a
   *       caller who may use the company app it was published as gets
   *       `{ id, ownership, state: "retired", publishedAs }`.
   *     tags:
   *       - Applications
   *     security:
   *       - bearerAuth: []
   *       - cookieAuth: []
   *       - anonymousAuth: []
   *     parameters:
   *       - in: path
   *         name: appId
   *         required: true
   *         description: Unique identifier of the application
   *         schema:
   *           type: string
   *           example: "chat-assistant"
   *       - in: header
   *         name: Accept-Language
   *         required: false
   *         description: Preferred language for localized error messages
   *         schema:
   *           type: string
   *           example: "en,de;q=0.9"
   *     responses:
   *       200:
   *         description: Application details successfully retrieved
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Application'
   *             example:
   *               id: "chat-assistant"
   *               name:
   *                 en: "Chat Assistant"
   *                 de: "Chat-Assistent"
   *               description:
   *                 en: "AI-powered chat assistant for productivity"
   *                 de: "KI-gestützter Chat-Assistent für Produktivität"
   *               color: "blue"
   *               icon: "chat"
   *               category: "productivity"
   *               enabled: true
   *               order: 1
   *               system:
   *                 en: "You are a helpful AI assistant..."
   *                 de: "Du bist ein hilfreicher KI-Assistent..."
   *               preferredModel: "gpt-4"
   *               variables:
   *                 - name: "context"
   *                   type: "string"
   *                   description: "Additional context for the conversation"
   *               allowedModels: ["gpt-4", "gpt-3.5-turbo"]
   *               tools: ["web_search", "calculator"]
   *       401:
   *         description: Authentication required
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/GeneralError'
   *             example:
   *               error: "Authentication required"
   *       403:
   *         description: Access forbidden - insufficient permissions for this application
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/GeneralError'
   *             example:
   *               error: "Access forbidden"
   *       404:
   *         description: Application not found or access denied
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/GeneralError'
   *             examples:
   *               notFound:
   *                 summary: Application does not exist
   *                 value:
   *                   error: "Application not found"
   *               accessDenied:
   *                 summary: User lacks permission (returns same as not found for security)
   *                 value:
   *                   error: "Application not found"
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/GeneralError'
   *             examples:
   *               configError:
   *                 summary: Configuration loading error
   *                 value:
   *                   error: "Failed to load apps configuration"
   *               serverError:
   *                 summary: General server error
   *                 value:
   *                   error: "Internal server error"
   */
  // Health check endpoint with base path information
  app.get(buildServerPath('/api/health'), async (req, res) => {
    const { getBasePathInfo } = await import('../utils/basePath.js');
    const basePathInfo = getBasePathInfo();

    res.json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      version: appVersion,
      basePathConfig: basePathInfo,
      requestPath: req.path,
      requestUrl: req.url,
      relativePath: getRelativeRequestPath(req.path),
      environment: process.env.NODE_ENV || 'development',
      // Storage down is not fatal by design — the features built on it fall
      // back to their in-memory behaviour — so `status` stays OK. But until
      // this field existed there was no way to *find out*: a misspelt
      // provider name or a data directory the container user cannot write
      // leaves one `logger.error` at boot and nothing else, and every
      // consumer then degrades in silence. The run ledger records nothing,
      // configuration quietly takes the filesystem path, and
      // `chats.persistence` reports false, which is indistinguishable from
      // the feature being switched off. The probe stays green and, once the
      // boot log has rotated, there is nothing left to query.
      storage: { ready: isStorageReady(), provider: getStorage()?.name ?? null },
      // Whether telemetry is on and exporting, so "dashboards are flat" can be
      // told apart from "telemetry is off" or "the collector is unreachable".
      // The probe is public: state per signal only, no endpoint, header,
      // failure reason or counts (those are on the admin system view).
      telemetry: getTelemetryHealth()
    });
  });

  /**
   * @swagger
   * /ready:
   *   get:
   *     summary: Readiness probe
   *     description: >-
   *       200 when this server process can serve requests: the platform
   *       configuration is loaded and the storage is up and writable. 503
   *       (problem+json, `details.checks`) otherwise. `/api/health` is the
   *       liveness probe and always answers 200 while the process runs.
   *     tags: [General]
   *     responses:
   *       200:
   *         description: Ready
   *       503:
   *         description: Not ready
   */
  app.get(buildServerPath('/api/ready'), async (req, res) => {
    const checks = await readinessChecks();
    const failing = Object.entries(checks)
      .filter(([, result]) => result !== 'ok')
      .map(([name]) => name);
    res.set('Cache-Control', 'no-store');
    if (failing.length > 0) {
      throw new ServiceError('SERVICE_UNAVAILABLE', `Not ready: ${failing.join(', ')}`, {
        details: { checks }
      });
    }
    res.json({ status: 'ready', checks });
  });

  // No appAccessRequired here: it answers 403, while this route gives one
  // answer (404) for an app that does not exist and one the caller may not use.
  app.get(buildServerPath('/api/apps/:appId'), authRequired, async (req, res) => {
    const { appId } = req.params;
    const platform = configCache.getPlatform() || {};
    const defaultLang = platform?.defaultLanguage || 'en';
    const language = req.headers['accept-language']?.split(',')[0] || defaultLang;

    if (!configCache.getApps()?.data) {
      throw new ServiceError('INTERNAL_ERROR', 'Failed to load apps configuration');
    }
    // A personal app: its owner and its shares decide, not the group
    // permission `apps`. Unknown, forbidden and "the feature is off" are one
    // 404. A config app that happens to have such an ID goes on below.
    if (isUserAppId(appId)) {
      const personal = await readUserAppFor(appId, req.user, { req });
      if (!personal) {
        const errorMessage = await getLocalizedError('appNotFound', {}, language);
        throw new ServiceError('NOT_FOUND', errorMessage);
      }
      if (!personal.configApp) {
        if (personal.etag) res.setHeader('ETag', personal.etag);
        res.setHeader('Cache-Control', 'no-store');
        // Whether web search can work, per model, as for every app the chat opens.
        const availability =
          personal.kind === 'full'
            ? await describeWebSearchAvailability(personal.body, req.user)
            : null;
        return res.json(
          availability ? { ...personal.body, websearchAvailability: availability } : personal.body
        );
      }
    }
    // A content admin also gets an app that is not published yet, to try it
    // (`getAppForRequest`); for everyone else it does not exist. The group
    // permission below applies to both.
    const appData = configCache.getAppForRequest(appId, req.user);
    if (!appData) {
      const errorMessage = await getLocalizedError('appNotFound', {}, language);
      throw new ServiceError('NOT_FOUND', errorMessage);
    }

    // Fails closed: without a principal carrying permissions nothing is granted.
    if (!canUserAccessResource(req.user, 'apps', appData.id)) {
      const errorMessage = await getLocalizedError('appNotFound', {}, language);
      throw new ServiceError('NOT_FOUND', errorMessage);
    }

    // Whether web search can work for this app, per model (the model
    // picker marks the models it works with): native search, or the app's
    // engine as far as this user's groups grant it.
    const websearchAvailability = await describeWebSearchAvailability(appData, req.user);
    res.json(websearchAvailability ? { ...appData, websearchAvailability } : appData);
  });
}
