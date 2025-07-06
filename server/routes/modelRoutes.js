import { loadJson } from '../configLoader.js';
import configCache from '../configCache.js';

export default function registerModelRoutes(app, { getLocalizedError }) {
  app.get('/api/models', async (req, res) => {
    try {
      // Try to get models from cache first
      let models = configCache.getModels();
      
      if (!models) {
        return res.status(500).json({ error: 'Failed to load models configuration' });
      }
      res.json(models);
    } catch (error) {
      console.error('Error fetching models:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/api/models/:modelId', async (req, res) => {
    try {
      const { modelId } = req.params;
      const language = req.headers['accept-language']?.split(',')[0] || 'en';
      
      // Try to get models from cache first
      let models = configCache.getModels();
      
      if (!models) {
        return res.status(500).json({ error: 'Failed to load models configuration' });
      }
      const model = models.find(m => m.id === modelId);
      if (!model) {
        const errorMessage = await getLocalizedError('modelNotFound', {}, language);
        return res.status(404).json({ error: errorMessage });
      }
      res.json(model);
    } catch (error) {
      console.error('Error fetching model details:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
