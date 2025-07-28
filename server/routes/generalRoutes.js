import configCache from '../configCache.js';
import {
  filterResourcesByPermissions,
  enhanceUserWithPermissions,
  isAnonymousAccessAllowed
} from '../utils/authorization.js';
import { authRequired, authOptional, appAccessRequired } from '../middleware/authRequired.js';
import crypto from 'crypto';

export default function registerGeneralRoutes(app, { getLocalizedError }) {
  app.get('/api/apps', authOptional, async (req, res) => {
    try {
      const platformConfig = req.app.get('platform') || {};
      const authConfig = platformConfig.auth || {};

      // Check if anonymous access is allowed
      if (!isAnonymousAccessAllowed(platformConfig) && (!req.user || req.user.id === 'anonymous')) {
        return res.status(401).json({
          error: 'Authentication required',
          code: 'AUTH_REQUIRED',
          message: 'You must be logged in to access this resource'
        });
      }

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
