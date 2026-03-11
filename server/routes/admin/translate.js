import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { simpleCompletion } from '../../utils.js';
import { verifyApiKey } from '../../serverHelpers.js';
import { buildServerPath } from '../../utils/basePath.js';
import {
  sendInternalError,
  sendBadRequest,
  sendFailedOperationError
} from '../../utils/responseHelpers.js';

export default function registerAdminTranslateRoute(app) {
  app.post(buildServerPath('/api/admin/translate'), adminAuth, async (req, res) => {
    try {
      const { text, from = 'en', to } = req.body || {};
      if (!text || !to) {
        return sendBadRequest(res, 'Missing required fields');
      }

      let { data: models = [] } = configCache.getModels(true);
      if (!models) {
        return sendFailedOperationError(
          res,
          'load models configuration',
          new Error('models is null')
        );
      }
      const defaultModelId = models.find(m => m.default)?.id || models[0]?.id;
      const model = models.find(m => m.id === defaultModelId);
      if (!model) {
        return sendFailedOperationError(
          res,
          'find available model',
          new Error('no model available')
        );
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
      return sendInternalError(res, error, 'translate text');
    }
  });
}
