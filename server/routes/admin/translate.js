import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { simpleCompletion } from '../../utils.js';
import { verifyApiKey } from '../../serverHelpers.js';
import { buildServerPath } from '../../utils/basePath.js';
import logger from '../../utils/logger.js';

export default function registerAdminTranslateRoute(app) {
  app.post(buildServerPath('/api/admin/translate'), adminAuth, async (req, res) => {
    try {
      const { text, from = 'en', to } = req.body || {};
      if (!text || !to) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      let { data: models = [] } = configCache.getModels(true);
      if (!models) {
        return res.status(500).json({ error: 'Failed to load models configuration' });
      }
      const defaultModelId = models.find(m => m.default)?.id || models[0]?.id;
      const model = models.find(m => m.id === defaultModelId);
      if (!model) {
        return res.status(500).json({ error: 'No model available' });
      }

      const apiKey = await verifyApiKey(model, res);
      if (!apiKey) {
        return;
      }

      const messages = [
        { role: 'system', content: 'You are a helpful translation assistant.' },
        {
          role: 'user',
          content: `Translate the following text from ${from} to ${to} and only return the translated text.`
        },
        { role: 'user', content: text }
      ];

      const result = await simpleCompletion(messages, {
        modelId: model.id,
        apiKey: apiKey
      });
      res.json({ translation: result.content });
    } catch (error) {
      logger.error('Translation error:', error);
      res.status(500).json({ error: 'Translation failed' });
    }
  });
}
