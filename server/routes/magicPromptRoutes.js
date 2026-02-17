import configCache from '../configCache.js';
import { recordMagicPrompt, estimateTokens } from '../usageTracker.js';
import validate from '../validators/validate.js';
import { magicPromptSchema } from '../validators/index.js';
import config from '../config.js';
import { authRequired } from '../middleware/authRequired.js';
import { simpleCompletion } from '../utils.js';
import { buildServerPath } from '../utils/basePath.js';
import logger from '../utils/logger.js';

export default function registerMagicPromptRoutes(app, deps = {}) {
  const { basePath = '' } = deps;
  app.post(
    buildServerPath('/api/magic-prompt'),
    authRequired,
    validate(magicPromptSchema),
    async (req, res) => {
      try {
        const { input, prompt, modelId, appId = 'direct' } = req.body;
        const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
        req.headers['accept-language']?.split(',')[0] || defaultLang;
        if (!input) {
          return res.status(400).json({ error: 'Missing input' });
        }

        // Get available models and default model
        const { data: models = [] } = configCache.getModels();
        const defaultModel = models.find(m => m.default)?.id;

        // Check if any models are available
        if (!models || models.length === 0) {
          return res.status(500).json({ error: 'No models available for magic prompt generation' });
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
            logger.warn(`Fallback model '${fallbackModel}' not found, using first available model`);
            selectedModelId = models[0]?.id;
          }
        }

        const systemPrompt =
          prompt || config.MAGIC_PROMPT_PROMPT || 'Improve the following prompt.';
        const messages = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: input }
        ];

        // Use simpleCompletion instead of duplicating the LLM call logic
        const result = await simpleCompletion(messages, {
          modelId: selectedModelId,
          maxTokens: 8192
        });

        const newPrompt = result.content;

        const inputTokens = result.usage?.prompt_tokens ?? estimateTokens(input);
        const outputTokens = result.usage?.completion_tokens ?? estimateTokens(newPrompt);

        const userSessionId = req.headers['x-session-id'];
        await recordMagicPrompt({
          userId: userSessionId,
          appId,
          modelId: selectedModelId,
          inputTokens,
          outputTokens
        });

        return res.json({ prompt: newPrompt });
      } catch (error) {
        logger.error('Error generating magic prompt:', error);
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );
}
