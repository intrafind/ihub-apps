import { loadJson } from '../configLoader.js';
import configCache from '../configCache.js';

export default function registerGeneralRoutes(app, { getLocalizedError }) {
  app.get('/api/apps', async(req, res) => {
    try {
      // Try to get apps from cache first
      let { data: apps = [], etag: appsEtag } = configCache.getApps();

      if (!apps) {
        return res.status(500).json({ error: 'Failed to load apps configuration' });
      }
      res.setHeader('ETag', appsEtag);
      res.json(apps);
    } catch (error) {
      console.error('Error fetching apps:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/apps/:appId', async(req, res) => {
    try {
      const { appId } = req.params;
      const { data: platform, etag: platformEtag } = configCache.getPlatform() || {};
      const defaultLang = platform?.defaultLanguage || 'en';
      const language = req.headers['accept-language']?.split(',')[0] || defaultLang;

      // Try to get apps from cache first
      const { data: apps, etag: appsEtag } = configCache.getApps();

      if (!apps) {
        return res.status(500).json({ error: 'Failed to load apps configuration' });
      }
      const appData = apps.find(a => a.id === appId);
      if (!appData) {
        const errorMessage = await getLocalizedError('appNotFound', {}, language);
        return res.status(404).json({ error: errorMessage });
      }
      res.json(appData);
    } catch (error) {
      console.error('Error fetching app details:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
