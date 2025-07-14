import { loadJson } from '../../configLoader.js';
import configCache from '../../configCache.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getRootDir } from '../../pathUtils.js';

export default function registerDataRoutes(app) {
  app.get('/api/styles', async (req, res) => {
    try {
      // Try to get styles from cache first
      let styles = configCache.getStyles();

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
      const { data: prompts, etag } = configCache.getPromptsWithETag();
      
      if (!prompts) {
        return res.status(500).json({ error: 'Failed to load prompts configuration' });
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
      const supportedLanguages = ['en', 'de', 'ar'];
      const baseLanguage = lang.split('-')[0].toLowerCase();
      if (!supportedLanguages.includes(lang) && supportedLanguages.includes(baseLanguage)) {
        console.log(`Language '${lang}' not directly supported, falling back to '${baseLanguage}'`);
        lang = baseLanguage;
      }
      if (!supportedLanguages.includes(lang)) {
        console.log(`Language '${lang}' not supported, falling back to default language '${defaultLang}'`);
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
        let enTranslations = configCache.getLocalizations(configCache.getPlatform()?.defaultLanguage || 'en');

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
      let uiConfig = configCache.getUI();
      
      if (!uiConfig) {
        return res.status(500).json({ error: 'Failed to load UI configuration' });
      }
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
      const refreshSalt = platform.refreshSalt || { salt: 0, lastUpdated: new Date().toISOString() };
      const computedSalt = `${appVersion}.${refreshSalt.salt}`;
      
      // Add version and computed salt to platform response
      const enhancedPlatform = {
        ...platform,
        version: appVersion,
        computedRefreshSalt: computedSalt
      };
      
      res.json(enhancedPlatform);
    } catch (error) {
      console.error('Error fetching platform configuration:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
