import { loadJson, loadText } from '../configLoader.js';
import configCache from '../configCache.js';

export default function registerPageRoutes(app) {
  app.get('/api/pages/:pageId', async (req, res) => {
    const { pageId } = req.params;
    const lang = req.query.lang || 'en';
    try {
      // Try to get UI config from cache first
      let { etag: uiConfigEtag, data: uiConfig } = configCache.getUI();

      if (!uiConfig || !uiConfig.pages || !uiConfig.pages[pageId]) {
        return res.status(404).json({ error: 'Page not found' });
      }
      const pageConfig = uiConfig.pages[pageId];
      const langFilePath = pageConfig.filePath[lang] || pageConfig.filePath['en'];
      if (!langFilePath) {
        return res
          .status(404)
          .json({ error: 'Page content not available for the requested language' });
      }
      const content = await loadText(langFilePath);
      if (!content) {
        return res.status(404).json({ error: 'Page content file not found' });
      }
      res.json({ id: pageId, title: pageConfig.title[lang] || pageConfig.title['en'], content });
    } catch (error) {
      console.error('Error fetching page content:', error);
      res.status(500).json({ error: 'Failed to fetch page content' });
    }
  });
}
