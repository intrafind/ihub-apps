import configCache from '../configCache.js';
import { filterResourcesByPermissions } from '../utils/authorization.js';

export default function registerModelRoutes(app, { getLocalizedError }) {
  app.get('/api/models', async (req, res) => {
    try {
      // Try to get models from cache first
      let { data: models = [], etag: modelsEtag } = configCache.getModels();

      if (!models) {
        return res.status(500).json({ error: 'Failed to load models configuration' });
      }

      // Apply group-based filtering if user is authenticated
      if (req.user && req.user.permissions) {
        const allowedModels = req.user.permissions.models || new Set();
        models = filterResourcesByPermissions(models, allowedModels, 'models');
      }

      res.setHeader('ETag', modelsEtag);
      res.json(models);
    } catch (error) {
      console.error('Error fetching models:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/models/:modelId', async (req, res) => {
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
