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
import {
  sendInternalError,
  sendBadRequest,
  sendFailedOperationError
} from '../utils/responseHelpers.js';

/** Output cap for the rewritten prompt. */
const MAGIC_PROMPT_MAX_TOKENS = 8192;

export default function registerMagicPromptRoutes(app) {
  /**
   * POST /api/magic-prompt
   *
   * Rewrites a user's draft prompt with a helper model. The model call goes
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
        const { input, prompt, modelId, appId = 'direct' } = req.body;
        if (!input) {
          return sendBadRequest(res, 'Missing input');
        }

        // Get available models and default model
        const { data: models = [] } = configCache.getModels();
        const defaultModel = models.find(m => m.default)?.id;

        // Check if any models are available
        if (!models || models.length === 0) {
          return sendFailedOperationError(
            res,
            'generate magic prompt: no models available',
            new Error('No models available')
          );
        }

        // Determine the model to use with fallback chain
        let selectedModelId = modelId || config.MAGIC_PROMPT_MODEL || defaultModel;

        // Validate if the specified model exists and fallback if not
        const modelExists = models.some(m => m.id === selectedModelId);

        if (!modelExists) {
          const fallbackModel = config.MAGIC_PROMPT_MODEL || defaultModel;
          logger.warn(
            `Magic prompt model '${selectedModelId}' not found, falling back to '${fallbackModel}'`
          );
          selectedModelId = fallbackModel;

          // Double-check fallback model exists
          const fallbackExists = models.some(m => m.id === fallbackModel);
          if (!fallbackExists) {
            logger.warn('Fallback model not found, using first available model', {
              component: 'MagicPrompt',
              fallbackModel
            });
            selectedModelId = models[0]?.id;
          }
        }

        const systemPrompt =
          prompt || config.MAGIC_PROMPT_PROMPT || 'Improve the following prompt.';
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
