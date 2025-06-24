import { loadJson } from '../../configLoader.js';

export default function registerDataRoutes(app) {
  app.get('/api/styles', async (req, res) => {
    try {
      const styles = await loadJson('config/styles.json');
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
      const prompts = await loadJson('config/prompts.json');
      if (!prompts) {
        return res.status(500).json({ error: 'Failed to load prompts configuration' });
      }
      res.json(prompts);
    } catch (error) {
      console.error('Error fetching prompts:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/translations/:lang', async (req, res) => {
    try {
      let { lang } = req.params;
      if (!/^[a-zA-Z0-9-]{1,10}$/.test(lang)) {
        console.warn(`Suspicious language parameter received: ${lang}`);
        lang = 'en';
      }
      const supportedLanguages = ['en', 'de'];
      const baseLanguage = lang.split('-')[0].toLowerCase();
      if (!supportedLanguages.includes(lang) && supportedLanguages.includes(baseLanguage)) {
        console.log(`Language '${lang}' not directly supported, falling back to '${baseLanguage}'`);
        lang = baseLanguage;
      }
      if (!supportedLanguages.includes(lang)) {
        console.log(`Language '${lang}' not supported, falling back to default language 'en'`);
        lang = 'en';
      }
      const translations = await loadJson(`locales/${lang}.json`);
      if (!translations) {
        console.error(`Failed to load translations for language: ${lang}`);
        if (lang !== 'en') {
          const enTranslations = await loadJson('locales/en.json');
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
        const enTranslations = await loadJson('locales/en.json');
        if (enTranslations) {
          return res.json(enTranslations);
        }
      } catch (fallbackError) {
        console.error('Failed to load fallback translations:', fallbackError);
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/ui', async (req, res) => {
    try {
      const uiConfig = await loadJson('config/ui.json');
      if (!uiConfig) {
        return res.status(500).json({ error: 'Failed to load UI configuration' });
      }
      res.json(uiConfig);
    } catch (error) {
      console.error('Error fetching UI configuration:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
