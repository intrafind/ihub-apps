import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import llmClient, { isLLMError } from '../../services/loop/LLMClient.js';
import { sendLLMError } from '../../services/loop/llmHttpErrors.js';
import { buildServerPath } from '../../utils/basePath.js';
import {
  sendInternalError,
  sendBadRequest,
  sendFailedOperationError
} from '../../utils/responseHelpers.js';

export default function registerAdminTranslateRoute(app) {
  /**
   * POST /api/admin/translate
   *
   * Translates a snippet of admin-authored UI text with the platform's default
   * model (first model when none is marked default). The model call goes
   * through `LLMClient`, which resolves the API key itself — providers that
   * need no key (e.g. iAssistant) work too — and records the call in the run
   * ledger as a `utility` run.
   */
  app.post(buildServerPath('/api/admin/translate'), adminAuth, async (req, res) => {
    try {
      const { text, from = 'en', to } = req.body || {};
      if (!text || !to) {
        return sendBadRequest(res, 'Missing required fields');
      }

      const { data: models = [] } = configCache.getModels(true);
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

      const messages = [
        { role: 'system', content: 'You are a helpful translation assistant.' },
        {
          role: 'user',
          content: `Translate the following text from ${from} to ${to} and only return the translated text.`
        },
        { role: 'user', content: text }
      ];

      // `retries: 0` — an interactive admin request must not stall on a provider's Retry-After.
      const result = await llmClient.complete({
        model,
        messages,
        retries: 0,
        telemetry: { kind: 'utility', purpose: 'admin-translate', user: req.user }
      });
      res.json({ translation: result.content });
    } catch (error) {
      if (isLLMError(error)) {
        return sendLLMError(res, error, { context: 'translate text' });
      }
      return sendInternalError(res, error, 'translate text');
    }
  });
}
