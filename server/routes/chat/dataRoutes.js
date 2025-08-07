import configCache from '../../configCache.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import {
  filterResourcesByPermissions,
  isAnonymousAccessAllowed,
  enhanceUserWithPermissions
} from '../../utils/authorization.js';
import { authRequired } from '../../middleware/authRequired.js';
import crypto from 'crypto';

/**
 * @swagger
 * components:
 *   schemas:
 *     Style:
 *       type: object
 *       description: UI styling configuration
 *       properties:
 *         id:
 *           type: string
 *           example: "default"
 *         name:
 *           type: string
 *           example: "Default Theme"
 *         colors:
 *           type: object
 *           description: Color palette definitions
 *         fonts:
 *           type: object
 *           description: Font configurations
 *         layout:
 *           type: object
 *           description: Layout settings
 *
 *     Prompt:
 *       type: object
 *       description: Prompt template configuration
 *       properties:
 *         id:
 *           type: string
 *           example: "analysis"
 *         name:
 *           type: object
 *           description: Localized prompt names
 *           example: { "en": "Analysis Helper", "de": "Analyse-Helfer" }
 *         description:
 *           type: object
 *           description: Localized prompt descriptions
 *         template:
 *           type: string
 *           description: Prompt template content
 *         variables:
 *           type: array
 *           description: Available template variables
 *           items:
 *             type: object
 *         category:
 *           type: string
 *           example: "productivity"
 *         enabled:
 *           type: boolean
 *           example: true
 *
 *     LocalizedTranslations:
 *       type: object
 *       description: Localized text translations for UI
 *       additionalProperties:
 *         type: string
 *       example:
 *         "common.save": "Save"
 *         "common.cancel": "Cancel"
 *         "app.title": "AI Hub Apps"
 *
 *     UIConfiguration:
 *       type: object
 *       description: UI customization configuration
 *       properties:
 *         branding:
 *           type: object
 *           description: Brand customization settings
 *         theme:
 *           type: object
 *           description: Theme configuration
 *         layout:
 *           type: object
 *           description: Layout preferences
 *         features:
 *           type: object
 *           description: Feature flags for UI components
 *
 *     PlatformConfiguration:
 *       type: object
 *       description: Platform configuration and settings
 *       properties:
 *         version:
 *           type: string
 *           description: Application version
 *           example: "1.2.3"
 *         computedRefreshSalt:
 *           type: string
 *           description: Cache busting salt
 *           example: "1.2.3.42"
 *         defaultLanguage:
 *           type: string
 *           description: Default language code
 *           example: "en"
 *         auth:
 *           type: object
 *           description: Authentication configuration
 *           properties:
 *             mode:
 *               type: string
 *               enum: ["proxy", "local", "oidc", "anonymous"]
 *         anonymousAuth:
 *           type: object
 *           description: Anonymous access configuration
 *           properties:
 *             enabled:
 *               type: boolean
 *             defaultGroups:
 *               type: array
 *               items:
 *                 type: string
 *         localAuth:
 *           type: object
 *           description: Local authentication settings (sensitive fields excluded)
 *           properties:
 *             enabled:
 *               type: boolean
 *             sessionTimeoutMinutes:
 *               type: number
 *             showDemoAccounts:
 *               type: boolean
 *         oidcAuth:
 *           type: object
 *           description: OIDC authentication configuration (sensitive fields excluded)
 *           properties:
 *             enabled:
 *               type: boolean
 *             providers:
 *               type: array
 *               items:
 *                 type: object
 *         proxyAuth:
 *           type: object
 *           description: Proxy authentication settings
 *           properties:
 *             enabled:
 *               type: boolean
 *         admin:
 *           type: object
 *           description: Admin configuration (sensitive fields excluded)
 *           properties:
 *             pages:
 *               type: object
 *
 *     DataError:
 *       type: object
 *       properties:
 *         error:
 *           type: string
 *           description: Error message
 *         requestId:
 *           type: string
 *           description: Unique request identifier for debugging
 *           example: "1640995200000-abc123def"
 */

