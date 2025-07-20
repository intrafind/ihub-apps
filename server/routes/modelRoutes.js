import configCache from '../configCache.js';
import {
  filterResourcesByPermissions,
  isAnonymousAccessAllowed,
  enhanceUserWithPermissions
} from '../utils/authorization.js';
import { authRequired, authOptional, modelAccessRequired } from '../middleware/authRequired.js';

export default function registerModelRoutes(app, { getLocalizedError }) {
  app.get('/api/models', authOptional, async (req, res) => {
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

      // Try to get models from cache first
      let { data: models = [], etag: modelsEtag } = configCache.getModels();

      if (!models) {
        return res.status(500).json({ error: 'Failed to load models configuration' });
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
        const allowedModels = req.user.permissions.models || new Set();
        models = filterResourcesByPermissions(models, allowedModels, 'models');
      } else if (isAnonymousAccessAllowed(platformConfig)) {
        // For anonymous users, filter to only anonymous-allowed models
        const allowedModels = new Set(['gpt-4']); // Default anonymous models
        models = filterResourcesByPermissions(models, allowedModels, 'models');
      }

      res.setHeader('ETag', modelsEtag);
      res.json(models);
    } catch (error) {
      console.error('Error fetching models:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/models/:modelId', authRequired, modelAccessRequired, async (req, res) => {
    try {
      const { modelId } = req.params;
      const platform = configCache.getPlatform() || {};
      const defaultLang = platform?.defaultLanguage || 'en';
      const language = req.headers['accept-language']?.split(',')[0] || defaultLang;

      // Try to get models from cache first
      const { data: models, etag: modelsEtag } = configCache.getModels();

      if (!models) {
        return res.status(500).json({ error: 'Failed to load models configuration' });
      }
      const model = models.find(m => m.id === modelId);
      if (!model) {
        const errorMessage = await getLocalizedError('modelNotFound', {}, language);
        return res.status(404).json({ error: errorMessage });
      }

      // Check if user has permission to access this model
      if (req.user && req.user.permissions) {
        const allowedModels = req.user.permissions.models || new Set();
        if (!allowedModels.has('*') && !allowedModels.has(modelId)) {
          const errorMessage = await getLocalizedError('modelNotFound', {}, language);
          return res.status(404).json({ error: errorMessage });
        }
      }

      res.json(model);
    } catch (error) {
      console.error('Error fetching model details:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
