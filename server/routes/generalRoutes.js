import configCache from '../configCache.js';
import { enhanceUserWithPermissions, isAnonymousAccessAllowed } from '../utils/authorization.js';
import { authRequired, appAccessRequired } from '../middleware/authRequired.js';

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
 *         tokenLimit:
 *           type: number
 *           description: Maximum tokens per request
 *           example: 4000
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

export default function registerGeneralRoutes(app, { getLocalizedError }) {
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
   *                     tokenLimit: 4000
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
  app.get('/api/apps', authRequired, async (req, res) => {
    try {
      const platformConfig = req.app.get('platform') || {};
      const authConfig = platformConfig.auth || {};

      // Force permission enhancement if not already done
      if (req.user && !req.user.permissions) {
        req.user = enhanceUserWithPermissions(req.user, authConfig, platformConfig);
      }

      // Create anonymous user if none exists and anonymous access is allowed
      if (!req.user && isAnonymousAccessAllowed(platformConfig)) {
        req.user = enhanceUserWithPermissions(null, authConfig, platformConfig);
      }

      // Use centralized method to get filtered apps with user-specific ETag
      const { data: apps, etag: userSpecificEtag } = await configCache.getAppsForUser(
        req.user,
        platformConfig
      );

      if (!apps) {
        return res.status(500).json({ error: 'Failed to load apps configuration' });
      }

      res.setHeader('ETag', userSpecificEtag);
      res.json(apps);
    } catch (error) {
      console.error('Error fetching apps:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
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
   *               tokenLimit: 4000
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
  app.get('/api/apps/:appId', authRequired, appAccessRequired, async (req, res) => {
    try {
      const { appId } = req.params;
      const { data: platform } = configCache.getPlatform() || {};
      const defaultLang = platform?.defaultLanguage || 'en';
      const language = req.headers['accept-language']?.split(',')[0] || defaultLang;

      // Try to get apps from cache first
      const { data: apps } = configCache.getApps();

      if (!apps) {
        return res.status(500).json({ error: 'Failed to load apps configuration' });
      }
      const appData = apps.find(a => a.id === appId);
      if (!appData) {
        const errorMessage = await getLocalizedError('appNotFound', {}, language);
        return res.status(404).json({ error: errorMessage });
      }

      // Check if user has permission to access this app
      if (req.user && req.user.permissions) {
        const allowedApps = req.user.permissions.apps || new Set();
        if (!allowedApps.has('*') && !allowedApps.has(appId)) {
          const errorMessage = await getLocalizedError('appNotFound', {}, language);
          return res.status(404).json({ error: errorMessage });
        }
      }

      res.json(appData);
    } catch (error) {
      console.error('Error fetching app details:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
