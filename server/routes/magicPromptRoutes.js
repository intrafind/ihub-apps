import configCache from '../configCache.js';
import { recordMagicPrompt, estimateTokens } from '../usageTracker.js';
import validate from '../validators/validate.js';
import { magicPromptSchema } from '../validators/index.js';
import config from '../config.js';
import { authRequired } from '../middleware/authRequired.js';
import { simpleCompletion } from '../utils.js';

export default function registerMagicPromptRoutes(app) {
  app.post('/api/magic-prompt', authRequired, validate(magicPromptSchema), async (req, res) => {
    try {
      const { input, prompt, modelId, appId = 'direct' } = req.body;
      const defaultLang = configCache.getPlatform()?.defaultLanguage || 'en';
      req.headers['accept-language']?.split(',')[0] || defaultLang;
      if (!input) {
        return res.status(400).json({ error: 'Missing input' });
      }

      const selectedModelId = modelId || config.MAGIC_PROMPT_MODEL || 'gpt-3.5-turbo';
      const systemPrompt = prompt || config.MAGIC_PROMPT_PROMPT || 'Improve the following prompt.';
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
      console.error('Error generating magic prompt:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
}
