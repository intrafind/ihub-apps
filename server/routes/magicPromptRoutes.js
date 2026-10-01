import configCache from '../configCache.js';
import { recordMagicPrompt, estimateTokens } from '../usageTracker.js';
import validate from '../validators/validate.js';
import { magicPromptSchema } from '../validators/index.js';
import config from '../config.js';
import { authRequired } from '../middleware/authRequired.js';
import llmClient, { isLLMError } from '../services/loop/LLMClient.js';
import { sendLLMError } from '../services/loop/llmHttpErrors.js';
import { buildServerPath } from '../utils/basePath.js';
import logger from '../utils/logger.js';
import { canUserAccessResource } from '../utils/authorization.js';
import { findByIdCaseInsensitive } from '../utils/resourceLookup.js';
import {
  sendInternalError,
  sendBadRequest,
  sendFailedOperationError,
  sendInsufficientPermissions,
  sendNotFound
} from '../utils/responseHelpers.js';

/** Output cap for the rewritten prompt. */
const MAGIC_PROMPT_MAX_TOKENS = 8192;

export default function registerMagicPromptRoutes(app) {
  /**
   * POST /api/magic-prompt
   *
   * Rewrites a user's draft prompt with a helper model. The instruction comes
   * from the app's `features.magicPrompt` (or the platform defaults), and the
   * model must be one the caller may use. The model call goes
   * through `LLMClient` (ledger kind `utility`, purpose `magic-prompt`);
   * provider failures are answered with the mapped status from
   * `sendLLMError` instead of a blanket 500.
   */
  app.post(
    buildServerPath('/api/magic-prompt'),
    authRequired,
    validate(magicPromptSchema),
    async (req, res) => {
      try {
        const { input, modelId, appId = 'direct' } = req.body;
        if (!input) {
          return sendBadRequest(res, 'Missing input');
        }

        // Get available models and default model
        const { data: models = [] } = configCache.getModels();

        // Check if any models are available
        if (!models || models.length === 0) {
          return sendFailedOperationError(
            res,
            'generate magic prompt: no models available',
            new Error('No models available')
          );
        }

        // The instruction and the default model come from the app's own
        // configuration, never from the request body. Without an app context
        // the platform defaults apply.
        let magicConfig = {};
        if (appId && appId !== 'direct') {
          const { data: apps = [] } = configCache.getApps();
          const appConfig = findByIdCaseInsensitive(apps || [], appId);
          if (!appConfig || !canUserAccessResource(req.user, 'apps', appConfig.id)) {
            return sendNotFound(res, 'App');
          }
          magicConfig = appConfig.features?.magicPrompt || {};
        }

        // Only chat models can rewrite a prompt (not transcription or speech models).
        const chatModels = models.filter(m => (m.modelType || 'chat') === 'chat');
        const findModel = id => (id ? chatModels.find(m => m.id === id) : undefined);
        const mayUse = model => canUserAccessResource(req.user, 'models', model.id);

        // An explicitly requested model must be one the caller may use.
        const requestedModel = findModel(modelId);
        if (requestedModel && !mayUse(requestedModel)) {
          return sendInsufficientPermissions(res, `access to model ${requestedModel.id}`);
        }

        // Fallback chain: requested model, the app's magic prompt model, the
        // MAGIC_PROMPT_MODEL setting, the default model, then any model —
        // limited to models the caller may use.
        const defaultModel = chatModels.find(m => m.default);
        const candidates = [
          requestedModel,
          findModel(magicConfig.model),
          findModel(config.MAGIC_PROMPT_MODEL),
          defaultModel,
          ...chatModels
        ];
        const selectedModel = candidates.find(model => model && mayUse(model));
        if (!selectedModel) {
          return sendInsufficientPermissions(res, 'access to a model');
        }
        if (modelId && selectedModel !== requestedModel) {
          logger.warn('Magic prompt model not found, falling back', {
            component: 'MagicPrompt',
            modelId,
            fallbackModel: selectedModel.id
          });
        }
        const selectedModelId = selectedModel.id;

        const systemPrompt =
          magicConfig.prompt || config.MAGIC_PROMPT_PROMPT || 'Improve the following prompt.';
        const messages = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: input }
        ];

        // `retries: 0` — an interactive request must not stall on a provider's Retry-After.
        const result = await llmClient.complete({
          modelId: selectedModelId,
          messages,
          options: { maxTokens: MAGIC_PROMPT_MAX_TOKENS },
          retries: 0,
          telemetry: {
            kind: 'utility',
            purpose: 'magic-prompt',
            user: req.user,
            refs: { appId }
          }
        });

        const newPrompt = result.content;

        // Prefer provider-reported usage; fall back to an estimate when the
        // provider sent none (or zero) so accounting never records 0/0.
        const inputTokens = result.usage?.promptTokens || estimateTokens(input);
        const outputTokens = result.usage?.completionTokens || estimateTokens(newPrompt);

        const userSessionId = req.headers['x-session-id'];
        await recordMagicPrompt({
          userId: userSessionId,
          appId,
          modelId: selectedModelId,
          inputTokens,
          outputTokens,
          user: req.user
        });

        return res.json({ prompt: newPrompt });
      } catch (error) {
        if (isLLMError(error)) {
          return sendLLMError(res, error, { context: 'generate magic prompt' });
        }
        return sendInternalError(res, error, 'generate magic prompt');
      }
    }
  );
}