export default function registerDataRoutes(app) {
  /**
   * @swagger
   * /api/styles:
   *   get:
   *     summary: Get UI styling configuration
   *     description: |
   *       Retrieves the available UI styles and themes for the application.
   *       Styles define color palettes, fonts, and layout configurations that customize the user interface.
   *     tags:
   *       - Configuration
   *     security:
   *       - bearerAuth: []
   *       - cookieAuth: []
   *       - anonymousAuth: []
   *     responses:
   *       200:
   *         description: UI styles successfully retrieved
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/Style'
   *             example:
   *               - id: "default"
   *                 name: "Default Theme"
   *                 colors:
   *                   primary: "#3B82F6"
   *                   secondary: "#6B7280"
   *                   background: "#FFFFFF"
   *                 fonts:
   *                   body: "Inter, sans-serif"
   *                   heading: "Inter, sans-serif"
   *                 layout:
   *                   maxWidth: "1200px"
   *                   sidebar: "250px"
   *               - id: "dark"
   *                 name: "Dark Theme"
   *                 colors:
   *                   primary: "#60A5FA"
   *                   secondary: "#9CA3AF"
   *                   background: "#111827"
   *       401:
   *         description: Authentication required
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DataError'
   *             example:
   *               error: "Authentication required"
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DataError'
   *             examples:
   *               configError:
   *                 summary: Configuration loading error
   *                 value:
   *                   error: "Failed to load styles configuration"
   *               serverError:
   *                 summary: General server error
   *                 value:
   *                   error: "Internal server error"
   */
  app.get('/api/styles', authRequired, async (req, res) => {
    try {
      // Try to get styles from cache first
      let { data: styles = [] } = configCache.getStyles();

      if (!styles) {
        return res.status(500).json({ error: 'Failed to load styles configuration' });
      }
      res.json(styles);
    } catch (error) {
      console.error('Error fetching styles:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * @swagger
   * /api/prompts:
   *   get:
   *     summary: Get available prompts with permission filtering
   *     description: |
   *       Retrieves prompt templates that the authenticated user has permission to access.
   *
   *       **Permission Filtering Logic:**
   *       - Authenticated users see prompts based on their group permissions
   *       - Anonymous users (if enabled) see no prompts by default
   *       - Prompts are filtered by the `prompts` permission in user groups
   *       - Supports wildcard (*) permission for full access
   *
   *       **ETag Behavior:**
   *       - User-specific ETag prevents cache poisoning between users with different permissions
   *       - If prompts are filtered, a content-based ETag is generated using filtered prompt IDs
   *       - If user sees all prompts, original ETag is used for optimal caching
   *       - Supports conditional requests with If-None-Match header
   *     tags:
   *       - Configuration
   *       - Prompts
   *     security:
   *       - bearerAuth: []
   *       - cookieAuth: []
   *       - anonymousAuth: []
   *     parameters:
   *       - in: header
   *         name: If-None-Match
   *         required: false
   *         description: Client ETag for conditional requests (304 response if unchanged)
   *         schema:
   *           type: string
   *           example: '"abc123-def456"'
   *     responses:
   *       200:
   *         description: Prompts successfully retrieved (filtered by permissions)
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
   *                 $ref: '#/components/schemas/Prompt'
   *             examples:
   *               adminUser:
   *                 summary: Admin user sees all prompts
   *                 value:
   *                   - id: "analysis"
   *                     name:
   *                       en: "Analysis Helper"
   *                       de: "Analyse-Helfer"
   *                     description:
   *                       en: "Helps analyze data and documents"
   *                     template: "Analyze the following: {input}"
   *                     variables:
   *                       - name: "input"
   *                         type: "string"
   *                         required: true
   *                     category: "productivity"
   *                     enabled: true
   *                   - id: "creative-writing"
   *                     name:
   *                       en: "Creative Writing"
   *                     template: "Write creatively about: {topic}"
   *                     category: "creative"
   *                     enabled: true
   *               regularUser:
   *                 summary: Regular user sees filtered prompts
   *                 value:
   *                   - id: "analysis"
   *                     name:
   *                       en: "Analysis Helper"
   *                     template: "Analyze the following: {input}"
   *                     category: "productivity"
   *                     enabled: true
   *               anonymousUser:
   *                 summary: Anonymous user sees no prompts
   *                 value: []
   *       304:
   *         description: Not modified (client has current version)
   *       401:
   *         description: Authentication required
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DataError'
   *             example:
   *               error: "Authentication required"
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DataError'
   *             examples:
   *               configError:
   *                 summary: Configuration loading error
   *                 value:
   *                   error: "Failed to load prompts configuration"
   *               serverError:
   *                 summary: General server error
   *                 value:
   *                   error: "Internal server error"
   */
  app.get('/api/prompts', authRequired, async (req, res) => {
    try {
      const platformConfig = req.app.get('platform') || {};

      // Get prompts with ETag from cache
      let { data: prompts, etag } = configCache.getPrompts();

      if (!prompts) {
        return res.status(500).json({ error: 'Failed to load prompts configuration' });
      }

      // Force permission enhancement if not already done
      if (req.user && !req.user.permissions) {
        const authConfig = platformConfig.auth || {};
        req.user = enhanceUserWithPermissions(req.user, authConfig, platformConfig);
      }

      // Create anonymous user if none exists and anonymous access is allowed
      if (!req.user && isAnonymousAccessAllowed(platformConfig)) {
        const authConfig = platformConfig.auth || {};
        req.user = enhanceUserWithPermissions(null, authConfig, platformConfig);
      }

      // Apply group-based filtering if user is authenticated
      if (req.user && req.user.permissions) {
        const allowedPrompts = req.user.permissions.prompts || new Set();
        prompts = filterResourcesByPermissions(prompts, allowedPrompts, 'prompts');
      } else if (isAnonymousAccessAllowed(platformConfig)) {
        // For anonymous users, filter to only anonymous-allowed prompts
        const allowedPrompts = new Set(); // No default prompts for anonymous
        prompts = filterResourcesByPermissions(prompts, allowedPrompts, 'prompts');
      }

      // Generate user-specific ETag to prevent cache poisoning between users with different permissions
      let userSpecificEtag = etag;

      // Create ETag based on the actual filtered prompts content
      // This ensures users with the same permissions share cache, but different permissions get different ETags
      const originalPromptsCount = configCache.getPrompts().data?.length || 0;
      if (prompts.length < originalPromptsCount) {
        // Prompts were filtered - create content-based ETag from filtered prompt IDs
        const promptIds = prompts.map(prompt => prompt.id).sort();
        const contentHash = crypto
          .createHash('md5')
          .update(JSON.stringify(promptIds))
          .digest('hex')
          .substring(0, 8);

        userSpecificEtag = `${etag}-${contentHash}`;
      }
      // If prompts.length === originalPromptsCount, user sees all prompts, use original ETag

      // Set ETag header
      if (userSpecificEtag) {
        res.setHeader('ETag', userSpecificEtag);

        // Check if client has the same ETag
        const clientETag = req.headers['if-none-match'];
        if (clientETag && clientETag === userSpecificEtag) {
          return res.status(304).end();
        }
      }

      res.json(prompts);
    } catch (error) {
      console.error('Error fetching prompts:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * @swagger
   * /api/translations/{lang}:
   *   get:
   *     summary: Get localized translations for UI
   *     description: |
   *       Retrieves localized text translations for the specified language.
   *
   *       **Language Fallback Logic:**
   *       1. Validates language parameter (alphanumeric, 1-10 chars)
   *       2. If full locale (e.g., 'en-US') not supported, falls back to base language ('en')
   *       3. If language not supported, falls back to default platform language
   *       4. If requested language fails to load, attempts fallback to default language
   *       5. Comprehensive error handling with request ID for debugging
   *
   *       **Security Features:**
   *       - Language parameter validation prevents injection attacks
   *       - Suspicious parameters logged for security monitoring
   *       - Request ID tracking for debugging and audit trails
   *     tags:
   *       - Configuration
   *       - Localization
   *     parameters:
   *       - in: path
   *         name: lang
   *         required: true
   *         description: |
   *           Language code (ISO 639-1 format, optionally with region).
   *           Examples: 'en', 'de', 'en-US', 'de-DE'
   *         schema:
   *           type: string
   *           pattern: '^[a-zA-Z0-9-]{1,10}$'
   *           example: "en"
   *     responses:
   *       200:
   *         description: Translations successfully retrieved
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/LocalizedTranslations'
   *             examples:
   *               english:
   *                 summary: English translations
   *                 value:
   *                   "common.save": "Save"
   *                   "common.cancel": "Cancel"
   *                   "common.delete": "Delete"
   *                   "app.title": "AI Hub Apps"
   *                   "nav.home": "Home"
   *                   "nav.apps": "Applications"
   *                   "auth.login": "Login"
   *                   "auth.logout": "Logout"
   *               german:
   *                 summary: German translations
   *                 value:
   *                   "common.save": "Speichern"
   *                   "common.cancel": "Abbrechen"
   *                   "common.delete": "Löschen"
   *                   "app.title": "AI Hub Apps"
   *                   "nav.home": "Startseite"
   *                   "nav.apps": "Anwendungen"
   *                   "auth.login": "Anmelden"
   *                   "auth.logout": "Abmelden"
   *               fallback:
   *                 summary: Fallback to default language when requested language unavailable
   *                 value:
   *                   "common.save": "Save"
   *                   "common.cancel": "Cancel"
   *                   "app.title": "AI Hub Apps"
   *       500:
   *         description: Internal server error or translation loading failure
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DataError'
   *             examples:
   *               loadError:
   *                 summary: Failed to load translations
   *                 value:
   *                   error: "Failed to load translations for language: de"
   *                   requestId: "1640995200000-abc123def"
   *               serverError:
   *                 summary: General server error with fallback attempt
   *                 value:
   *                   error: "Internal server error"
   *                   requestId: "1640995200000-xyz789abc"
   */
  app.get('/api/translations/:lang', async (req, res) => {
    const originalLang = req.params.lang;
    let requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    try {
      console.log(`[${requestId}] Translation request for language: ${originalLang}`);

      const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
      let { lang } = req.params;

      // Validate language parameter
      if (!/^[a-zA-Z0-9-]{1,10}$/.test(lang)) {
        console.warn(`[${requestId}] Suspicious language parameter received: ${lang}`);
        lang = defaultLang;
      }

      // Language normalization and fallback logic
      const supportedLanguages = ['en', 'de'];
      const baseLanguage = lang.split('-')[0].toLowerCase();

      if (!supportedLanguages.includes(lang) && supportedLanguages.includes(baseLanguage)) {
        console.log(
          `[${requestId}] Language '${lang}' not directly supported, falling back to '${baseLanguage}'`
        );
        lang = baseLanguage;
      }

      if (!supportedLanguages.includes(lang)) {
        console.log(
          `[${requestId}] Language '${lang}' not supported, falling back to default language '${defaultLang}'`
        );
        lang = defaultLang;
      }

      // Try to get translations from cache first
      let translations = configCache.getLocalizations(lang);

      if (!translations) {
        console.warn(
          `[${requestId}] Translations not in cache for language: ${lang}, attempting to load...`
        );

        // Try to load and cache the locale
        try {
          await configCache.loadAndCacheLocale(lang);
          translations = configCache.getLocalizations(lang);
        } catch (loadError) {
          console.error(`[${requestId}] Failed to load locale for ${lang}:`, loadError);
        }
      }

      if (!translations) {
        console.error(`[${requestId}] Failed to load translations for language: ${lang}`);

        if (lang !== defaultLang) {
          console.log(`[${requestId}] Attempting fallback to default language: ${defaultLang}`);
          // Try to get default translations from cache first
          let enTranslations = configCache.getLocalizations(defaultLang);

          if (!enTranslations) {
            // Try to load default language if not in cache
            try {
              await configCache.loadAndCacheLocale(defaultLang);
              enTranslations = configCache.getLocalizations(defaultLang);
            } catch (fallbackLoadError) {
              console.error(
                `[${requestId}] Failed to load fallback locale for ${defaultLang}:`,
                fallbackLoadError
              );
            }
          }

          if (enTranslations) {
            console.log(`[${requestId}] Returning fallback translations for ${defaultLang}`);
            return res.json(enTranslations);
          }
        }

        return res.status(500).json({
          error: `Failed to load translations for language: ${lang}`,
          requestId: requestId
        });
      }

      console.log(`[${requestId}] Successfully returning translations for language: ${lang}`);
      res.json(translations);
    } catch (error) {
      console.error(
        `[${requestId}] Error fetching translations for language ${originalLang}:`,
        error
      );
      console.error(`[${requestId}] Stack trace:`, error.stack);

      try {
        // Try to get default translations from cache first as fallback
        const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
        let enTranslations = configCache.getLocalizations(defaultLang);

        if (!enTranslations) {
          // Try to load default language if not in cache
          try {
            await configCache.loadAndCacheLocale(defaultLang);
            enTranslations = configCache.getLocalizations(defaultLang);
          } catch (fallbackLoadError) {
            console.error(`[${requestId}] Failed to load fallback locale:`, fallbackLoadError);
          }
        }

        if (enTranslations) {
          console.log(`[${requestId}] Returning emergency fallback translations`);
          return res.json(enTranslations);
        }
      } catch (fallbackError) {
        console.error(`[${requestId}] Failed to load fallback translations:`, fallbackError);
      }

      res.status(500).json({
        error: 'Internal server error',
        requestId: requestId
      });
    }
  });

  /**
   * @swagger
   * /api/configs/ui:
   *   get:
   *     summary: Get UI configuration settings
   *     description: |
   *       Retrieves the UI configuration including branding, theme, layout preferences,
   *       and feature flags that control the appearance and behavior of the user interface.
   *
   *       **ETag Support:**
   *       - Response includes ETag header for efficient caching
   *       - Clients can use conditional requests to minimize bandwidth
   *     tags:
   *       - Configuration
   *       - UI
   *     responses:
   *       200:
   *         description: UI configuration successfully retrieved
   *         headers:
   *           ETag:
   *             description: Cache validation header for UI configuration
   *             schema:
   *               type: string
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/UIConfiguration'
   *             example:
   *               branding:
   *                 appName: "AI Hub Apps"
   *                 logo: "/assets/logo.png"
   *                 favicon: "/assets/favicon.ico"
   *                 primaryColor: "#3B82F6"
   *               theme:
   *                 defaultTheme: "light"
   *                 allowThemeToggle: true
   *                 availableThemes: ["light", "dark", "auto"]
   *               layout:
   *                 sidebar:
   *                   collapsible: true
   *                   defaultCollapsed: false
   *                 header:
   *                   showBreadcrumbs: true
   *                   showUserMenu: true
   *                 footer:
   *                   show: true
   *                   text: "Powered by AI Hub Apps"
   *               features:
   *                 enableDarkMode: true
   *                 enableNotifications: true
   *                 showWelcomeMessage: true
   *                 enableAdvancedSearch: false
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DataError'
   *             examples:
   *               configError:
   *                 summary: Configuration loading error
   *                 value:
   *                   error: "Failed to load UI configuration"
   *               serverError:
   *                 summary: General server error
   *                 value:
   *                   error: "Internal server error"
   */
  app.get('/api/configs/ui', async (req, res) => {
    try {
      // Try to get UI config from cache first
      let { data: uiConfig = {}, etag: uiConfigEtag } = configCache.getUI();

      if (!uiConfig) {
        return res.status(500).json({ error: 'Failed to load UI configuration' });
      }
      res.setHeader('ETag', uiConfigEtag);
      res.json(uiConfig);
    } catch (error) {
      console.error('Error fetching UI configuration:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * @swagger
   * /api/configs/platform:
   *   get:
   *     summary: Get platform configuration and settings
   *     description: |
   *       Retrieves the complete platform configuration including authentication settings,
   *       version information, and system configuration. Sensitive information is automatically
   *       sanitized before being sent to the client.
   *
   *       **Environment Variable Overrides:**
   *       The endpoint applies environment variable overrides for:
   *       - AUTH_MODE: Authentication mode (proxy, local, oidc, anonymous)
   *       - AUTH_ALLOW_ANONYMOUS: Enable/disable anonymous access
   *       - PROXY_AUTH_ENABLED: Enable proxy authentication
   *       - LOCAL_AUTH_ENABLED: Enable local authentication
   *       - OIDC_AUTH_ENABLED: Enable OIDC authentication
   *       - JWT_SECRET: JWT secret for local auth (sanitized in response)
   *
   *       **Security Features:**
   *       - Sensitive fields automatically excluded from client response
   *       - OIDC provider secrets (clientSecret, clientId) filtered out
   *       - Admin credentials and JWT secrets not exposed
   *       - Proxy auth headers sanitized for security
   *
   *       **Version Information:**
   *       - Application version read from package.json
   *       - Computed refresh salt for cache busting (version + admin salt)
   *     tags:
   *       - Configuration
   *       - Platform
   *     responses:
   *       200:
   *         description: Platform configuration successfully retrieved
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/PlatformConfiguration'
   *             example:
   *               version: "1.2.3"
   *               computedRefreshSalt: "1.2.3.42"
   *               defaultLanguage: "en"
   *               auth:
   *                 mode: "proxy"
   *               anonymousAuth:
   *                 enabled: true
   *                 defaultGroups: ["anonymous"]
   *               proxyAuth:
   *                 enabled: true
   *               localAuth:
   *                 enabled: false
   *                 sessionTimeoutMinutes: 480
   *                 showDemoAccounts: false
   *               oidcAuth:
   *                 enabled: true
   *                 providers:
   *                   - name: "azure"
   *                     displayName: "Azure AD"
   *                     authorizationURL: "https://login.microsoftonline.com/..."
   *                     callbackURL: "https://your-app.com/auth/oidc/callback"
   *                     scope: "openid profile email"
   *                     pkce: true
   *               admin:
   *                 pages:
   *                   enabled: true
   *                   customization: true
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/DataError'
   *             examples:
   *               configError:
   *                 summary: Configuration loading error
   *                 value:
   *                   error: "Failed to load platform configuration"
   *               versionError:
   *                 summary: Version read error (gracefully handled)
   *                 value:
   *                   error: "Internal server error"
   */
  app.get('/api/configs/platform', async (req, res) => {
    try {
      let platform = configCache.getPlatform();
      if (!platform) {
        return res.status(500).json({ error: 'Failed to load platform configuration' });
      }

      // Get app version from package.json
      let appVersion = '1.0.0'; // fallback
      try {
        const rootDir = getRootDir();
        const packageJsonPath = join(rootDir, 'package.json');
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
        appVersion = packageJson.version;
      } catch (error) {
        console.warn('Could not read version from package.json:', error.message);
      }

      // Compute refresh salt combining version and admin-triggered value
      const refreshSalt = platform.refreshSalt || {
        salt: 0,
        lastUpdated: new Date().toISOString()
      };
      const computedSalt = `${appVersion}.${refreshSalt.salt}`;

      // Apply environment variable overrides for auth configuration
      const authConfig = {
        ...platform.auth,
        mode: process.env.AUTH_MODE || platform.auth?.mode || 'proxy'
      };

      // Apply environment variable overrides for anonymous auth configuration
      const anonymousAuthConfig = {
        ...platform.anonymousAuth,
        enabled:
          process.env.AUTH_ALLOW_ANONYMOUS === 'true'
            ? true
            : process.env.AUTH_ALLOW_ANONYMOUS === 'false'
              ? false
              : (platform.anonymousAuth?.enabled ?? true),
        defaultGroups: platform.anonymousAuth?.defaultGroups || ['anonymous']
      };

      // Apply environment variable overrides for proxy auth
      const proxyAuthConfig = {
        ...platform.proxyAuth,
        enabled:
          process.env.PROXY_AUTH_ENABLED === 'true'
            ? true
            : process.env.PROXY_AUTH_ENABLED === 'false'
              ? false
              : (platform.proxyAuth?.enabled ?? false),
        userHeader:
          process.env.PROXY_AUTH_USER_HEADER ||
          platform.proxyAuth?.userHeader ||
          'X-Forwarded-User',
        groupsHeader:
          process.env.PROXY_AUTH_GROUPS_HEADER ||
          platform.proxyAuth?.groupsHeader ||
          'X-Forwarded-Groups'
      };

      // Apply environment variable overrides for local auth
      const localAuthConfig = {
        ...platform.localAuth,
        enabled:
          process.env.LOCAL_AUTH_ENABLED === 'true'
            ? true
            : process.env.LOCAL_AUTH_ENABLED === 'false'
              ? false
              : (platform.localAuth?.enabled ?? false),
        sessionTimeoutMinutes:
          parseInt(process.env.LOCAL_AUTH_SESSION_TIMEOUT) ||
          platform.localAuth?.sessionTimeoutMinutes ||
          480,
        jwtSecret: process.env.JWT_SECRET || platform.localAuth?.jwtSecret || '${JWT_SECRET}'
      };

      // Apply environment variable overrides for OIDC auth
      const oidcAuthConfig = {
        ...platform.oidcAuth,
        enabled:
          process.env.OIDC_AUTH_ENABLED === 'true'
            ? true
            : process.env.OIDC_AUTH_ENABLED === 'false'
              ? false
              : (platform.oidcAuth?.enabled ?? false)
      };

      // Sanitize configs for client - remove sensitive information
      const sanitizedLocalAuth = {
        enabled: localAuthConfig.enabled,
        sessionTimeoutMinutes: localAuthConfig.sessionTimeoutMinutes,
        showDemoAccounts: localAuthConfig.showDemoAccounts
        // Exclude jwtSecret
      };

      const sanitizedOidcAuth = oidcAuthConfig.enabled
        ? {
            enabled: oidcAuthConfig.enabled,
            providers:
              oidcAuthConfig.providers
                ?.filter(provider => provider.enabled !== false) // Only include enabled providers
                ?.map(provider => ({
                  name: provider.name,
                  displayName: provider.displayName,
                  authorizationURL: provider.authorizationURL,
                  callbackURL: provider.callbackURL,
                  scope: provider.scope,
                  pkce: provider.pkce
                  // Exclude clientSecret, clientId, tokenURL, userInfoURL
                })) || []
          }
        : { enabled: false };

      const sanitizedProxyAuth = {
        enabled: proxyAuthConfig.enabled
        // Exclude userHeader, groupsHeader, anonymousGroup which could be sensitive
      };

      // Sanitize admin config - remove sensitive admin credentials
      const sanitizedAdmin = platform.admin
        ? {
            pages: platform.admin.pages
            // Exclude admin.secret
          }
        : {};

      // Add version and computed salt to platform response
      const enhancedPlatform = {
        version: appVersion,
        computedRefreshSalt: computedSalt,
        defaultLanguage: platform.defaultLanguage,
        auth: authConfig,
        anonymousAuth: anonymousAuthConfig,
        proxyAuth: sanitizedProxyAuth,
        localAuth: sanitizedLocalAuth,
        oidcAuth: sanitizedOidcAuth,
        admin: sanitizedAdmin
      };

      res.json(enhancedPlatform);
    } catch (error) {
      console.error('Error fetching platform configuration:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
