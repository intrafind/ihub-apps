import configCache from '../configCache.js';
import { filterResourcesByPermissions } from '../utils/authorization.js';

export default function registerGeneralRoutes(app, { getLocalizedError }) {
  app.get('/api/apps', async (req, res) => {
    try {
      // Try to get apps from cache first
      let { data: apps = [], etag: appsEtag } = configCache.getApps();

      if (!apps) {
        return res.status(500).json({ error: 'Failed to load apps configuration' });
      }

      // Apply group-based filtering if user is authenticated
      if (req.user && req.user.permissions) {
        const allowedApps = req.user.permissions.apps || new Set();
        apps = filterResourcesByPermissions(apps, allowedApps, 'apps');
      }

      res.setHeader('ETag', appsEtag);
      res.json(apps);
    } catch (error) {
      console.error('Error fetching apps:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/apps/:appId', async (req, res) => {
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
