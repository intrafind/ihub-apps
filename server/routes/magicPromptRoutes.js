import { loadJson } from '../configLoader.js';
import configCache from '../configCache.js';
import { createCompletionRequest } from '../adapters/index.js';
import { recordMagicPrompt, estimateTokens } from '../usageTracker.js';
import validate from '../validators/validate.js';
import { magicPromptSchema } from '../validators/index.js';
import config from '../config.js';

// BIG FAT TODO reuse methods like simpleCompletion and extract the adapter specifics
export default function registerMagicPromptRoutes(app, { verifyApiKey, DEFAULT_TIMEOUT }) {
  app.post('/api/magic-prompt', validate(magicPromptSchema), async (req, res) => {
    try {
      const { input, prompt, modelId, appId = 'direct' } = req.body;
      const language = req.headers['accept-language']?.split(',')[0] || 'en';
      if (!input) {
        return res.status(400).json({ error: 'Missing input' });
      }
      
      // Try to get models from cache first
      let models = configCache.getModels();
      
      if (!models) {
        return res.status(500).json({ error: 'Failed to load models configuration' });
      }
      const selectedModelId = modelId || config.MAGIC_PROMPT_MODEL || 'gpt-3.5-turbo';
      const model = models.find(m => m.id === selectedModelId);
      if (!model) {
        return res.status(400).json({ error: 'Model not found' });
      }
      const apiKey = await verifyApiKey(model, res, null, language);
      if (!apiKey) {
        return res.status(500).json({ error: `API key not found for model: ${model.id}` });
      }
      const systemPrompt = prompt || config.MAGIC_PROMPT_PROMPT || 'Improve the following prompt.';
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: input }
      ];
      const request = createCompletionRequest(model, messages, apiKey, { stream: false });
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Request timed out after ${DEFAULT_TIMEOUT/1000} seconds`)), DEFAULT_TIMEOUT);
      });
      const responsePromise = fetch(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body) });
      const llmResponse = await Promise.race([responsePromise, timeoutPromise]);
      clearTimeout(timeoutId);
      if (!llmResponse.ok) {
        const errorBody = await llmResponse.text();
        return res.status(llmResponse.status).json({ error: `LLM API request failed with status ${llmResponse.status}`, details: errorBody });
      }
      const responseData = await llmResponse.json();
      let newPrompt = '';
      if (model.provider === 'openai' || model.provider === 'mistral') {
        newPrompt = responseData.choices?.[0]?.message?.content?.trim() || '';
      } else if (model.provider === 'google') {
        const parts = responseData.candidates?.[0]?.content?.parts || [];
        newPrompt = parts.map(p => p.text || '').join('').trim();
      } else if (model.provider === 'anthropic') {
        const content = responseData.content;
        if (Array.isArray(content)) {
          newPrompt = content.map(c => (typeof c === 'string' ? c : c.text || '')).join('').trim();
        }
      }
      const inputTokens = responseData.usage?.prompt_tokens ?? estimateTokens(input);
      const outputTokens = responseData.usage?.completion_tokens ?? estimateTokens(newPrompt);
      const userSessionId = req.headers['x-session-id'];
      await recordMagicPrompt({ userId: userSessionId, appId, modelId: model.id, inputTokens, outputTokens });
      return res.json({ prompt: newPrompt });
    } catch (error) {
      console.error('Error generating magic prompt:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });
}
