// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configCache from '../configCache.js';
import { recordMagicPromptUsage } from '../telemetry/metrics.js';
import validate from '../validators/validate.js';
import { magicPromptSchema } from '../validators/index.js';
import config from '../config.js';
import { authRequired } from '../middleware/authRequired.js';
import defaultLlmClient from '../services/loop/LLMClient.js';
import { buildServerPath } from '../utils/basePath.js';
import { ServiceError } from '../utils/ServiceError.js';
import logger from '../utils/logger.js';
import { canUserAccessResource } from '../utils/authorization.js';
import { findByIdCaseInsensitive } from '../utils/resourceLookup.js';

/** Output cap for the rewritten prompt. */
const MAGIC_PROMPT_MAX_TOKENS = 8192;

export default function registerMagicPromptRoutes(app, { llmClient = defaultLlmClient } = {}) {
  /**
   * POST /api/magic-prompt
   *
   * Rewrites a user's draft prompt with a helper model. The instruction comes
   * from the app's `features.magicPrompt` (or the platform defaults), and the
   * model must be one the caller may use. The model call goes
   * through `LLMClient` (ledger kind `utility`, purpose `magic-prompt`);
   * provider failures (`LLMError`) reach the global error handler,
   * which maps them to their status.
   */
  app.post(
    buildServerPath('/api/magic-prompt'),
    authRequired,
    validate(magicPromptSchema),
    async (req, res) => {
      const { input, modelId, appId = 'direct' } = req.body;
      if (!input) {
        throw new ServiceError('BAD_REQUEST', 'Missing input');
      }

      // Get available models and default model
      const { data: models = [] } = configCache.getModels();

      // Check if any models are available
      if (!models || models.length === 0) {
        throw new ServiceError('INTERNAL_ERROR', 'No models available');
      }

      // The instruction and the default model come from the app's own
      // configuration, never from the request body. Without an app context
      // the platform defaults apply.
      let magicConfig = {};
      if (appId && appId !== 'direct') {
        const { data: apps = [] } = configCache.getApps();
        const appConfig = findByIdCaseInsensitive(apps || [], appId);
        if (!appConfig || !canUserAccessResource(req.user, 'apps', appConfig.id)) {
          throw new ServiceError('NOT_FOUND', 'App not found');
        }
        magicConfig = appConfig.features?.magicPrompt || {};
      }

      // Only chat models can rewrite a prompt (not transcription or speech models).
      const chatModels = models.filter(m => (m.modelType || 'chat') === 'chat');
      const findModel = id => (id ? chatModels.find(m => m.id === id) : undefined);
      const mayUse = model => canUserAccessResource(req.user, 'models', model.id);

      // An explicitly requested model must be one the caller may use, whatever
      // its type; only a chat model is then used.
      const requested = modelId ? findByIdCaseInsensitive(models, modelId) : undefined;
      if (requested && !mayUse(requested)) {
        throw new ServiceError(
          'FORBIDDEN',
          `Insufficient permissions: access to model ${requested.id}`
        );
      }
      const requestedModel = requested && chatModels.includes(requested) ? requested : undefined;

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
        throw new ServiceError('FORBIDDEN', 'Insufficient permissions: access to a model');
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

      // The model call itself is recorded for usage reporting by LLMClient
      // (surface `magic`); only the OpenTelemetry counter is kept here.
      recordMagicPromptUsage(appId);

      return res.json({ prompt: newPrompt });
    }
  );
}
