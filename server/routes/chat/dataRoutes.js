import configCache from '../../configCache.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';
import { filterResourcesByPermissions } from '../../utils/authorization.js';

export default function registerDataRoutes(app) {
  app.get('/api/styles', async (req, res) => {
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

  app.get('/api/prompts', async (req, res) => {
    try {
      // Get prompts with ETag from cache
      let { data: prompts, etag } = configCache.getPrompts();

      if (!prompts) {
        return res.status(500).json({ error: 'Failed to load prompts configuration' });
      }

      // Apply group-based filtering if user is authenticated
      if (req.user && req.user.permissions) {
        const allowedPrompts = req.user.permissions.prompts || new Set();
        prompts = filterResourcesByPermissions(prompts, allowedPrompts, 'prompts');
      }

      // Set ETag header
      if (etag) {
        res.setHeader('ETag', etag);

        // Check if client has the same ETag
        const clientETag = req.headers['if-none-match'];
        if (clientETag && clientETag === etag) {
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
    try {
      const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
      let { lang } = req.params;
      if (!/^[a-zA-Z0-9-]{1,10}$/.test(lang)) {
        console.warn(`Suspicious language parameter received: ${lang}`);
        lang = defaultLang;
      }
      const supportedLanguages = ['en', 'de'];
      const baseLanguage = lang.split('-')[0].toLowerCase();
      if (!supportedLanguages.includes(lang) && supportedLanguages.includes(baseLanguage)) {
        console.log(`Language '${lang}' not directly supported, falling back to '${baseLanguage}'`);
        lang = baseLanguage;
      }
      if (!supportedLanguages.includes(lang)) {
        console.log(
          `Language '${lang}' not supported, falling back to default language '${defaultLang}'`
        );
        lang = defaultLang;
      }
      // Try to get translations from cache first
      let translations = configCache.getLocalizations(lang);

      if (!translations) {
        console.error(`Failed to load translations for language: ${lang}`);
        if (lang !== defaultLang) {
          // Try to get default translations from cache first
          let enTranslations = configCache.getLocalizations(defaultLang);

          if (enTranslations) {
            return res.json(enTranslations);
          }
        }
        return res.status(500).json({ error: `Failed to load translations for language: ${lang}` });
      }
      res.json(translations);
    } catch (error) {
      console.error(`Error fetching translations for language ${req.params.lang}:`, error);
      try {
        // Try to get default translations from cache first as fallback
        let enTranslations = configCache.getLocalizations(
          configCache.getPlatform()?.defaultLanguage || 'en'
        );

        if (enTranslations) {
          return res.json(enTranslations);
        }
      } catch (fallbackError) {
        console.error('Failed to load fallback translations:', fallbackError);
      }
      res.status(500).json({ error: 'Internal server error' });
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
        mode: process.env.AUTH_MODE || platform.auth?.mode || 'proxy',
        allowAnonymous: process.env.AUTH_ALLOW_ANONYMOUS === 'true' 
          ? true 
          : process.env.AUTH_ALLOW_ANONYMOUS === 'false' 
            ? false 
            : platform.auth?.allowAnonymous ?? true,
        anonymousGroup: process.env.AUTH_ANONYMOUS_GROUP || platform.auth?.anonymousGroup || 'anonymous'
      };

      // Apply environment variable overrides for proxy auth
      const proxyAuthConfig = {
        ...platform.proxyAuth,
        enabled: process.env.PROXY_AUTH_ENABLED === 'true' 
          ? true 
          : process.env.PROXY_AUTH_ENABLED === 'false' 
            ? false 
            : platform.proxyAuth?.enabled ?? false,
        userHeader: process.env.PROXY_AUTH_USER_HEADER || platform.proxyAuth?.userHeader || 'X-Forwarded-User',
        groupsHeader: process.env.PROXY_AUTH_GROUPS_HEADER || platform.proxyAuth?.groupsHeader || 'X-Forwarded-Groups',
        anonymousGroup: process.env.PROXY_AUTH_ANONYMOUS_GROUP || platform.proxyAuth?.anonymousGroup || 'anonymous'
      };

      // Apply environment variable overrides for local auth
      const localAuthConfig = {
        ...platform.localAuth,
        enabled: process.env.LOCAL_AUTH_ENABLED === 'true' 
          ? true 
          : process.env.LOCAL_AUTH_ENABLED === 'false' 
            ? false 
            : platform.localAuth?.enabled ?? false,
        sessionTimeoutMinutes: parseInt(process.env.LOCAL_AUTH_SESSION_TIMEOUT) || platform.localAuth?.sessionTimeoutMinutes || 480,
        jwtSecret: process.env.JWT_SECRET || platform.localAuth?.jwtSecret || '${JWT_SECRET}'
      };

      // Apply environment variable overrides for OIDC auth
      const oidcAuthConfig = {
        ...platform.oidcAuth,
        enabled: process.env.OIDC_AUTH_ENABLED === 'true' 
          ? true 
          : process.env.OIDC_AUTH_ENABLED === 'false' 
            ? false 
            : platform.oidcAuth?.enabled ?? false
      };

      // Add version and computed salt to platform response
      const enhancedPlatform = {
        ...platform,
        version: appVersion,
        computedRefreshSalt: computedSalt,
        auth: authConfig,
        proxyAuth: proxyAuthConfig,
        localAuth: localAuthConfig,
        oidcAuth: oidcAuthConfig
      };

      res.json(enhancedPlatform);
    } catch (error) {
      console.error('Error fetching platform configuration:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
