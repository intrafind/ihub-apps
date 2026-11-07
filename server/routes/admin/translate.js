// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import configCache from '../../configCache.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import llmClient from '../../services/loop/LLMClient.js';
import { buildServerPath } from '../../utils/basePath.js';
import { ServiceError } from '../../utils/ServiceError.js';

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
    const { text, from = 'en', to } = req.body || {};
    if (!text || !to) {
      throw new ServiceError('BAD_REQUEST', 'Missing required fields');
    }

    const { data: models = [] } = configCache.getModels(true);
    if (!models) {
      throw new Error('Models configuration could not be loaded');
    }
    const defaultModelId = models.find(m => m.default)?.id || models[0]?.id;
    const model = models.find(m => m.id === defaultModelId);
    if (!model) {
      throw new Error('No model is available for translation');
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
  });
}
