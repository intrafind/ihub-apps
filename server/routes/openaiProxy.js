import { getApiKeyForModel } from '../utils.js';
import { createCompletionRequest } from '../adapters/index.js';
import { throttledFetch } from '../requestThrottler.js';
import configCache from '../configCache.js';
import { authRequired } from '../middleware/authRequired.js';
import { filterResourcesByPermissions } from '../utils/authorization.js';

export default function registerOpenAIProxyRoutes(app, { getLocalizedError } = {}) {
  const base = '/api/inference';
  app.use(`${base}/v1`, authRequired);

  app.get(`${base}/v1/models`, async (req, res) => {
    const { data: models = [] } = configCache.getModels();
    let filtered = models;
    if (req.user && req.user.permissions) {
      const allowed = req.user.permissions.models || new Set();
      filtered = filterResourcesByPermissions(models, allowed, 'models');
    }
    res.json({ object: 'list', data: filtered.map(m => ({ object: 'model', id: m.id })) });
  });

  app.post(`${base}/v1/chat/completions`, async (req, res) => {
    const {
      model: modelId,
      messages,
      stream = false,
      temperature = 0.7,
      tools = null,
      tool_choice: toolChoice,
      max_tokens: maxTokens
    } = req.body || {};

    if (!modelId || !messages) {
      const lang =
        req.headers['accept-language']?.split(',')[0] ||
        configCache.getPlatform()?.defaultLanguage ||
        'en';
      const msg = getLocalizedError
        ? await getLocalizedError('missingRequiredFields', {}, lang)
        : 'Missing required fields';
      return res.status(400).json({ error: msg });
    }

    const { data: models = [] } = configCache.getModels();
    const model = models.find(m => m.id === modelId);
    if (!model) {
      const lang =
        req.headers['accept-language']?.split(',')[0] ||
        configCache.getPlatform()?.defaultLanguage ||
        'en';
      const msg = getLocalizedError
        ? await getLocalizedError('modelNotFound', {}, lang)
        : 'Model not found';
      return res.status(404).json({ error: msg });
    }
    if (req.user && req.user.permissions) {
      const allowed = req.user.permissions.models || new Set();
      if (!allowed.has('*') && !allowed.has(modelId)) {
        const lang =
          req.headers['accept-language']?.split(',')[0] ||
          configCache.getPlatform()?.defaultLanguage ||
          'en';
        const msg = getLocalizedError
          ? await getLocalizedError('modelAccessDenied', {}, lang)
          : 'Model access denied';
        return res.status(403).json({ error: msg });
      }
    }

    const apiKey = await getApiKeyForModel(modelId);
    if (!apiKey) {
      const lang =
        req.headers['accept-language']?.split(',')[0] ||
        configCache.getPlatform()?.defaultLanguage ||
        'en';
      const msg = getLocalizedError
        ? await getLocalizedError('apiKeyNotFound', { provider: model.provider }, lang)
        : 'API key not configured';
      return res.status(500).json({ error: msg });
    }

    const request = createCompletionRequest(model, messages, apiKey, {
      stream,
      temperature,
      maxTokens,
      tools,
      toolChoice
    });

    try {
      const llmResponse = await throttledFetch(model.id, request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body)
      });

      res.status(llmResponse.status);
      for (const [key, value] of llmResponse.headers) {
        if (key.toLowerCase() === 'content-type') {
          res.setHeader(key, value);
        }
      }
      if (stream) {
        llmResponse.body.pipe(res);
      } else {
        const data = await llmResponse.text();
        res.send(data);
      }
    } catch (err) {
      console.error('OpenAI proxy error:', err);
      const lang =
        req.headers['accept-language']?.split(',')[0] ||
        configCache.getPlatform()?.defaultLanguage ||
        'en';
      const msg = getLocalizedError
        ? await getLocalizedError('internalError', {}, lang)
        : 'Internal server error';
      res.status(500).json({ error: msg });
    }
  });
}
