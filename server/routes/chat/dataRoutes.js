import configCache from '../../configCache.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import {
  filterResourcesByPermissions,
  isAnonymousAccessAllowed,
  enhanceUserWithPermissions
} from '../../utils/authorization.js';
import { authRequired, authOptional } from '../../middleware/authRequired.js';
import crypto from 'crypto';

export default function registerDataRoutes(app) {
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

  app.get('/api/prompts', authOptional, async (req, res) => {
    try {
      const platformConfig = req.app.get('platform') || {};

      // Check if anonymous access is allowed
      if (!isAnonymousAccessAllowed(platformConfig) && (!req.user || req.user.id === 'anonymous')) {
        return res.status(401).json({
          error: 'Authentication required',
          code: 'AUTH_REQUIRED',
          message: 'You must be logged in to access this resource'
        });
      }

      // Get prompts with ETag from cache
      let { data: prompts, etag } = configCache.getPrompts();

      if (!prompts) {
        return res.status(500).json({ error: 'Failed to load prompts configuration' });
      }

      // Force permission enhancement if not already done
      if (req.user && !req.user.permissions) {
        const platformConfig = req.app.get('platform') || {};
        const authConfig = platformConfig.auth || {};
        req.user = enhanceUserWithPermissions(req.user, authConfig, platformConfig);
      }

      // Create anonymous user if none exists and anonymous access is allowed
      if (!req.user && isAnonymousAccessAllowed(platformConfig)) {
        const platformConfig = req.app.get('platform') || {};
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
              oidcAuthConfig.providers?.map(provider => ({
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
