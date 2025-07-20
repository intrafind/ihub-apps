import configCache from '../configCache.js';
import {
  filterResourcesByPermissions,
  enhanceUserWithPermissions
} from '../utils/authorization.js';
import { authRequired, authOptional, appAccessRequired } from '../middleware/authRequired.js';
import crypto from 'crypto';

export default function registerGeneralRoutes(app, { getLocalizedError }) {
  app.get('/api/apps', authOptional, async (req, res) => {
    try {
      const platformConfig = req.app.get('platform') || {};
      const authConfig = platformConfig.auth || {};

      // Check if anonymous access is allowed
      if (!authConfig.allowAnonymous && (!req.user || req.user.id === 'anonymous')) {
        return res.status(401).json({
          error: 'Authentication required',
          code: 'AUTH_REQUIRED',
          message: 'You must be logged in to access this resource'
        });
      }

      // Try to get apps from cache first
      let { data: apps = [], etag: appsEtag } = configCache.getApps();

      if (!apps) {
        return res.status(500).json({ error: 'Failed to load apps configuration' });
      }

      // Generate user-specific ETag to prevent cache poisoning between users with different permissions
      let userSpecificEtag = appsEtag;
      let allowedApps = new Set();

      // Force permission enhancement if not already done
      if (req.user && !req.user.permissions) {
        const platformConfig = req.app.get('platform') || {};
        const authConfig = platformConfig.auth || {};
        req.user = enhanceUserWithPermissions(req.user, authConfig);
      }

      // Apply group-based filtering if user is authenticated
      if (req.user && req.user.permissions) {
        allowedApps = req.user.permissions.apps || new Set();
        apps = filterResourcesByPermissions(apps, allowedApps, 'apps');
      } else if (authConfig.allowAnonymous) {
        // For anonymous users, filter to only anonymous-allowed apps
        allowedApps = new Set(['chat']); // Match group permissions for anonymous
        apps = filterResourcesByPermissions(apps, allowedApps, 'apps');
      }

      // Create ETag based on the actual filtered apps content
      // This ensures users with the same permissions share cache, but different permissions get different ETags
      const originalAppsCount = configCache.getApps().data?.length || 0;
      if (apps.length < originalAppsCount) {
        // Apps were filtered - create content-based ETag from filtered app IDs
        const appIds = apps.map(app => app.id).sort();
        const contentHash = crypto
          .createHash('md5')
          .update(JSON.stringify(appIds))
          .digest('hex')
          .substring(0, 8);

        userSpecificEtag = `${appsEtag}-${contentHash}`;
      }
      // If apps.length === originalAppsCount, user sees all apps, use original ETag

      res.setHeader('ETag', userSpecificEtag);
      res.json(apps);
    } catch (error) {
      console.error('Error fetching apps:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

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
